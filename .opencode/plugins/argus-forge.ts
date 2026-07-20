import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Meta = Record<string, Json>;
type Status = "running" | "completed" | "failed";
type Level = "debug" | "info" | "warn" | "error";
type Common = { eventId: string; sessionId: string; timestamp: string; agentName: string; projectId?: string; traceId?: string; spanId?: string; parentSpanId?: string; metadata?: Meta };
type ArgusEvent = Common & Record<string, unknown> & { type: "session.started" | "session.updated" | "llm.request.started" | "llm.request.completed" | "llm.request.failed" | "llm.stream.chunk" | "tool.call.started" | "tool.call.completed" | "tool.call.failed" | "agent.log" };
type Config = { ingestUrl: string; agentName: string; projectId: string; projectName: string; flushIntervalMs: number; flushTimeoutMs: number; batchSize: number; maxQueueSize: number; maxRetryAttempts: number; emitStreamChunks: boolean; logLevel: "trace" | Level | "fatal" | "silent"; httpRequestLogDetails: boolean };
type LlmState = { startedAt: string; spanId: string; provider: string; model: string; terminal: boolean; chunks: Set<string> };
type ToolState = { startedAt: string; spanId: string; tool: string; args: unknown };

const MAX_BATCH = 500;
const PREVIEW = 500;
const SUMMARY = 2000;
const SECRET = /(api[_-]?key|authorization|bearer|cookie|credential|password|secret|token)/i;
const levels = { trace: 0, debug: 10, info: 20, warn: 30, error: 40, fatal: 50, silent: Infinity } as const;

