import type { PrismaClient } from "@prisma/client";
import type { SessionListItem, TraceSpan } from "@argus-forge/shared";
import { NotFoundError } from "../utils/errors.js";
import { durationMs, type TimeRange } from "../utils/time.js";
import { MetricService } from "./metricService.js";

function parseJsonText(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function costSum(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? Number(known.reduce((sum, value) => sum + value, 0).toFixed(8)) : null;
}

export class SessionService {
  private readonly metrics: MetricService;

  constructor(private readonly db: PrismaClient) {
    this.metrics = new MetricService(db);
  }

  async list(input: TimeRange & { page?: number; pageSize?: number; search?: string }) {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 20));
    const where = {
      projectId: input.projectId,
      lastEventAt: { gte: input.from, lte: input.to },
      OR: input.search
        ? [{ id: { contains: input.search } }, { title: { contains: input.search } }, { agentName: { contains: input.search } }]
        : undefined
    };
    const [total, sessions] = await Promise.all([
      this.db.session.count({ where }),
      this.db.session.findMany({
        where,
        orderBy: [{ lastEventAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { llmRequests: true, toolCalls: true }
      })
    ]);

    return { data: sessions.map(toListItem), page: { page, pageSize, total } };
  }

  async detail(id: string) {
    const session = await this.db.session.findUnique({ where: { id }, include: { llmRequests: true, toolCalls: true } });
    if (!session) throw new NotFoundError(`Session ${id} was not found`);
    return { data: { ...toListItem(session), metadata: parseJsonText(session.metadata) } };
  }

  async timeline(id: string) {
    const session = await this.db.session.findUnique({ where: { id } });
    if (!session) throw new NotFoundError(`Session ${id} was not found`);
    const [spans, events] = await Promise.all([
      this.db.span.findMany({
        where: { sessionId: id },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        include: { llmRequest: true, toolCall: true, agentEvents: { orderBy: [{ timestamp: "asc" }, { id: "asc" }] } }
      }),
      this.db.agentEvent.findMany({ where: { sessionId: id }, orderBy: [{ timestamp: "asc" }, { id: "asc" }] })
    ]);

    const eventDtos = events.map((event) => ({
      id: event.id,
      eventId: event.eventId,
      type: event.type,
      timestamp: event.timestamp.toISOString(),
      raw: parseJsonText(event.raw)
    }));

    const spanMap = new Map<string, TraceSpan>();
    for (const span of spans) {
      spanMap.set(span.id, {
        id: span.id,
        parentSpanId: span.parentSpanId,
        sessionId: span.sessionId,
        type: span.type as TraceSpan["type"],
        name: span.name,
        status: span.status as TraceSpan["status"],
        startedAt: span.startedAt.toISOString(),
        endedAt: span.endedAt?.toISOString() ?? null,
        durationMs: span.durationMs,
        provider: span.llmRequest?.provider,
        model: span.llmRequest?.model,
        toolName: span.toolCall?.toolName,
        promptTokens: span.llmRequest?.promptTokens,
        completionTokens: span.llmRequest?.completionTokens,
        totalTokens: span.llmRequest?.totalTokens,
        estimatedCostUsd: span.llmRequest?.estimatedCostUsd,
        errorMessage: span.errorMessage ?? span.llmRequest?.errorMessage ?? span.toolCall?.errorMessage,
        events: span.agentEvents.map((event) => ({
          id: event.id,
          eventId: event.eventId,
          type: event.type,
          timestamp: event.timestamp.toISOString(),
          raw: parseJsonText(event.raw)
        })),
        children: []
      });
    }

    const roots: TraceSpan[] = [];
    for (const span of spanMap.values()) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        spanMap.get(span.parentSpanId)!.children.push(span);
      } else {
        roots.push(span);
      }
    }

    return { data: { spans: roots, events: eventDtos } };
  }

  async metricsForSession(id: string) {
    const exists = await this.db.session.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundError(`Session ${id} was not found`);
    return { data: await this.metrics.summary({}, id) };
  }
}

function toListItem(session: {
  id: string;
  projectId: string | null;
  projectName: string | null;
  agentName: string;
  title: string | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
  llmRequests: Array<{ promptTokens: number; completionTokens: number; cachedTokens: number; estimatedCostUsd: number | null; status: string }>;
  toolCalls: Array<{ status: string }>;
}): SessionListItem {
  const promptTokens = session.llmRequests.reduce((sum, item) => sum + item.promptTokens, 0);
  const completionTokens = session.llmRequests.reduce((sum, item) => sum + item.completionTokens, 0);
  const cachedTokens = session.llmRequests.reduce((sum, item) => sum + item.cachedTokens, 0);
  const errorCount = session.llmRequests.filter((item) => item.status === "failed").length + session.toolCalls.filter((item) => item.status === "failed").length;

  return {
    id: session.id,
    projectId: session.projectId,
    projectName: session.projectName,
    agentName: session.agentName,
    title: session.title,
    status: session.status as SessionListItem["status"],
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    lastEventAt: session.lastEventAt.toISOString(),
    durationMs: durationMs(session.startedAt, session.endedAt ?? session.lastEventAt),
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: costSum(session.llmRequests.map((item) => item.estimatedCostUsd)),
    llmRequestCount: session.llmRequests.length,
    toolCallCount: session.toolCalls.length,
    errorCount
  };
}
