import type { Prisma, PrismaClient } from "@prisma/client";
import type { MetricsTotals } from "@argus-forge/shared";
import { percentile, type TimeRange } from "../utils/time.js";

function sessionWhere(range: TimeRange): Prisma.SessionWhereInput {
  return {
    projectId: range.projectId,
    lastEventAt: { gte: range.from, lte: range.to }
  };
}

function llmWhere(range: TimeRange, sessionId?: string): Prisma.LlmRequestWhereInput {
  return {
    sessionId,
    session: { projectId: range.projectId },
    startedAt: { gte: range.from, lte: range.to }
  };
}

function toolWhere(range: TimeRange, sessionId?: string): Prisma.ToolCallWhereInput {
  return {
    sessionId,
    session: { projectId: range.projectId },
    startedAt: { gte: range.from, lte: range.to }
  };
}

function avg(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export class MetricService {
  constructor(private readonly db: PrismaClient) {}

  async summary(range: TimeRange = {}, sessionId?: string): Promise<MetricsTotals> {
    const [sessions, llms, tools] = await Promise.all([
      sessionId ? Promise.resolve(1) : this.db.session.count({ where: sessionWhere(range) }),
      this.db.llmRequest.findMany({ where: llmWhere(range, sessionId) }),
      this.db.toolCall.findMany({ where: toolWhere(range, sessionId) })
    ]);

    const promptTokens = llms.reduce((sum, item) => sum + item.promptTokens, 0);
    const completionTokens = llms.reduce((sum, item) => sum + item.completionTokens, 0);
    const cachedTokens = llms.reduce((sum, item) => sum + item.cachedTokens, 0);
    const estimatedCosts = llms.map((item) => item.estimatedCostUsd).filter((value): value is number => value != null);
    const latencies = [...llms.map((item) => item.latencyMs), ...tools.map((item) => item.latencyMs)].filter((value): value is number => value != null);
    const errorCount = llms.filter((item) => item.status === "failed").length + tools.filter((item) => item.status === "failed").length;
    const first = llms[0]?.startedAt ?? tools[0]?.startedAt;
    const last = [...llms, ...tools].reduce<Date | null>((latest, item) => (!latest || item.startedAt > latest ? item.startedAt : latest), first ?? null);
    const minutes = first && last ? Math.max(1, (last.getTime() - first.getTime()) / 60000) : 1;
    const totalOps = llms.length + tools.length;

    return {
      sessions,
      llmRequests: llms.length,
      toolCalls: tools.length,
      promptTokens,
      completionTokens,
      cachedTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: estimatedCosts.length ? Number(estimatedCosts.reduce((sum, value) => sum + value, 0).toFixed(8)) : null,
      averageLatencyMs: avg(latencies),
      p95LatencyMs: percentile(latencies, 95),
      throughputPerMinute: Number((llms.length / minutes).toFixed(2)),
      errorRate: totalOps ? Number((errorCount / totalOps).toFixed(4)) : 0,
      errorCount
    };
  }

  async tools(range: TimeRange = {}) {
    const tools = await this.db.toolCall.findMany({ where: toolWhere(range) });
    const groups = new Map<string, { toolName: string; count: number; errorCount: number; latencies: number[] }>();
    for (const tool of tools) {
      const group = groups.get(tool.toolName) ?? { toolName: tool.toolName, count: 0, errorCount: 0, latencies: [] };
      group.count += 1;
      if (tool.status === "failed") group.errorCount += 1;
      if (tool.latencyMs != null) group.latencies.push(tool.latencyMs);
      groups.set(tool.toolName, group);
    }
    return [...groups.values()].map((group) => ({
      toolName: group.toolName,
      count: group.count,
      errorCount: group.errorCount,
      averageLatencyMs: avg(group.latencies)
    }));
  }

  async models(range: TimeRange = {}) {
    const llms = await this.db.llmRequest.findMany({ where: llmWhere(range) });
    const groups = new Map<string, { provider: string; model: string; requestCount: number; promptTokens: number; completionTokens: number; estimatedCostUsd: number | null }>();
    for (const llm of llms) {
      const key = `${llm.provider}:${llm.model}`;
      const group = groups.get(key) ?? { provider: llm.provider, model: llm.model, requestCount: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: null };
      group.requestCount += 1;
      group.promptTokens += llm.promptTokens;
      group.completionTokens += llm.completionTokens;
      if (llm.estimatedCostUsd != null) group.estimatedCostUsd = (group.estimatedCostUsd ?? 0) + llm.estimatedCostUsd;
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...group, totalTokens: group.promptTokens + group.completionTokens, estimatedCostUsd: group.estimatedCostUsd == null ? null : Number(group.estimatedCostUsd.toFixed(8)) }));
  }

  async latency(range: TimeRange = {}) {
    const [llms, tools] = await Promise.all([
      this.db.llmRequest.findMany({ where: llmWhere(range), select: { latencyMs: true } }),
      this.db.toolCall.findMany({ where: toolWhere(range), select: { latencyMs: true } })
    ]);
    const specs = [
      { label: "0-1s", minMs: 0, maxMs: 1000 },
      { label: "1-3s", minMs: 1000, maxMs: 3000 },
      { label: "3-10s", minMs: 3000, maxMs: 10000 },
      { label: "10s+", minMs: 10000, maxMs: null }
    ];
    const llmLatencies = llms.map((item) => item.latencyMs).filter((value): value is number => value != null);
    const toolLatencies = tools.map((item) => item.latencyMs).filter((value): value is number => value != null);
    const all = [...llmLatencies, ...toolLatencies];
    return {
      buckets: specs.map((spec) => ({
        ...spec,
        llmRequests: llmLatencies.filter((value) => value >= spec.minMs && (spec.maxMs == null || value < spec.maxMs)).length,
        toolCalls: toolLatencies.filter((value) => value >= spec.minMs && (spec.maxMs == null || value < spec.maxMs)).length
      })),
      averageLatencyMs: avg(all),
      p50LatencyMs: percentile(all, 50),
      p95LatencyMs: percentile(all, 95)
    };
  }

  async throughput(range: TimeRange = {}) {
    const llms = await this.db.llmRequest.findMany({ where: llmWhere(range), orderBy: { startedAt: "asc" } });
    const groups = new Map<string, { bucketStart: string; requestCount: number; generatedTokens: number }>();
    for (const llm of llms) {
      const bucket = new Date(llm.startedAt);
      bucket.setSeconds(0, 0);
      const key = bucket.toISOString();
      const group = groups.get(key) ?? { bucketStart: key, requestCount: 0, generatedTokens: 0 };
      group.requestCount += 1;
      group.generatedTokens += llm.completionTokens;
      groups.set(key, group);
    }
    return [...groups.values()];
  }
}