export const ArgusForgePlugin: Plugin = async ({ directory, worktree, project }) => {
  const config = readConfig(directory);
  const queue = new DeliveryQueue(config);
  const llms = new Map<string, LlmState>();
  const tools = new Map<string, ToolState>();
  const toolParents = new Map<string, string>();
  const startedSessions = new Set<string>();
  const projectRecord = record(project);

  const common = (sessionId: string, span?: string, parent?: string): Omit<Common, "eventId" | "timestamp"> => ({
    sessionId, agentName: config.agentName, projectId: config.projectId, traceId: stableId("trace", sessionId),
    spanId: span, parentSpanId: parent,
    metadata: jsonObject({ opencodeHookSource: "opencode-plugin", directory, worktree, project: projectRecord?.id })
  });
  const emit = (type: ArgusEvent["type"], sessionId: string, unique: unknown[], fields: Record<string, unknown> = {}, timestamp?: unknown) => {
    queue.enqueue({ ...common(sessionId), ...fields, type, eventId: stableId(type, sessionId, ...unique), timestamp: iso(timestamp) } as ArgusEvent);
  };
  const ensureSession = (sessionId: string, info?: unknown) => {
    if (startedSessions.has(sessionId)) return;
    startedSessions.add(sessionId);
    const value = record(info);
    emit("session.started", sessionId, ["start"], { ...common(sessionId, stableId("session", sessionId)), projectName: config.projectName, title: str(value?.title) ?? config.projectName, status: "running", metadata: jsonObject({ ...common(sessionId).metadata, parentSessionId: str(value?.parentID) }) }, value && record(value.time)?.created);
  };
  const startLlm = (sessionId: string, info: Record<string, unknown>) => {
    if (info.role !== "assistant") return undefined;
    const messageId = str(info.id) ?? stableId("message", sessionId, safeJson(info, 500));
    let state = llms.get(messageId);
    if (!state) {
      state = { startedAt: iso(record(info.time)?.created), spanId: stableId("llm-span", sessionId, messageId), provider: str(info.providerID) ?? "unknown", model: str(info.modelID) ?? "unknown", terminal: false, chunks: new Set() };
      llms.set(messageId, state);
      emit("llm.request.started", sessionId, [messageId, "started"], { ...common(sessionId, state.spanId, stableId("session", sessionId)), provider: state.provider, model: state.model, requestId: messageId, status: "running", requestMetadata: jsonObject({ agent: info.agent, parentMessageId: info.parentID, path: info.path }) }, state.startedAt);
    }
    return { messageId, state };
  };
  const finishLlm = (sessionId: string, info: Record<string, unknown>) => {
    const found = startLlm(sessionId, info);
    if (!found || found.state.terminal) return;
    const time = record(info.time);
    if (!time?.completed && !info.error && !info.finish) return;
    found.state.terminal = true;
    const tokens = record(info.tokens), cache = record(tokens?.cache), error = record(info.error);
    const fields = { ...common(sessionId, found.state.spanId, stableId("session", sessionId)), provider: found.state.provider, model: found.state.model, requestId: found.messageId, latencyMs: duration(found.state.startedAt, iso(time?.completed)), promptTokens: num(tokens?.input), completionTokens: num(tokens?.output), cachedTokens: num(cache?.read), finishReason: str(info.finish), outputBytes: undefined, requestMetadata: jsonObject({ cost: info.cost, reasoningTokens: tokens?.reasoning, cacheWriteTokens: cache?.write, variant: info.variant }) };
    if (info.error) emit("llm.request.failed", sessionId, [found.messageId, "failed"], { ...fields, status: "failed", errorCode: str(error?.name), errorMessage: str(record(error?.data)?.message) ?? summarize(info.error, SUMMARY) ?? "OpenCode request failed" }, time?.completed);
    else emit("llm.request.completed", sessionId, [found.messageId, "completed"], { ...fields, status: "completed" }, time?.completed);
  };

  return {
    event: async ({ event }) => {
      try {
        const e = event as unknown as { type: string; properties?: Record<string, unknown> };
        const p = e.properties ?? {};
        const sessionId = str(p.sessionID) ?? str(record(p.info)?.sessionID) ?? str(record(p.part)?.sessionID) ?? (e.type === "session.error" ? stableId("session", directory) : undefined);
        if (!sessionId) return;
        if (e.type === "session.created") ensureSession(sessionId, p.info);
        else if (e.type === "session.updated") {
          ensureSession(sessionId, p.info); const info = record(p.info);
          emit("session.updated", sessionId, ["updated", record(info?.time)?.updated ?? safeJson(info, 500)], { ...common(sessionId, stableId("session", sessionId)), title: str(info?.title), metadata: jsonObject({ ...common(sessionId).metadata, parentSessionId: info?.parentID, sessionMetadata: info?.metadata }) }, record(info?.time)?.updated);
        } else if (e.type === "session.deleted") {
          ensureSession(sessionId, p.info); emit("session.updated", sessionId, ["deleted"], { ...common(sessionId, stableId("session", sessionId)), status: "completed", endedAt: iso(), metadata: jsonObject({ ...common(sessionId).metadata, reason: "deleted" }) }); await queue.flush();
        } else if (e.type === "session.error") {
          ensureSession(sessionId); const error = p.error;
          emit("session.updated", sessionId, ["error", safeJson(error, 500)], { ...common(sessionId, stableId("session", sessionId)), status: "failed", metadata: jsonObject({ ...common(sessionId).metadata, error }) });
          emit("agent.log", sessionId, ["error", safeJson(error, 500)], { level: "error", message: summarize(error, SUMMARY) ?? "OpenCode session error" }); await queue.flush();
        } else if (e.type === "session.idle") {
          emit("agent.log", sessionId, ["idle"], { level: "debug", message: "OpenCode session idle" }); await queue.flush();
        } else if (e.type === "message.updated") {
          ensureSession(sessionId); const info = record(p.info); if (info) finishLlm(sessionId, info);
        } else if (e.type === "message.part.updated") {
          const possibleTool = record(p.part);
          if (possibleTool?.type === "tool") {
            const callId = str(possibleTool.callID), messageId = str(possibleTool.messageID);
            if (callId && messageId) toolParents.set(callId, messageId);
          }
          if (!config.emitStreamChunks) return;
          const part = record(p.part); if (!part || part.type !== "text") return;
          const messageId = str(part.messageID); if (!messageId) return;
          const state = llms.get(messageId); const text = str(part.text) ?? ""; const chunkKey = `${str(part.id) ?? "part"}:${text.length}`;
          if (state?.chunks.has(chunkKey)) return; state?.chunks.add(chunkKey);
          emit("llm.stream.chunk", sessionId, [messageId, chunkKey], { ...common(sessionId, state?.spanId, stableId("session", sessionId)), provider: state?.provider, model: state?.model, requestId: messageId, chunkIndex: state?.chunks.size ? state.chunks.size - 1 : 0, contentBytes: Buffer.byteLength(text), textPreview: truncate(text, PREVIEW) }, p.time);
        }
      } catch (error) { log(config, "warn", `event handler failed: ${errorMessage(error)}`); }
    },
    "tool.execute.before": async (input, output) => {
      try {
        ensureSession(input.sessionID); const span = stableId("tool-span", input.sessionID, input.callID); const startedAt = iso();
        tools.set(input.callID, { startedAt, spanId: span, tool: input.tool, args: output.args });
        const parent = llms.get(toolParents.get(input.callID) ?? "")?.spanId ?? stableId("session", input.sessionID);
        emit("tool.call.started", input.sessionID, [input.callID, "started"], { ...common(input.sessionID, span, parent), toolName: input.tool, callId: input.callID, status: "running", argumentsSummary: summarize(output.args, SUMMARY), redactedArguments: toJson(redact(output.args)) }, startedAt);
      } catch (error) { log(config, "warn", `tool before handler failed: ${errorMessage(error)}`); }
    },
    "tool.execute.after": async (input, output) => {
      try {
        ensureSession(input.sessionID); const state = tools.get(input.callID); tools.delete(input.callID);
        const span = state?.spanId ?? stableId("tool-span", input.sessionID, input.callID); const failed = failure(output); const result = output.output;
        const parent = llms.get(toolParents.get(input.callID) ?? "")?.spanId ?? stableId("session", input.sessionID); toolParents.delete(input.callID);
        emit(failed ? "tool.call.failed" : "tool.call.completed", input.sessionID, [input.callID, failed ? "failed" : "completed"], { ...common(input.sessionID, span, parent), toolName: input.tool, callId: input.callID, status: failed ? "failed" : "completed", argumentsSummary: summarize(state?.args ?? input.args, SUMMARY), redactedArguments: toJson(redact(state?.args ?? input.args)), resultSummary: summarize(result, SUMMARY), latencyMs: duration(state?.startedAt ?? iso(), iso()), ...(failed ? { errorMessage: failureMessage(output) } : {}) });
      } catch (error) { log(config, "warn", `tool after handler failed: ${errorMessage(error)}`); }
    },
    dispose: async () => { await queue.close(); }
  };
};

