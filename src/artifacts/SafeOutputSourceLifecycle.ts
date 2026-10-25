import type { Readable } from "node:stream";
import { setImmediate, setTimeout } from "node:timers/promises";
import { AnalysisCleanupLease } from "./AnalysisCleanupLease.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

// Pending reads and input destruction each get bounded cancellation grace.
// Cancellation alone proves neither that a read succeeded nor a source closed.
const SOURCE_CANCELLATION_GRACE_MS = 1_000;
const SOURCE_CLOSURE_POLL_MS = 10;

/**
 * Yield chunks until the source ends or cancellation grace expires. A pending
 * read can still fail after cancellation; let its producer report that outcome.
 */
export async function* readSourceChunks(
  source: Readable,
  signal: AbortSignal | undefined,
): AsyncGenerator<unknown, void, undefined> {
  // The write owner joins destruction and records its failures on early exit.
  const chunks = source.iterator({ destroyOnReturn: false });
  let abandoned = false;
  try {
    while (true) {
      const next = await settleReadAfterCancellation(chunks.next(), signal);
      if (next === undefined) {
        abandoned = true;
        return;
      }
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    // Returning an iterator with a pending read would queue behind that read.
    if (!abandoned) await chunks.return?.();
  }
}

/** Prefer the pending read's outcome, but bound an unresponsive producer. */
const settleReadAfterCancellation = <T>(
  read: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> => {
  if (signal === undefined) return read;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      timer = globalThis.setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, SOURCE_CANCELLATION_GRACE_MS);
    };
    // An abandoned read still settles here; its source error has an owner.
    void read.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * Join started destruction, including silent auto-destroy after normal end.
 * A destruction that outlives cancellation is returned as an owned failure.
 */
export const settleSourceDestruction = async (
  source: Readable,
  signal: AbortSignal | undefined,
  resource: string,
): Promise<ArtifactReaderFailure | undefined> => {
  // Let queued end/destroy notifications run before observing the resource state.
  // A completed readable side need not destroy an open duplex writable side.
  await setImmediate();
  let cancelledAt: number | undefined;
  while (source.destroyed && !source.closed) {
    if (signal?.aborted === true) {
      cancelledAt ??= performance.now();
      if (performance.now() - cancelledAt >= SOURCE_CANCELLATION_GRACE_MS)
        return retainUnsettledSource(source, resource, signal.reason);
    }
    await setTimeout(SOURCE_CLOSURE_POLL_MS);
  }
  return undefined;
};

/** Retain the source until closure is observed without a late destroy error. */
const retainUnsettledSource = (
  source: Readable,
  resource: string,
  reason: unknown,
): ArtifactReaderFailure => {
  let late: { readonly cause: unknown } | undefined;
  const observe = (cause: unknown): void => {
    late ??= { cause };
  };
  // A late destroy error must not escape once the write stops waiting for it.
  source.on("error", observe);
  // Release confirms closure without waiting; an unsettled retry stays failed.
  const lease = new AnalysisCleanupLease(async () => {
    // Closure is recorded before its queued error notification runs.
    await setImmediate();
    if (!source.closed)
      throw new ArtifactReaderFailure(
        "io",
        `Input stream destruction has not settled: ${resource}`,
      );
    source.off("error", observe);
    if (late !== undefined) throw late.cause;
  }, [resource]);
  // A failed release leaves the lease, and every error bound to it, unresolved.
  void observeClosure(source)
    .then(() => lease.release())
    .catch(() => undefined);
  const message = `Input stream destruction did not settle after cancellation: ${resource}`;
  return new ArtifactReaderFailure("cancelled", message, {
    cause: reason,
    cleanup: { reason: message, resources: [resource] },
    cleanupLeases: [lease],
  });
};

/**
 * Wake on close, or poll a silent source, without keeping the process alive.
 * Each wait settles and is released, so a source that never closes retains
 * only one pending wait and one close listener.
 */
const observeClosure = async (source: Readable): Promise<void> => {
  let wake: (() => void) | undefined;
  const onClose = (): void => wake?.();
  source.once("close", onClose);
  try {
    while (!source.closed)
      await new Promise<void>((resolve) => {
        const timer = globalThis.setTimeout(resolve, SOURCE_CLOSURE_POLL_MS);
        timer.unref();
        wake = () => {
          globalThis.clearTimeout(timer);
          resolve();
        };
      });
  } finally {
    wake = undefined;
    source.off("close", onClose);
  }
};
