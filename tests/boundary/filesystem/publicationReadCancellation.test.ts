import { createHash } from "node:crypto";
import { access, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../../../src/artifacts/ArtifactFileOperation.js";
import { readArtifactFileChunks } from "../../../src/artifacts/readArtifactFileChunks.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { SafeOutputSourceFailure } from "../../../src/artifacts/SafeOutputSourceFailure.js";
import { FirmwareFileAccess } from "../../../src/firmware/FirmwareFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(
  (["direct", "firmware"] as const).flatMap((route) =>
    (["failure", "eof", "bytes"] as const).map((outcome) => ({
      route,
      outcome,
    })),
  ),
)(
  "preserves the pending read outcome after publication cancellation: %j",
  async ({ route, outcome }) => {
    const root = await createTestTempDirectory("rea-publication-read-cancel-");
    const input = join(root, "input"),
      output = join(root, "output");
    await writeFile(input, "owned");
    const probe = await open(input, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const tree = await SafeOutputTree.create(output);
    const resources = new ArtifactResourceScope();
    const files = new FirmwareFileAccess();
    const controller = new AbortController();
    const cancellation = new Error("controlled cancellation during read");
    const readFailure = new Error("controlled pending descriptor read failure");
    const read = vi.spyOn(prototype, "read").mockImplementationOnce(() => {
      controller.abort(cancellation);
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          if (outcome === "failure") reject(readFailure);
          else
            resolve({
              bytesRead: outcome === "eof" ? 0 : 5,
              buffer: Buffer.from("owned"),
            });
        });
      });
    });
    const expected = {
      bytes: 5,
      sha256: createHash("sha256").update("owned").digest("hex"),
    };
    try {
      const publication =
        route === "direct"
          ? withArtifactRegularFile(
              input,
              resources,
              controller.signal,
              ({ handle }) =>
                tree.write(
                  "file",
                  readArtifactFileChunks(handle, { signal: controller.signal }),
                  expected,
                  controller.signal,
                ),
            )
          : files.publish(
              {
                relativePath: "file",
                path: input,
                size: 5,
                kind: "file",
                linkTarget: null,
              },
              expected.sha256,
              tree,
              controller.signal,
            );
      if (outcome === "failure")
        await expect(publication).rejects.toBe(readFailure);
      else
        await expect(publication).rejects.toMatchObject({
          reason: "cancelled",
          cause: cancellation,
        });
      expect(read).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
      await files.close();
      await resources.close();
      await tree.rollback();
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("bounds a pending read that never settles and retains its unfinished destruction", async () => {
  const root = await createTestTempDirectory("rea-publication-stalled-read-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  const controller = new AbortController();
  let finishDestroy: ((error: Error | null) => void) | undefined;
  const source = new Readable({
    read() {
      controller.abort(new Error("cancel stalled read"));
    },
    destroy(_error, callback) {
      finishDestroy = callback;
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      tree
        .write(
          "file",
          source,
          {
            bytes: 5,
            sha256: createHash("sha256").update("owned").digest("hex"),
          },
          controller.signal,
        )
        .catch((cause: unknown) => cause),
      new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), 4_000);
      }),
    ]);
    expect(result).toBeInstanceOf(SafeOutputSourceFailure);
    expect(result).toMatchObject({ reason: "cancelled" });
    expect(source.destroyed).toBe(true);
    expect(source.closed).toBe(false);
    const [unsettled] = (result as SafeOutputSourceFailure).sourceFailures;
    const [lease] = (unsettled as ArtifactReaderFailure).cleanupLeases ?? [];
    expect(lease).toBeDefined();
    await expect(lease!.release()).rejects.toMatchObject({ reason: "io" });
    finishDestroy?.(null);
    await expect(lease!.release()).resolves.toBeUndefined();
    expect(source.closed).toBe(true);
  } finally {
    clearTimeout(timer);
    finishDestroy?.(null);
    await tree.rollback();
  }
});
