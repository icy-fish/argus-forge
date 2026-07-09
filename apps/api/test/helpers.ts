import { beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { IngestService } from "../src/services/ingestService.js";
import type { AgentEvent } from "@argus-forge/shared";

export const service = new IngestService(prisma);

export function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "llm.request.completed",
    eventId: "evt-1",
    sessionId: "session-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    agentName: "test-agent",
    projectId: "project-a",
    spanId: "span-1",
    parentSpanId: "session-1",
    provider: "openai",
    model: "gpt-4o-mini",
    status: "completed",
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 10,
    latencyMs: 1200,
    ...overrides
  } as AgentEvent;
}

beforeEach(async () => {
  await prisma.agentEvent.deleteMany();
  await prisma.usageMetric.deleteMany();
  await prisma.llmRequest.deleteMany();
  await prisma.toolCall.deleteMany();
  await prisma.span.deleteMany();
  await prisma.session.deleteMany();
  await prisma.project.deleteMany();
});
