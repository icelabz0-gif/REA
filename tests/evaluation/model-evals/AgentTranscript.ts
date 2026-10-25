import { visit } from "jsonc-parser";

import { canonicalJson } from "../../../src/domain/comparisonSemantics.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";

/** One MCP invocation observed in an agent client transcript, parsed once at the client boundary. */
export interface AgentToolCall {
  readonly id: string | null;
  readonly server: string | null;
  readonly tool: string;
  readonly arguments: JsonValue;
  /** The client reported a completed call with one retained, consistent MCP result. */
  readonly delivered: boolean;
  /** The client, the MCP result, or REA's own error record reported a failure. */
  readonly error: boolean;
  /** REA's error code when exactly one unambiguous error record was retained. */
  readonly errorCode: string | null;
  /**
   * Content of a successful, consistently reported result: its structured
   * content, or one complete JSON text block without duplicate members.
   * Anything else leaves the content undefined rather than reinterpreted.
   */
  readonly resultContent: unknown;
}

/** Client-reported model token usage. Input includes cached input. */
export interface AgentTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** A client-neutral agent transcript produced once at the client boundary. */
export interface AgentTranscript {
  readonly calls: readonly AgentToolCall[];
  readonly finalMessage: string;
  readonly usage: AgentTokenUsage;
  /** Terminal failures the client itself reported, such as refused permission requests. */
  readonly clientFailures: readonly string[];
}

/** Agent clients whose transcripts REA evaluation can parse. */
export type AgentClient = "codex" | "claude-code" | "gemini-cli";

/** One closed JSON text; duplicate members are reported, not folded. */
export interface TranscriptJson {
  readonly value: unknown;
  readonly hasDuplicateMembers: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

/** Object entries of an untrusted transcript array; other values are ignored. */
const records = (values: readonly unknown[]): Record<string, unknown>[] =>
  values.filter(isRecord);

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const absent = (value: unknown): boolean =>
  value === undefined || value === null;

const sameValue = (left: unknown, right: unknown): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    canonicalJson(left) === canonicalJson(right));

/** Result aliases may be null on either side; identity aliases may not. */
const consistentAliases = (
  value: Record<string, unknown>,
  left: string,
  right: string,
): boolean =>
  absent(value[left]) ||
  absent(value[right]) ||
  sameValue(value[left], value[right]);

const consistentFields = (
  value: Record<string, unknown>,
  left: string,
  right: string,
): boolean =>
  value[left] === undefined ||
  value[right] === undefined ||
  sameValue(value[left], value[right]);

/**
 * Parse one complete JSON text. Syntax and nesting failures are malformed
 * transcript input; duplicate members are kept separate from syntax so a
 * failure can be observed without choosing one contradictory code or
 * authenticating ambiguous Evidence.
 */
export const parseTranscriptJson = (
  text: string,
): TranscriptJson | undefined => {
  const objects: Set<string>[] = [];
  let invalid = false;
  let hasDuplicateMembers = false;
  try {
    visit(
      text,
      {
        onObjectBegin: () => {
          objects.push(new Set());
        },
        onObjectProperty: (key) => {
          const keys = objects.at(-1);
          if (keys === undefined) invalid = true;
          else if (keys.has(key)) hasDuplicateMembers = true;
          keys?.add(key);
        },
        onObjectEnd: () => {
          objects.pop();
        },
        onError: () => {
          invalid = true;
        },
      },
      {
        disallowComments: true,
        allowTrailingComma: false,
        allowEmptyContent: false,
      },
    );
    if (invalid) return undefined;
    return { value: JSON.parse(text) as unknown, hasDuplicateMembers };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError)
      return undefined;
    throw error;
  }
};

/** A single complete MCP text block; previews, prose lists, and replacements are not results. */
const singleTextBlock = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = record(content[0]);
  return block?.type === "text" && typeof block.text === "string"
    ? block.text
    : undefined;
};

const parsedTextBlock = (content: unknown): TranscriptJson | undefined => {
  const block = singleTextBlock(content);
  return block === undefined ? undefined : parseTranscriptJson(block);
};

