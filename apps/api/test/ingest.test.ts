import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { event, service } from "./helpers.js";

describe("ingestion", () => {
  it("accepts valid single and batch events", async () => {
    const single = await service.ingestSingle(event());
    const batch = await service.ingestBatch({
      events: [
        event({ eventId: "evt-2", spanId: "span-2", type: "tool.call.completed", toolName: "shell_command", status: "completed", latencyMs: 300 } as never),
        event({ eventId: "evt-3", spanId: "span-3", type: "agent.log", level: "info", message: "hello" } as never)
      ]
    });
    expect(single.inserted).toBe(1);
    expect(batch.inserted).toBe(2);
    expect(await prisma.agentEvent.count()).toBe(3);
  });

  it("ignores duplicate event ids", async () => {
    await service.ingestSingle(event());
    const duplicate = await service.ingestSingle(event());
    expect(duplicate.inserted).toBe(0);
    expect(duplicate.duplicates).toBe(1);
    expect(await prisma.agentEvent.count()).toBe(1);
    expect(await prisma.llmRequest.count()).toBe(1);
    expect(await prisma.usageMetric.count()).toBe(1);
  });

  it("rejects missing required fields", async () => {
    await expect(service.ingestSingle({ type: "llm.request.completed" })).rejects.toThrow();
  });

  it("pairs start and completion lifecycle events", async () => {
    await service.ingestEvents([
      event({ type: "llm.request.started", eventId: "start", status: "running", promptTokens: undefined, completionTokens: undefined, latencyMs: undefined }),
      event({ eventId: "done", timestamp: "2026-01-01T00:00:02.000Z" })
    ]);
    const llm = await prisma.llmRequest.findUniqueOrThrow({ where: { spanId: "span-1" } });
    expect(llm.status).toBe("completed");
    expect(llm.latencyMs).toBe(1200);
    expect(llm.totalTokens).toBe(150);
  });
});
