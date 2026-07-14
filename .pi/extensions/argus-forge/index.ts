import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Metadata = Record<string, JsonValue>;
type EventStatus = "running" | "completed" | "failed";
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

type CommonEvent = {
  eventId: string;
  sessionId: string;
  timestamp: string;
  agentName: string;
  projectId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metadata?: Metadata;
};

type ArgusEvent =
  | (CommonEvent & { type: "session.started"; projectName?: string; title?: string; status?: EventStatus })
  | (CommonEvent & { type: "session.updated"; title?: string; status?: EventStatus; endedAt?: string })
  | (CommonEvent & {
    type: "llm.request.started" | "llm.request.completed";
    provider: string;
    model: string;
    requestId?: string;
    status?: "running" | "completed";
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    inputBytes?: number;
    outputBytes?: number;
    latencyMs?: number;
    finishReason?: string;
    requestMetadata?: Metadata;
  })
  | (CommonEvent & {
    type: "llm.request.failed";
    provider: string;
    model: string;
    requestId?: string;
    status?: "failed";
    latencyMs?: number;
    errorCode?: string;
    errorMessage: string;
    requestMetadata?: Metadata;
  })
  | (CommonEvent & {
    type: "llm.stream.chunk";
    provider?: string;
    model?: string;
    requestId?: string;
    chunkIndex?: number;
    contentBytes?: number;
    completionTokens?: number;
    textPreview?: string;
  })
  | (CommonEvent & {
    type: "tool.call.started" | "tool.call.completed";
    toolName: string;
    callId?: string;
    status?: "running" | "completed";
    argumentsSummary?: string;
    redactedArguments?: JsonValue;
    resultSummary?: string;
    exitStatus?: string;
    latencyMs?: number;
  })
  | (CommonEvent & {
    type: "tool.call.failed";
    toolName: string;
    callId?: string;
    status?: "failed";
    argumentsSummary?: string;
    redactedArguments?: JsonValue;
    resultSummary?: string;
    exitStatus?: string;
    latencyMs?: number;
    errorCode?: string;
    errorMessage: string;
  })
  | (CommonEvent & { type: "agent.log"; level?: LogLevel; message: string });

type ArgusEventDraft = Omit<CommonEvent, "eventId" | "timestamp"> & {
  type: ArgusEvent["type"];
  projectName?: string;
  title?: string;
  endedAt?: string;
  status?: EventStatus;
  provider?: string;
  model?: string;
  requestId?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  inputBytes?: number;
  outputBytes?: number;
  latencyMs?: number;
  finishReason?: string;
  requestMetadata?: Metadata;
  errorCode?: string;
  errorMessage?: string;
  chunkIndex?: number;
  contentBytes?: number;
  textPreview?: string;
  toolName?: string;
  callId?: string;
  argumentsSummary?: string;
  redactedArguments?: JsonValue;
  resultSummary?: string;
  exitStatus?: string;
  level?: LogLevel;
  message?: string;
};

type HookName =
  | "session_start"
  | "session_info_changed"
  | "session_shutdown"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "model_select"
  | "before_provider_request"
  | "after_provider_response"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "tool_call"
  | "tool_result";

type HookHandler = (event: unknown, ctx?: ExtensionContext) => void | Promise<void>;
type HookRegistrar = { on?: (name: string, handler: HookHandler) => void };
type PiLike = HookRegistrar & { hooks?: HookRegistrar; events?: HookRegistrar; context?: ExtensionContext };

type Config = {
  ingestUrl: string;
  agentName: string;
  projectId: string;
  projectName: string;
  flushIntervalMs: number;
  flushTimeoutMs: number;
  batchSize: number;
  maxQueueSize: number;
  maxRetryAttempts: number;
  emitStreamChunks: boolean;
  logLevel: LogLevel;
  httpRequestLogDetails: boolean;
};

type ConfigFile = Partial<{
  ingestUrl: unknown;
  agentName: unknown;
  projectId: unknown;
  projectName: unknown;
  flushIntervalMs: unknown;
  flushTimeoutMs: unknown;
  batchSize: unknown;
  maxQueueSize: unknown;
  maxRetryAttempts: unknown;
  emitStreamChunks: unknown;
  logLevel: unknown;
  httpRequestLogDetails: unknown;
}>;

type LlmRequestState = {
  requestId: string;
  spanId: string;
  provider: string;
  model: string;
  startedAt: string;
  inputBytes?: number;
  requestMetadata?: Metadata;
};

