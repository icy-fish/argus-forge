import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { SessionService } from "../src/services/sessionService.js";
import { event, service } from "./helpers.js";

describe("sessions", () => {
  it("lists sessions with pagination and metrics", async () => {
    await service.ingestEvents([event({ sessionId: "a", eventId: "a1", spanId: "a-span" }), event({ sessionId: "b", eventId: "b1", spanId: "b-span", timestamp: "2026-01-01T00:01:00.000Z" })]);
    const sessions = await new SessionService(prisma).list({ page: 1, pageSize: 1 });
    expect(sessions.page.total).toBe(2);
    expect(sessions.data[0].id).toBe("b");
    expect(sessions.data[0].totalTokens).toBe(150);
  });

  it("returns detail, ordered timeline, and nested parent-child spans", async () => {
    await service.ingestEvents([
      { type: "session.started", eventId: "s", sessionId: "session-1", timestamp: "2026-01-01T00:00:00.000Z", agentName: "test-agent", spanId: "session-1", status: "running" },
      event({ eventId: "llm", timestamp: "2026-01-01T00:00:01.000Z", requestMetadata: { requestPreview: { messages: [{ role: "user", content: "hello" }] } } }),
      event({ type: "tool.call.completed", eventId: "tool", spanId: "tool-1", parentSpanId: "span-1", timestamp: "2026-01-01T00:00:02.000Z", toolName: "apply_patch", status: "completed" } as never)
    ]);
    const svc = new SessionService(prisma);
    const detail = await svc.detail("session-1");
    const timeline = await svc.timeline("session-1");
    const metrics = await svc.metricsForSession("session-1");
    expect(detail.data.id).toBe("session-1");
    expect(timeline.data.events.map((item) => item.eventId)).toEqual(["s", "llm", "tool"]);
    expect(timeline.data.spans[0].children[0].requestMetadata).toEqual({ requestPreview: { messages: [{ role: "user", content: "hello" }] } });
    expect(timeline.data.spans[0].children[0].children[0].toolName).toBe("apply_patch");
    expect(metrics.data.llmRequests).toBe(1);
  });
});