interface McpResultFacts {
  /** The client retained a result record at all. */
  readonly retained: boolean;
  readonly failed: boolean;
  readonly errorCode: string | null;
  readonly content: unknown;
}

/**
 * Read one raw MCP `CallToolResult` as the client retained it. Failure,
 * diagnostic certainty, and successful content are derived once here;
 * consumers do not reinterpret the raw record.
 */
const mcpResultFacts = (
  value: unknown,
  clientFailed: boolean,
  clientError: unknown,
): McpResultFacts => {
  const result = record(value);
  const structuredConsistent =
    result === undefined ||
    consistentAliases(result, "structuredContent", "structured_content");
  const structured = record(
    result?.structured_content ?? result?.structuredContent,
  );
  const own = record(structured?.error ?? result?.error);
  // Only a complete single JSON block can supply a missing structured result.
  const text =
    own === undefined && structured === undefined
      ? parsedTextBlock(result?.content)
      : undefined;
  const textError = record(record(text?.value)?.error);
  // REA's own record is preferred over the client's generic wrapper around it.
  const error = own ?? textError ?? record(clientError);
  const failed =
    clientFailed ||
    !absent(clientError) ||
    result?.isError === true ||
    structured?.error !== undefined ||
    error !== undefined;
  // A code is certain only from a record that cannot have folded duplicates.
  const certain = error !== textError || text?.hasDuplicateMembers === false;
  const errorCode =
    certain && typeof error?.code === "string" && error.code.length > 0
      ? error.code
      : null;
  const content =
    !failed && structuredConsistent && result !== undefined
      ? (result.structuredContent ??
        result.structured_content ??
        (text?.hasDuplicateMembers === false ? text.value : undefined))
      : undefined;
  return { retained: result !== undefined, failed, errorCode, content };
};

const sameRequestIdentity = (
  left: AgentToolCall,
  right: AgentToolCall,
): boolean =>
  left.server === right.server &&
  left.tool === right.tool &&
  sameValue(left.arguments, right.arguments);

const sameReport = (left: AgentToolCall, right: AgentToolCall): boolean =>
  left.delivered === right.delivered &&
  left.error === right.error &&
  left.errorCode === right.errorCode &&
  sameValue(left.resultContent, right.resultContent);

/**
 * Clients may report one call more than once. The first report is retained;
 * conflicting reports of one call cannot establish which result was delivered.
 */
const uniqueCalls = (calls: readonly AgentToolCall[]): AgentToolCall[] => {
  const unique: AgentToolCall[] = [];
  const identified = new Map<string, number>();
  for (const call of calls) {
    // Without an opaque client ID, equal requests may be separate retries;
    // preserve each report instead of inventing a shared identity.
    if (call.id === null) {
      unique.push(call);
      continue;
    }
    const previousIndex = identified.get(call.id);
    const previous =
      previousIndex === undefined ? undefined : unique[previousIndex];
    if (previousIndex === undefined || previous === undefined) {
      identified.set(call.id, unique.length);
      unique.push(call);
    } else if (
      !sameRequestIdentity(previous, call) ||
      !sameReport(previous, call)
    )
      unique[previousIndex] = {
        ...previous,
        delivered: false,
        resultContent: undefined,
      };
  }
  return unique;
};

/** Retain the first report and preserve uncertainty if the same call later conflicts. */
const retainResult = <T>(
  results: Map<string, T>,
  conflicts: Set<string>,
  id: string,
  value: T,
): void => {
  const previous = results.get(id);
  if (previous === undefined) results.set(id, value);
  else if (!sameValue(previous, value)) conflicts.add(id);
};

const NO_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

const codexItem = (
  event: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (event.type === "item.completed") return record(event.item);
  return event.type === "mcp_tool_call" ? event : undefined;
};

