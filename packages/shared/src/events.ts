import { z } from "zod";

export const eventTypes = [
  "session.started",
  "session.updated",
  "llm.request.started",
  "llm.request.completed",
  "llm.request.failed",
  "llm.stream.chunk",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "agent.log"
] as const;

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)])
);

const metadataSchema = z.record(jsonValue).default({});

const common = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string().datetime(),
  agentName: z.string().min(1),
  projectId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  metadata: metadataSchema.optional()
});

const sessionStarted = common.extend({
  type: z.literal("session.started"),
  projectName: z.string().optional(),
  title: z.string().optional(),
  status: z.enum(["running", "completed", "failed"]).default("running")
});

const sessionUpdated = common.extend({
  type: z.literal("session.updated"),
  title: z.string().optional(),
  status: z.enum(["running", "completed", "failed"]).optional(),
  endedAt: z.string().datetime().optional()
});

const llmBase = common.extend({
  provider: z.string().min(1),
  model: z.string().min(1),
  requestId: z.string().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  inputBytes: z.number().int().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  finishReason: z.string().optional(),
  requestMetadata: metadataSchema.optional()
});

const llmStarted = llmBase.extend({
  type: z.literal("llm.request.started"),
  status: z.literal("running").default("running")
});

const llmCompleted = llmBase.extend({
  type: z.literal("llm.request.completed"),
  status: z.literal("completed").default("completed")
});

const llmFailed = llmBase.extend({
  type: z.literal("llm.request.failed"),
  status: z.literal("failed").default("failed"),
  errorCode: z.string().optional(),
  errorMessage: z.string().min(1)
});

const llmChunk = common.extend({
  type: z.literal("llm.stream.chunk"),
  provider: z.string().optional(),
  model: z.string().optional(),
  requestId: z.string().optional(),
  chunkIndex: z.number().int().nonnegative().optional(),
  contentBytes: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  textPreview: z.string().max(500).optional()
});

const toolBase = common.extend({
  toolName: z.string().min(1),
  callId: z.string().optional(),
  argumentsSummary: z.string().max(2000).optional(),
  redactedArguments: jsonValue.optional(),
  resultSummary: z.string().max(2000).optional(),
  exitStatus: z.string().optional(),
  latencyMs: z.number().nonnegative().optional()
});

const toolStarted = toolBase.extend({
  type: z.literal("tool.call.started"),
  status: z.literal("running").default("running")
});

const toolCompleted = toolBase.extend({
  type: z.literal("tool.call.completed"),
  status: z.literal("completed").default("completed")
});

const toolFailed = toolBase.extend({
  type: z.literal("tool.call.failed"),
  status: z.literal("failed").default("failed"),
  errorCode: z.string().optional(),
  errorMessage: z.string().min(1)
});

const agentLog = common.extend({
  type: z.literal("agent.log"),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  message: z.string().min(1)
});

export const agentEventSchema = z.discriminatedUnion("type", [
  sessionStarted,
  sessionUpdated,
  llmStarted,
  llmCompleted,
  llmFailed,
  llmChunk,
  toolStarted,
  toolCompleted,
  toolFailed,
  agentLog
]);

export const eventBatchSchema = z.object({
  events: z.array(agentEventSchema).min(1).max(500)
});

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventBatch = z.infer<typeof eventBatchSchema>;
export type EventType = AgentEvent["type"];
export type EventStatus = "running" | "completed" | "failed";