export default ArgusForgePlugin;

class DeliveryQueue {
  private queue: ArgusEvent[] = []; private flushing = false; private attempts = 0; private retry?: ReturnType<typeof setTimeout>; private timer: ReturnType<typeof setInterval>;
  private config: Config;
  constructor(config: Config) { this.config = config; this.timer = setInterval(() => void this.flush(), config.flushIntervalMs); this.timer.unref?.(); }
  enqueue(event: ArgusEvent) { this.queue.push(event); if (this.queue.length > this.config.maxQueueSize) { const dropped = this.queue.splice(0, this.queue.length - this.config.maxQueueSize); log(this.config, "warn", `telemetry queue full; dropped ${dropped.length} oldest event(s)`); } if (this.queue.length >= this.config.batchSize) void this.flush(); }
  async close() { clearInterval(this.timer); if (this.retry) clearTimeout(this.retry); this.retry = undefined; while (this.flushing) await new Promise(resolve => setTimeout(resolve, 10)); const maxFlushes = Math.ceil(this.config.maxQueueSize / this.config.batchSize) * (this.config.maxRetryAttempts + 1); for (let count = 0; this.queue.length && count < maxFlushes; count++) await this.flush(); }
  async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) return; this.flushing = true; const batch = this.queue.splice(0, this.config.batchSize); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.config.flushTimeoutMs); timeout.unref?.();
    try {
      if (this.config.httpRequestLogDetails) log(this.config, "debug", `POST ${this.config.ingestUrl} ${safeJson({ events: batch }, 4000)}`);
      const response = await fetch(this.config.ingestUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }), signal: controller.signal });
      if (!response.ok) throw new Error(`ingest returned HTTP ${response.status}`); this.attempts = 0; if (this.retry) clearTimeout(this.retry); this.retry = undefined;
    } catch (error) {
      this.attempts++; if (this.attempts > this.config.maxRetryAttempts) { log(this.config, "warn", `dropping ${batch.length} telemetry event(s) after retries: ${errorMessage(error)}`); this.attempts = 0; }
      else { this.queue.unshift(...batch); log(this.config, "warn", `telemetry flush failed (${this.attempts}/${this.config.maxRetryAttempts}): ${errorMessage(error)}`); if (!this.retry) { this.retry = setTimeout(() => { this.retry = undefined; void this.flush(); }, Math.min(500 * 2 ** (this.attempts - 1), 30_000)); this.retry.unref?.(); } }
    } finally { clearTimeout(timeout); this.flushing = false; }
  }
}