type ToolState = {
  callId: string;
  spanId: string;
  toolName: string;
  startedAt: string;
  argumentsSummary?: string;
  redactedArguments?: JsonValue;
};

const DEFAULT_INGEST_URL = "http://localhost:4000/v1/ingest/events";
const MAX_BATCH_SIZE = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const SETTINGS_FILE_NAME = "argus-forge.settings.json";
const PREVIEW_CHARS = 500;
const SUMMARY_CHARS = 2000;
const SECRET_KEY_RE = /(api[_-]?key|authorization|bearer|cookie|credential|password|secret|token)/i;
const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY
};

export default function argusForgePiExtension(pi: ExtensionAPI): void {
  const piRuntime = pi as PiLike;
  const initialCtx = piRuntime.context;
  const cwd = readString(initialCtx, ["cwd"]) ?? callString(initialCtx, ["sessionManager", "getCwd"]) ?? process.cwd();
  const config = readConfig(cwd);
  const queue = new EventQueue(config);
  const state = {
    currentSessionId: stableId(["pi-session", cwd]),
    activeModel: { provider: "unknown", model: "unknown" },
    activeLlmSpanId: undefined as string | undefined,
    requestSeq: 0,
    chunkSeq: 0,
    llmRequests: new Map<string, LlmRequestState>(),
    tools: new Map<string, ToolState>(),
    lastToolResult: new Map<string, unknown>()
  };

  const base = (event: unknown, ctx?: ExtensionContext): Omit<CommonEvent, "eventId" | "timestamp"> => {
    const sessionId = getSessionId(event, ctx) ?? state.currentSessionId;
    state.currentSessionId = sessionId;

    return {
      sessionId,
      agentName: config.agentName,
      projectId: config.projectId,
      traceId: sessionId,
      metadata: {
        piHookSource: "pi-extension",
        cwd: readString(ctx, ["cwd"]) ?? callString(ctx, ["sessionManager", "getCwd"]) ?? cwd
      }
    };
  };

  const emit = (event: ArgusEventDraft, parts: unknown[]): void => {
    queue.enqueue({
      ...event,
      eventId: stableId([event.type, event.sessionId, ...parts]),
      timestamp: isoNow()
    } as ArgusEvent);
  };

  on(piRuntime, "session_start", (event, ctx) => {
    const common = base(event, ctx);
    const sessionId = common.sessionId;
    emit(
      {
        ...common,
        type: "session.started",
        spanId: sessionId,
        projectName: config.projectName,
        title: readString(event, ["title"]) ?? readString(event, ["session", "title"]) ?? config.projectName,
        status: "running",
        metadata: metadata({
          ...common.metadata,
          reason: readString(event, ["reason"]),
          sessionFile:
            readString(event, ["sessionFile"]) ?? readString(event, ["session", "file"]) ?? callString(ctx, ["sessionManager", "getSessionFile"]),
          sessionName: readString(event, ["session", "name"])
        })
      },
      ["start"]
    );
  });

  on(piRuntime, "session_info_changed", (event, ctx) => {
    const common = base(event, ctx);
    emit(
      {
        ...common,
        type: "session.updated",
        spanId: common.sessionId,
        title: readString(event, ["title"]) ?? readString(event, ["name"]) ?? readString(event, ["session", "title"]),
        metadata: metadata({ ...common.metadata, sessionInfo: compactObject(event, 1000) })
      },
      ["info", eventKey(event)]
    );
  });

  on(piRuntime, "session_shutdown", async (event, ctx) => {
    const common = base(event, ctx);
    const endedAt = isoNow();
    emit(
      {
        ...common,
        type: "session.updated",
        spanId: common.sessionId,
        status: "completed",
        endedAt,
        metadata: metadata({ ...common.metadata, reason: readString(event, ["reason"]) })
      },
      ["shutdown"]
    );
    await queue.flush(readSignal(ctx));
  });

  on(piRuntime, "before_agent_start", (event, ctx) => {
    const common = base(event, ctx);
    emitAgentLog(common, "info", "Pi agent run starting", {
      promptPreview: summarize(readUnknown(event, ["prompt"]) ?? readUnknown(event, ["input"]), PREVIEW_CHARS),
      imageCount: readArray(event, ["images"])?.length,
      selectedToolsCount: readArray(event, ["tools"])?.length ?? readArray(event, ["systemPromptOptions", "selectedTools"])?.length,
      systemPromptContext: summarize(readUnknown(event, ["systemPrompt"]) ?? readUnknown(event, ["systemPromptContext"]), PREVIEW_CHARS)
    });
  });

  on(piRuntime, "agent_start", (event, ctx) => {
    emitAgentLog(base(event, ctx), "info", "Pi agent run started", { event: compactObject(event, 1000) });
  });

  on(piRuntime, "agent_end", (event, ctx) => {
    const common = base(event, ctx);
    completeOpenLlmRequest(common, event);
    emitAgentLog(common, "info", "Pi agent run ended", {
      messageCount: readArray(event, ["messages"])?.length,
      event: compactObject(event, 1000)
    });
  });

  on(piRuntime, "agent_settled", (event, ctx) => {
    emitAgentLog(base(event, ctx), "debug", "Pi agent idle", { event: compactObject(event, 500) });
  });

  on(piRuntime, "turn_start", (event, ctx) => {
    emitAgentLog(base(event, ctx), "debug", "Pi turn started", { event: compactObject(event, 500) });
  });

  on(piRuntime, "turn_end", (event, ctx) => {
    emitAgentLog(base(event, ctx), "debug", "Pi turn ended", { event: compactObject(event, 500) });
  });

  on(piRuntime, "model_select", (event, ctx) => {
    const modelValue = readObject(event, ["model"]) ?? readObject(event, ["selectedModel"]) ?? {};
    const provider = readString(modelValue, ["provider"]) ?? readString(event, ["provider"]) ?? "unknown";
    const model = readString(modelValue, ["id"]) ?? readString(modelValue, ["model"]) ?? readString(event, ["modelId"]) ?? "unknown";
    state.activeModel = { provider, model };
    emitAgentLog(base(event, ctx), "debug", "Pi model selected", { provider, model });
  });

  on(piRuntime, "before_provider_request", (event, ctx) => {
    const common = base(event, ctx);
    const provider = readString(event, ["provider"]) ?? readString(ctx, ["model", "provider"]) ?? state.activeModel.provider;
    const model = readString(event, ["model", "id"]) ?? readString(ctx, ["model", "id"]) ?? readString(event, ["model"]) ?? state.activeModel.model;
    const requestId = readString(event, ["requestId"]) ?? readString(event, ["id"]) ?? stableId(["llm-request", common.sessionId, ++state.requestSeq]);
    const llmSpanId = spanId("llm", requestId);
    const payload = readUnknown(event, ["payload"]) ?? readUnknown(event, ["request"]) ?? readUnknown(event, ["messages"]) ?? event;
    const inputBytes = byteLength(payload);
    const startedAt = isoNow();
    const requestMetadata = metadata({ requestPreview: completeJson(payload), requestSummary: summarize(payload, PREVIEW_CHARS) });

    state.activeLlmSpanId = llmSpanId;
    state.llmRequests.set(requestId, { requestId, spanId: llmSpanId, provider, model, startedAt, inputBytes, requestMetadata });

    queue.enqueue({
      ...common,
      type: "llm.request.started",
      eventId: stableId(["llm.request.started", common.sessionId, requestId]),
      timestamp: startedAt,
      spanId: llmSpanId,
      parentSpanId: common.sessionId,
      provider,
      model,
      requestId,
      status: "running",
      inputBytes,
      requestMetadata
    });
  });

  on(piRuntime, "after_provider_response", (event, ctx) => {
    const common = base(event, ctx);
    const request = findLlmRequest(event) ?? lastValue(state.llmRequests);
    if (!request) return;

    const latencyMs = durationMs(request.startedAt, isoNow());
    const errorMessage = readString(event, ["error", "message"]) ?? readString(event, ["errorMessage"]);
    const status = readNumber(event, ["status"]) ?? readNumber(event, ["response", "status"]);
    const response = readUnknown(event, ["response"]) ?? readUnknown(event, ["payload"]) ?? event;
    request.requestMetadata = metadata({ ...request.requestMetadata, responsePreview: completeJson(response), responseStatus: status });
    if (errorMessage || (status != null && status >= 400)) {
      emit({
        ...common,
        type: "llm.request.failed",
        spanId: request.spanId,
        parentSpanId: common.sessionId,
        provider: request.provider,
        model: request.model,
        requestId: request.requestId,
        status: "failed",
        latencyMs,
        errorCode: readString(event, ["error", "code"]) ?? readString(event, ["errorCode"]),
        errorMessage: errorMessage ?? `Provider request failed with HTTP ${status}`,
        requestMetadata: metadata({ ...request.requestMetadata, errorPreview: completeJson(readUnknown(event, ["error"]) ?? event) })
      }, ["failed", request.requestId]);
      state.llmRequests.delete(request.requestId);
      return;
    }

    emitAgentLog(common, "debug", "Pi provider response received", {
      requestId: request.requestId,
      spanId: request.spanId,
      responseStatus: status,
      latencyMs
    });
  });

  on(piRuntime, "message_update", (event, ctx) => {
    if (!config.emitStreamChunks) return;
    const request = lastValue(state.llmRequests);
    const common = base(event, ctx);
    emit(
      {
        ...common,
        type: "llm.stream.chunk",
        spanId: request?.spanId ?? state.activeLlmSpanId,
        parentSpanId: common.sessionId,
        provider: request?.provider ?? state.activeModel.provider,
        model: request?.model ?? state.activeModel.model,
        requestId: request?.requestId,
        chunkIndex: state.chunkSeq++,
        contentBytes: byteLength(readUnknown(event, ["message", "content"]) ?? readUnknown(event, ["content"]) ?? event),
        textPreview: summarize(readUnknown(event, ["message", "content"]) ?? readUnknown(event, ["content"]), PREVIEW_CHARS)
      },
      ["chunk", state.chunkSeq]
    );
  });

  on(piRuntime, "message_end", (event, ctx) => {
    completeOpenLlmRequest(base(event, ctx), event);
  });

  on(piRuntime, "tool_call", (event) => {
    const callId = getToolCallId(event);
    if (!callId) return;
    state.lastToolResult.delete(callId);
  });

  on(piRuntime, "tool_execution_start", (event, ctx) => {
    const common = base(event, ctx);
    const callId = getToolCallId(event) ?? stableId(["tool-call", common.sessionId, eventKey(event)]);
    const toolName = getToolName(event);
    const toolSpanId = spanId("tool", callId);
    const args = readUnknown(event, ["arguments"]) ?? readUnknown(event, ["args"]) ?? readUnknown(event, ["input"]);
    const toolState: ToolState = {
      callId,
      spanId: toolSpanId,
      toolName,
      startedAt: isoNow(),
      argumentsSummary: summarize(args, SUMMARY_CHARS),
      redactedArguments: redactJson(args)
    };
    state.tools.set(callId, toolState);

    queue.enqueue({
      ...common,
      type: "tool.call.started",
      eventId: stableId(["tool.call.started", common.sessionId, callId]),
      timestamp: toolState.startedAt,
      spanId: toolSpanId,
      parentSpanId: state.activeLlmSpanId ?? common.sessionId,
      toolName,
      callId,
      status: "running",
      argumentsSummary: toolState.argumentsSummary,
      redactedArguments: toolState.redactedArguments
    });
  });

  on(piRuntime, "tool_execution_update", (event, ctx) => {
    emitAgentLog(base(event, ctx), "debug", "Pi tool execution update", {
      toolCallId: getToolCallId(event),
      toolName: getToolName(event),
      event: compactObject(event, 500)
    });
  });

  on(piRuntime, "tool_result", (event) => {
    const callId = getToolCallId(event);
    if (callId) state.lastToolResult.set(callId, readUnknown(event, ["result"]) ?? readUnknown(event, ["content"]) ?? event);
  });

  on(piRuntime, "tool_execution_end", (event, ctx) => {
    const common = base(event, ctx);
    const callId = getToolCallId(event) ?? stableId(["tool-call", common.sessionId, eventKey(event)]);
    const existing = state.tools.get(callId);
    const toolName = existing?.toolName ?? getToolName(event);
    const result = readUnknown(event, ["result"]) ?? state.lastToolResult.get(callId) ?? readUnknown(event, ["output"]);
    const failed = readBoolean(event, ["isError"]) ?? readBoolean(event, ["error"]) ?? Boolean(readUnknown(event, ["errorMessage"]));
    const latencyMs = existing ? durationMs(existing.startedAt, isoNow()) : undefined;

    if (failed) {
      emit({
        ...common,
        type: "tool.call.failed",
        spanId: existing?.spanId ?? spanId("tool", callId),
        parentSpanId: state.activeLlmSpanId ?? common.sessionId,
        toolName,
        callId,
        status: "failed",
        argumentsSummary: existing?.argumentsSummary,
        redactedArguments: existing?.redactedArguments,
        resultSummary: summarize(result, SUMMARY_CHARS),
        exitStatus: readString(event, ["exitStatus"]) ?? readString(event, ["status"]),
        latencyMs,
        errorCode: readString(event, ["errorCode"]) ?? readString(event, ["error", "code"]),
        errorMessage: readString(event, ["errorMessage"]) ?? readString(event, ["error", "message"]) ?? "Tool execution failed"
      }, ["failed", callId]);
    } else {
      emit({
        ...common,
        type: "tool.call.completed",
        spanId: existing?.spanId ?? spanId("tool", callId),
        parentSpanId: state.activeLlmSpanId ?? common.sessionId,
        toolName,
        callId,
        status: "completed",
        argumentsSummary: existing?.argumentsSummary,
        redactedArguments: existing?.redactedArguments,
        resultSummary: summarize(result, SUMMARY_CHARS),
        exitStatus: readString(event, ["exitStatus"]) ?? readString(event, ["status"]),
        latencyMs
      }, ["completed", callId]);
    }

    state.tools.delete(callId);
    state.lastToolResult.delete(callId);
  });

  function emitAgentLog(common: Omit<CommonEvent, "eventId" | "timestamp">, level: LogLevel, message: string, data?: Record<string, unknown>): void {
    emit(
      {
        ...common,
        type: "agent.log",
        level,
        message,
        metadata: metadata({ ...common.metadata, ...data })
      },
      [message, eventKey(data)]
    );
  }

  function findLlmRequest(event: unknown): LlmRequestState | undefined {
    const requestId = readString(event, ["requestId"]) ?? readString(event, ["id"]);
    if (requestId) return state.llmRequests.get(requestId);
    return undefined;
  }

  function completeOpenLlmRequest(common: Omit<CommonEvent, "eventId" | "timestamp">, event: unknown): void {
    const request = lastValue(state.llmRequests);
    if (!request) return;
    const usage = readObject(event, ["message", "usage"]) ?? readObject(event, ["usage"]) ?? {};
    const response = readUnknown(event, ["message"]) ?? readUnknown(event, ["response"]) ?? event;
    request.requestMetadata = metadata({ ...request.requestMetadata, responsePreview: completeJson(response) });
    emit(
      {
        ...common,
        type: "llm.request.completed",
        spanId: request.spanId,
        parentSpanId: common.sessionId,
        provider: request.provider,
        model: request.model,
        requestId: request.requestId,
        status: "completed",
        promptTokens: tokenCount(usage, ["promptTokens", "prompt_tokens", "inputTokens", "input_tokens", "input"]),
        completionTokens: tokenCount(usage, ["completionTokens", "completion_tokens", "outputTokens", "output_tokens", "output"]),
        cachedTokens: tokenCount(usage, ["cachedTokens", "cached_tokens", "cacheRead", "cacheWrite"]),
        latencyMs: durationMs(request.startedAt, isoNow()),
        finishReason: readString(event, ["finishReason"]) ?? readString(event, ["message", "finishReason"]),
        requestMetadata: metadata({ ...request.requestMetadata, usageUnavailable: Object.keys(usage).length === 0, completedFrom: "message_or_agent_end" })
      },
      ["completed", request.requestId]
    );
    state.llmRequests.delete(request.requestId);
  }
}

