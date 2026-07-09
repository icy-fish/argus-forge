import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { MetricService } from "../src/services/metricService.js";
import { event, service } from "./helpers.js";

describe("metrics", () => {
  it("calculates totals, distributions, percentiles, and throughput", async () => {
    await service.ingestEvents([
      event(),
      event({ eventId: "evt-2", spanId: "span-2", provider: "openai", model: "gpt-4o-mini", promptTokens: 200, completionTokens: 100, latencyMs: 2400 }),
      event({ eventId: "evt-3", spanId: "tool-1", type: "tool.call.completed", toolName: "shell_command", status: "completed", latencyMs: 500 } as never),
      event({ eventId: "evt-4", spanId: "tool-2", type: "tool.call.failed", toolName: "shell_command", status: "failed", latencyMs: 900, errorMessage: "failed" } as never)
    ]);
    const metrics = new MetricService(prisma);
    const summary = await metrics.summary();
    const tools = await metrics.tools();
    const models = await metrics.models();
    const latency = await metrics.latency();
    const throughput = await metrics.throughput();

    expect(summary.totalTokens).toBe(450);
    expect(summary.llmRequests).toBe(2);
    expect(summary.toolCalls).toBe(2);
    expect(summary.errorCount).toBe(1);
    expect(summary.estimatedCostUsd).not.toBeNull();
    expect(tools[0]).toMatchObject({ toolName: "shell_command", count: 2, errorCount: 1 });
    expect(models[0]).toMatchObject({ provider: "openai", model: "gpt-4o-mini", requestCount: 2 });
    expect(latency.p95LatencyMs).toBe(2400);
    expect(throughput[0].requestCount).toBe(2);
  });

  it("filters by project and time range", async () => {
    await service.ingestEvents([
      event({ sessionId: "session-a", projectId: "project-a", eventId: "a", spanId: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
      event({ sessionId: "session-b", projectId: "project-b", eventId: "b", spanId: "b", timestamp: "2026-01-02T00:00:00.000Z" })
    ]);
    const summary = await new MetricService(prisma).summary({ projectId: "project-a", from: new Date("2025-12-31T00:00:00.000Z"), to: new Date("2026-01-01T12:00:00.000Z") });
    expect(summary.llmRequests).toBe(1);
  });
});