const codexCall = (
  event: Record<string, unknown>,
): AgentToolCall | undefined => {
  const item = codexItem(event);
  if (item?.type !== "mcp_tool_call") return undefined;
  const terminal = item.status === "completed" || item.status === "failed";
  if (
    event.type === "item.completed"
      ? item.status !== undefined && !terminal
      : !terminal
  )
    return undefined;
  const identityConsistent =
    consistentFields(item, "server", "server_name") &&
    consistentFields(item, "tool", "name") &&
    consistentFields(item, "arguments", "input");
  if (!identityConsistent) return undefined;
  const server = item.server ?? item.server_name;
  const tool = textValue(item.tool) ?? textValue(item.name);
  if (
    tool === undefined ||
    ((item.server !== undefined || item.server_name !== undefined) &&
      typeof server !== "string")
  )
    return undefined;
  const argumentsValue = jsonValueSchema.safeParse(
    item.arguments !== undefined
      ? item.arguments
      : item.input !== undefined
        ? item.input
        : {},
  );
  if (!argumentsValue.success) return undefined;
  const resultConsistent = consistentAliases(item, "result", "output");
  const clientFailed = item.status === "failed" || !absent(item.error);
  const facts = mcpResultFacts(
    item.result ?? item.output,
    clientFailed,
    item.error,
  );
  // A bare streaming item has no completion until it reports one. Completion
  // alone is routing; delivery also needs the result the client retained.
  const completed =
    item.status === "completed" ||
    (event.type === "item.completed" && item.status === undefined);
  const delivered =
    completed && !clientFailed && resultConsistent && facts.retained;
  return {
    id: textValue(item.id) ?? null,
    server: textValue(server) ?? null,
    tool,
    arguments: argumentsValue.data,
    delivered,
    error: facts.failed,
    errorCode: facts.errorCode,
    resultContent: delivered ? facts.content : undefined,
  };
};