function readConfig(directory: string): Config { const file = settings(); return { ingestUrl: setting("ARGUS_FORGE_INGEST_URL", file.ingestUrl, "http://localhost:4000/v1/ingest/events"), agentName: setting("ARGUS_FORGE_AGENT_NAME", file.agentName, "opencode"), projectId: setting("ARGUS_FORGE_PROJECT_ID", file.projectId, slug(directory)), projectName: setting("ARGUS_FORGE_PROJECT_NAME", file.projectName, basename(directory)), flushIntervalMs: positive(process.env.ARGUS_FORGE_FLUSH_INTERVAL_MS ?? file.flushIntervalMs, 1000), flushTimeoutMs: positive(process.env.ARGUS_FORGE_FLUSH_TIMEOUT_MS ?? file.flushTimeoutMs, 2000), batchSize: Math.min(positive(process.env.ARGUS_FORGE_BATCH_SIZE ?? file.batchSize, 100), MAX_BATCH), maxQueueSize: positive(process.env.ARGUS_FORGE_MAX_QUEUE_SIZE ?? file.maxQueueSize, 5000), maxRetryAttempts: positive(process.env.ARGUS_FORGE_MAX_RETRY_ATTEMPTS ?? file.maxRetryAttempts, 3), emitStreamChunks: bool(process.env.ARGUS_FORGE_EMIT_STREAM_CHUNKS ?? file.emitStreamChunks, false), logLevel: logLevel(process.env.ARGUS_FORGE_LOG_LEVEL ?? file.logLevel), httpRequestLogDetails: bool(process.env.ARGUS_FORGE_HTTP_REQUEST_LOG_DETAILS ?? file.httpRequestLogDetails, false) }; }
function settings(): Record<string, unknown> { const path = join(dirname(fileURLToPath(import.meta.url)), "..", "argus-forge.settings.json"); if (!existsSync(path)) return {}; try { return record(JSON.parse(readFileSync(path, "utf8"))) ?? {}; } catch (e) { console.warn(`[argus-forge] invalid settings: ${errorMessage(e)}`); return {}; } }
function setting(env: string, file: unknown, fallback: string) { return process.env[env] || str(file) || fallback; }
function positive(value: unknown, fallback: number) { const n = typeof value === "number" ? value : Number.parseInt(str(value) ?? "", 10); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback; }
function bool(value: unknown, fallback: boolean) { return typeof value === "boolean" ? value : typeof value === "string" ? /^(1|true)$/i.test(value) : fallback; }
function logLevel(value: unknown): Config["logLevel"] { return typeof value === "string" && value in levels ? value as Config["logLevel"] : "warn"; }
function log(config: Config, level: Level, message: string) { if (levels[level] >= levels[config.logLevel]) (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[argus-forge] ${message}`); }
function stableId(...parts: unknown[]) { const input = parts.map(x => typeof x === "string" ? x : safeJson(x, 1000)).join("|"); let h = 0x811c9dc5; for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193); } return `opencode-${(h >>> 0).toString(16).padStart(8, "0")}`; }
function iso(value?: unknown) { const date = typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : new Date(); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); }
function duration(start: string, end: string) { return Math.max(0, new Date(end).getTime() - new Date(start).getTime()); }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function str(value: unknown) { return typeof value === "string" && value ? value : undefined; }
function num(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function redact(value: unknown, seen = new WeakSet<object>()): unknown { if (value === null || typeof value !== "object") return value; if (seen.has(value)) return "[Circular]"; seen.add(value); if (Array.isArray(value)) return value.slice(0, 50).map(x => redact(x, seen)); return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? "[REDACTED]" : redact(v, seen)])); }
function toJson(value: unknown): Json { if (value === null || typeof value === "string" || typeof value === "boolean") return value; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (Array.isArray(value)) return value.map(toJson); if (record(value)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJson(v)])); return String(value); }
function jsonObject(value: Record<string, unknown>): Meta { return Object.fromEntries(Object.entries(redact(value) as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toJson(v)])); }
function safeJson(value: unknown, max: number) { try { return truncate(JSON.stringify(redact(value)) ?? String(value), max); } catch { return "[Unserializable]"; } }
function summarize(value: unknown, max: number) { return value == null ? undefined : truncate(typeof value === "string" ? value : safeJson(value, max), max); }
function truncate(value: string, max: number) { return value.length <= max ? value : `${value.slice(0, max - 3)}...`; }
function basename(path: string) { return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "project"; }
function slug(path: string) { return basename(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || stableId("project", path); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function failure(output: unknown) { const out = record(output); const metadata = record(out?.metadata); return Boolean(out?.error || metadata?.error || metadata?.exitCode && metadata.exitCode !== 0); }
function failureMessage(output: unknown) { const out = record(output), metadata = record(out?.metadata); return str(out?.error) ?? str(metadata?.error) ?? `OpenCode tool failed${metadata?.exitCode !== undefined ? ` with exit code ${metadata.exitCode}` : ""}`; }

export const _test = { stableId, redact, safeJson, iso, failure };
