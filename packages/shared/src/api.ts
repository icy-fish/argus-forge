export type ErrorResponse = {
  error: { code: string; message: string; details?: unknown };
};

export type PageInfo = {
  page: number;
  pageSize: number;
  total: number;
};

export type SessionListItem = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  agentName: string;
  title: string | null;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string;
  durationMs: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  llmRequestCount: number;
  toolCallCount: number;
  errorCount: number;
};

export type SessionListResponse = { data: SessionListItem[]; page: PageInfo };
export type SessionDetailResponse = { data: SessionListItem & { metadata?: unknown } };

export type TimelineEvent = {
  id: number;
  eventId: string;
  type: string;
  timestamp: string;
  raw: unknown;
};

export type TraceSpan = {
  id: string;
  parentSpanId: string | null;
  sessionId: string;
  type: "session" | "llm" | "tool" | "log";
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  provider?: string | null;
  model?: string | null;
  toolName?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number | null;
  errorMessage?: string | null;
  events: TimelineEvent[];
  children: TraceSpan[];
};

export type TimelineResponse = { data: { spans: TraceSpan[]; events: TimelineEvent[] } };

export type MetricsTotals = {
  sessions: number;
  llmRequests: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  throughputPerMinute: number;
  errorRate: number;
  errorCount: number;
};

export type MetricsSummaryResponse = { data: MetricsTotals };
export type SessionMetricsResponse = { data: MetricsTotals };

export type ToolMetricsItem = { toolName: string; count: number; errorCount: number; averageLatencyMs: number | null };
export type ToolMetricsResponse = { data: ToolMetricsItem[] };

export type ModelMetricsItem = {
  provider: string;
  model: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};
export type ModelMetricsResponse = { data: ModelMetricsItem[] };

export type LatencyBucket = { label: string; minMs: number; maxMs: number | null; llmRequests: number; toolCalls: number };
export type LatencyMetricsResponse = {
  data: { buckets: LatencyBucket[]; averageLatencyMs: number | null; p50LatencyMs: number | null; p95LatencyMs: number | null };
};

export type ThroughputPoint = { bucketStart: string; requestCount: number; generatedTokens: number };
export type ThroughputResponse = { data: ThroughputPoint[] };

export type IngestResponse = { inserted: number; duplicates: number; processed: number };