const codexAgentText = (value: unknown): string | undefined => {
  const item = record(value);
  if (item?.type !== "agent_message") return undefined;
  const direct = textValue(item.text) ?? textValue(item.message);
  if (direct !== undefined) return direct;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content.flatMap((part) => {
    const text = textValue(record(part)?.text);
    return text === undefined ? [] : [text];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
};

/** Codex reports cumulative turn usage; cached input is part of input. */
const codexUsage = (
  previous: AgentTokenUsage,
  event: Record<string, unknown>,
): AgentTokenUsage => {
  if (event.type !== "turn.completed") return previous;
  const usage = record(event.usage);
  return {
    inputTokens: Math.max(
      previous.inputTokens,
      numberValue(usage?.input_tokens),
    ),
    cachedInputTokens: Math.max(
      previous.cachedInputTokens,
      numberValue(usage?.cached_input_tokens),
    ),
    outputTokens: Math.max(
      previous.outputTokens,
      numberValue(usage?.output_tokens),
    ),
  };
};

/** Parse `codex exec --json` events. */
export const parseCodexEvents = (
  events: readonly unknown[],
): AgentTranscript => {
  const calls: AgentToolCall[] = [];
  const messages: string[] = [];
  let usage = NO_USAGE;
  for (const event of records(events)) {
    const call = codexCall(event);
    if (call !== undefined) calls.push(call);
    const message =
      event.type === "item.completed" ? codexAgentText(event.item) : undefined;
    if (message !== undefined) messages.push(message);
    usage = codexUsage(usage, event);
  }
  return {
    calls: uniqueCalls(calls),
    finalMessage: messages.at(-1) ?? "",
    usage,
    clientFailures: [],
  };
};

interface McpRequest {
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly arguments: JsonValue;
}

/** Split a client-qualified MCP tool name with the client's own grammar. */
const mcpRequest = (
  pattern: RegExp,
  id: unknown,
  name: unknown,
  arguments_: unknown,
): McpRequest | undefined => {
  const callId = textValue(id);
  const match = pattern.exec(textValue(name) ?? "");
  const server = match?.[1];
  const tool = match?.[2];
  const parsedArguments = jsonValueSchema.safeParse(arguments_ ?? {});
  return callId === undefined ||
    server === undefined ||
    tool === undefined ||
    !parsedArguments.success
    ? undefined
    : { id: callId, server, tool, arguments: parsedArguments.data };
};

/** Claude Code names MCP tools `mcp__<server>__<tool>`. */
const CLAUDE_MCP_NAME = /^mcp__(.+?)__(.+)$/u;

interface ClaudeReport {
  readonly isError: boolean;
  readonly raw: unknown;
}

interface ClaudeState {
  readonly conflicts: Set<string>;
  readonly requests: McpRequest[];
  readonly results: Map<string, ClaudeReport>;
  readonly messages: string[];
  readonly clientFailures: string[];
  resultText: string | undefined;
  usage: AgentTokenUsage;
}

const contentBlocks = (
  event: Record<string, unknown>,
): Record<string, unknown>[] => {
  const content = record(event.message)?.content;
  return Array.isArray(content) ? records(content) : [];
};

const consumeClaudeAssistant = (
  state: ClaudeState,
  event: Record<string, unknown>,
): void => {
  const texts: string[] = [];
  for (const block of contentBlocks(event)) {
    if (block.type === "text" && typeof block.text === "string")
      texts.push(block.text);
    const request =
      block.type === "tool_use"
        ? mcpRequest(CLAUDE_MCP_NAME, block.id, block.name, block.input)
        : undefined;
    if (request !== undefined) state.requests.push(request);
  }
  // Subagent messages carry a parent tool ID and are not the top-level answer.
  if (absent(event.parent_tool_use_id) && texts.length > 0)
    state.messages.push(texts.join("\n"));
};

const consumeClaudeUser = (
  state: ClaudeState,
  event: Record<string, unknown>,
): void => {
  const toolResults = contentBlocks(event).filter(
    (block) => block.type === "tool_result",
  );
  // The raw MCP result accompanies a user event that carries one tool result.
  const raw = toolResults.length === 1 ? event.tool_use_result : undefined;
  for (const block of toolResults) {
    const id = textValue(block.tool_use_id);
    if (id !== undefined)
      retainResult(state.results, state.conflicts, id, {
        isError: block.is_error === true,
        raw,
      });
  }
};

/**
 * The terminal result event carries the run's own failure facts. A refused
 * `dontAsk` request still lets Claude answer and exit 0; the denial is kept
 * so the gate can reject a run REA was never permitted to serve.
 */
const consumeClaudeResult = (
  state: ClaudeState,
  event: Record<string, unknown>,
): void => {
  state.resultText = textValue(event.result);
  state.usage = claudeUsage(event);
  if (event.is_error === true)
    state.clientFailures.push(
      `result_error:${textValue(event.subtype) ?? "unknown"}`,
    );
  const denials = Array.isArray(event.permission_denials)
    ? event.permission_denials
    : [];
  for (const denial of denials)
    state.clientFailures.push(
      `permission_denied:${textValue(record(denial)?.tool_name) ?? "unknown"}`,
    );
};

/** Claude reports uncached, cache-creation, and cache-read input separately. */
const claudeUsage = (event: Record<string, unknown>): AgentTokenUsage => {
  const usage = record(event.usage);
  const cacheRead = numberValue(usage?.cache_read_input_tokens);
  return {
    inputTokens:
      numberValue(usage?.input_tokens) +
      numberValue(usage?.cache_creation_input_tokens) +
      cacheRead,
    cachedInputTokens: cacheRead,
    outputTokens: numberValue(usage?.output_tokens),
  };
};

/** Parse `claude --print --output-format stream-json --verbose` events. */
export const parseClaudeCodeEvents = (
  events: readonly unknown[],
): AgentTranscript => {
  const state: ClaudeState = {
    conflicts: new Set(),
    requests: [],
    results: new Map(),
    messages: [],
    clientFailures: [],
    resultText: undefined,
    usage: NO_USAGE,
  };
  for (const event of records(events)) {
    if (event.type === "assistant") consumeClaudeAssistant(state, event);
    else if (event.type === "user") consumeClaudeUser(state, event);
    else if (event.type === "result") consumeClaudeResult(state, event);
  }
  const calls = state.requests.map((request): AgentToolCall => {
    const reported = state.results.get(request.id);
    const facts = mcpResultFacts(
      reported?.raw,
      reported?.isError === true,
      undefined,
    );
    const delivered =
      reported !== undefined &&
      !reported.isError &&
      !state.conflicts.has(request.id) &&
      facts.retained;
    return {
      ...request,
      delivered,
      error: facts.failed,
      errorCode: facts.errorCode,
      resultContent: delivered ? facts.content : undefined,
    };
  });
  return {
    calls: uniqueCalls(calls),
    finalMessage: state.resultText ?? state.messages.at(-1) ?? "",
    usage: state.usage,
    clientFailures: state.clientFailures,
  };
};

/** Gemini CLI names MCP tools `mcp_<server>_<tool>`; server names cannot contain `_`. */
const GEMINI_MCP_NAME = /^mcp_([^_]+)_(.+)$/u;

interface GeminiReport {
  readonly status: unknown;
  readonly output: unknown;
  readonly error: unknown;
}

const geminiCall = (
  request: McpRequest,
  reported: GeminiReport | undefined,
  conflicting: boolean,
): AgentToolCall => {
  const failed = reported !== undefined && reported.status !== "success";
  // Gemini retains only the joined MCP text content, not structured content.
  const text =
    typeof reported?.output === "string" ? reported.output : undefined;
  const facts = mcpResultFacts(
    text === undefined ? undefined : { content: [{ type: "text", text }] },
    failed,
    reported?.error,
  );
  const delivered =
    reported !== undefined && !failed && !conflicting && facts.retained;
  return {
    ...request,
    delivered,
    error: facts.failed,
    errorCode: facts.errorCode,
    resultContent: delivered ? facts.content : undefined,
  };
};

/** Gemini reports prompt tokens including cached content tokens. */
const geminiUsage = (event: Record<string, unknown>): AgentTokenUsage => {
  const stats = record(event.stats);
  return {
    inputTokens: numberValue(stats?.input_tokens),
    cachedInputTokens: numberValue(stats?.cached),
    outputTokens: numberValue(stats?.output_tokens),
  };
};

/** Parse `gemini --output-format stream-json` events. */
export const parseGeminiCliEvents = (
  events: readonly unknown[],
): AgentTranscript => {
  const requests: McpRequest[] = [];
  const results = new Map<string, GeminiReport>();
  const conflicts = new Set<string>();
  const clientFailures: string[] = [];
  // Assistant text between tool calls; the last non-empty segment is the answer.
  const segments: string[] = [];
  let segmentOpen = false;
  let usage = NO_USAGE;
  for (const event of records(events)) {
    if (event.type === "message" && event.role === "assistant") {
      const content = typeof event.content === "string" ? event.content : "";
      const continued = segmentOpen && event.delta === true;
      segments.push(`${continued ? (segments.pop() ?? "") : ""}${content}`);
      segmentOpen = true;
    } else if (event.type === "tool_use") {
      segmentOpen = false;
      const request = mcpRequest(
        GEMINI_MCP_NAME,
        event.tool_id,
        event.tool_name,
        event.parameters,
      );
      if (request !== undefined) requests.push(request);
    } else if (event.type === "tool_result") {
      const id = textValue(event.tool_id);
      if (id !== undefined)
        retainResult(results, conflicts, id, {
          status: event.status,
          output: event.output,
          error: event.error,
        });
    } else if (event.type === "result") {
      usage = geminiUsage(event);
      if (event.status !== undefined && event.status !== "success")
        clientFailures.push(`result_status:${String(event.status)}`);
    }
  }
  return {
    calls: uniqueCalls(
      requests.map((request) =>
        geminiCall(request, results.get(request.id), conflicts.has(request.id)),
      ),
    ),
    finalMessage:
      segments.filter((segment) => segment.trim().length > 0).at(-1) ?? "",
    usage,
    clientFailures,
  };
};

/** Parse one client's raw transcript events. */
export const parseAgentTranscript = (
  client: AgentClient,
  events: readonly unknown[],
): AgentTranscript => {
  switch (client) {
    case "codex":
      return parseCodexEvents(events);
    case "claude-code":
      return parseClaudeCodeEvents(events);
    case "gemini-cli":
      return parseGeminiCliEvents(events);
  }
};