class EventQueue {
  private readonly queue: ArgusEvent[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly logger: ExtensionLogger;
  private flushing = false;
  private retryDelayMs = 500;
  private retryAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly config: Config) {
    this.logger = new ExtensionLogger(config.logLevel);
    this.timer = setInterval(() => {
      void this.flush();
    }, config.flushIntervalMs);
    this.timer.unref?.();
  }

  enqueue(event: ArgusEvent): void {
    this.queue.push(event);
    while (this.queue.length > this.config.maxQueueSize) this.queue.shift();
    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.config.batchSize);
    const timeout = withTimeoutSignal(signal, this.config.flushTimeoutMs);
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ events: batch });
    try {
      if (this.config.httpRequestLogDetails) {
        this.logger.debug("ingest http request", { url: this.config.ingestUrl, headers, events: batch });
      }
      const response = await fetch(this.config.ingestUrl, {
        method: "POST",
        headers,
        body,
        signal: timeout.signal
      });
      if (this.config.httpRequestLogDetails) {
        this.logger.debug("ingest http response", { url: this.config.ingestUrl, status: response.status, ok: response.ok });
      }
      if (!response.ok) {
        if (response.body) {
          this.logger.warn("Upstream response error:", response);
        }
        throw new Error(`Argus Forge ingest returned HTTP ${response.status}`);
      }
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      this.retryAttempts = 0;
      this.retryDelayMs = 500;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.retryAttempts += 1;

      if (this.retryAttempts > this.config.maxRetryAttempts) {
        this.logger.warn(
          `failed to flush telemetry after ${this.config.maxRetryAttempts} attempts; dropping ${batch.length} event(s): ${message}`
        );
        this.retryAttempts = 0;
        this.retryDelayMs = 500;
        return;
      }

      this.queue.unshift(...batch);
      while (this.queue.length > this.config.maxQueueSize) this.queue.shift();
      this.logger.warn(`failed to flush telemetry (attempt ${this.retryAttempts}/${this.config.maxRetryAttempts}): ${message}`);
      this.scheduleRetry();
    } finally {
      timeout.dispose();
      this.flushing = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }
}

class ExtensionLogger {
  constructor(private readonly level: LogLevel) { }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  private log(level: Exclude<LogLevel, "silent">, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;
    const suffix = data ? ` ${safeJson(data, 4000)}` : "";
    const line = `[argus-forge] ${message}${suffix}`;
    if (level === "error" || level === "fatal") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Argus Forge ingest timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const abort = (): void => controller.abort(signal?.reason);

  timeout.unref?.();
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

function on(pi: PiLike, name: HookName, handler: HookHandler): void {
  const registrar = pi.on ? pi : pi.hooks?.on ? pi.hooks : pi.events?.on ? pi.events : undefined;
  if (!registrar?.on) {
    console.warn(`[argus-forge] Pi extension API does not expose a hook registrar for ${name}`);
    return;
  }
  registrar.on(name, (event, ctx) => {
    Promise.resolve(handler(event, ctx)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[argus-forge] ${name} handler failed: ${message}`);
    });
  });
}

function readConfig(cwd: string): Config {
  const settings = readSettingsFile();
  return {
    ingestUrl: readStringSetting(process.env.ARGUS_FORGE_INGEST_URL, settings.ingestUrl, DEFAULT_INGEST_URL),
    agentName: readStringSetting(process.env.ARGUS_FORGE_AGENT_NAME, settings.agentName, "pi"),
    projectId: readStringSetting(process.env.ARGUS_FORGE_PROJECT_ID, settings.projectId, slug(cwd)),
    projectName: readStringSetting(process.env.ARGUS_FORGE_PROJECT_NAME, settings.projectName, basename(cwd)),
    flushIntervalMs: readPositiveInt(process.env.ARGUS_FORGE_FLUSH_INTERVAL_MS ?? settings.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS),
    flushTimeoutMs: readPositiveInt(process.env.ARGUS_FORGE_FLUSH_TIMEOUT_MS ?? settings.flushTimeoutMs, DEFAULT_FLUSH_TIMEOUT_MS),
    batchSize: Math.min(readPositiveInt(process.env.ARGUS_FORGE_BATCH_SIZE ?? settings.batchSize, 100), MAX_BATCH_SIZE),
    maxQueueSize: readPositiveInt(process.env.ARGUS_FORGE_MAX_QUEUE_SIZE ?? settings.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
    maxRetryAttempts: readPositiveInt(process.env.ARGUS_FORGE_MAX_RETRY_ATTEMPTS ?? settings.maxRetryAttempts, DEFAULT_MAX_RETRY_ATTEMPTS),
    emitStreamChunks: readBooleanSetting(process.env.ARGUS_FORGE_EMIT_STREAM_CHUNKS ?? settings.emitStreamChunks, false),
    logLevel: readLogLevel(process.env.ARGUS_FORGE_LOG_LEVEL ?? settings.logLevel, "warn"),
    httpRequestLogDetails: readBooleanSetting(process.env.ARGUS_FORGE_HTTP_REQUEST_LOG_DETAILS ?? settings.httpRequestLogDetails, false)
  };
}

function readSettingsFile(): ConfigFile {
  const settingsPath = join(dirname(fileURLToPath(import.meta.url)), SETTINGS_FILE_NAME);
  if (!existsSync(settingsPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[argus-forge] failed to read ${settingsPath}: ${message}`);
    return {};
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function stableId(parts: unknown[]): string {
  const input = parts.map((part) => (typeof part === "string" ? part : safeJson(part, 1000))).join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `pi-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function safeJson(value: unknown, maxChars: number): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(redact(value, seen));
  return truncate(json ?? String(value), maxChars);
}

function summarize(value: unknown, maxChars: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(value, maxChars);
  return safeJson(value, maxChars);
}

function durationMs(start: string, end: string): number {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function spanId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

function metadata(value: Record<string, unknown>): Metadata {
  const result: Metadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = toJsonValue(item);
  }
  return result;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) output[key] = toJsonValue(item);
    return output;
  }
  return String(value);
}

function redactJson(value: unknown): JsonValue | undefined {
  if (value == null) return undefined;
  return toJsonValue(redact(value, new WeakSet<object>()));
}

function completeJson(value: unknown): JsonValue | undefined {
  if (value == null) return undefined;
  return toJsonValue(redactComplete(value, new WeakSet<object>()));
}

function redactComplete(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactComplete(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactComplete(item, seen);
  }
  return output;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redact(item, seen);
  }
  return output;
}

function compactObject(value: unknown, maxChars: number): JsonValue {
  return safeJson(value, maxChars);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : safeJson(value, 100_000), "utf8");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}...`;
}

function readStringSetting(envValue: string | undefined, fileValue: unknown, fallback: string): string {
  if (envValue && envValue.length > 0) return envValue;
  return typeof fileValue === "string" && fileValue.length > 0 ? fileValue : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(typeof value === "string" ? value : "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function readLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  return typeof value === "string" && value in LOG_LEVELS ? (value as LogLevel) : fallback;
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "project";
}

function slug(value: string): string {
  return basename(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || stableId(["project", value]);
}

function getSessionId(event: unknown, ctx?: ExtensionContext): string | undefined {
  return (
    readString(event, ["sessionId"]) ??
    readString(event, ["session", "id"]) ??
    readString(ctx, ["sessionId"]) ??
    readString(ctx, ["session", "id"]) ??
    callString(ctx, ["sessionManager", "getSessionId"])
  );
}

function getToolCallId(event: unknown): string | undefined {
  return (
    readString(event, ["toolCallId"]) ??
    readString(event, ["callId"]) ??
    readString(event, ["id"]) ??
    readString(event, ["toolCall", "id"])
  );
}

function getToolName(event: unknown): string {
  return readString(event, ["toolName"]) ?? readString(event, ["name"]) ?? readString(event, ["tool", "name"]) ?? "unknown-tool";
}

function eventKey(event: unknown): string {
  return readString(event, ["eventId"]) ?? readString(event, ["id"]) ?? safeJson(event, 500);
}

function tokenCount(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item) && item >= 0) return Math.floor(item);
  }
  return undefined;
}

function lastValue<T>(map: Map<string, T>): T | undefined {
  let result: T | undefined;
  for (const value of map.values()) result = value;
  return result;
}

function readUnknown(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function readString(value: unknown, path: string[]): string | undefined {
  const item = readUnknown(value, path);
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function callString(value: unknown, path: string[]): string | undefined {
  if (path.length === 0) return undefined;
  const methodName = path[path.length - 1];
  const receiver = readUnknown(value, path.slice(0, -1));
  if (!isRecord(receiver)) return undefined;
  const method = receiver[methodName];
  if (typeof method !== "function") return undefined;
  try {
    const result = (method as () => unknown).call(receiver);
    return typeof result === "string" && result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function readNumber(value: unknown, path: string[]): number | undefined {
  const item = readUnknown(value, path);
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function readBoolean(value: unknown, path: string[]): boolean | undefined {
  const item = readUnknown(value, path);
  return typeof item === "boolean" ? item : undefined;
}

function readArray(value: unknown, path: string[]): unknown[] | undefined {
  const item = readUnknown(value, path);
  return Array.isArray(item) ? item : undefined;
}

function readObject(value: unknown, path: string[]): Record<string, unknown> | undefined {
  const item = readUnknown(value, path);
  return isRecord(item) ? item : undefined;
}

function readSignal(value: unknown): AbortSignal | undefined {
  const item = readUnknown(value, ["signal"]);
  return item instanceof AbortSignal ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
