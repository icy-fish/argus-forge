import { prisma } from "./db.js";
import { IngestService } from "./services/ingestService.js";
import type { AgentEvent } from "@argus-forge/shared";

function iso(offsetMs: number) {
  return new Date(Date.now() - 60 * 60 * 1000 + offsetMs).toISOString();
}

function makeSession(index: number): AgentEvent[] {
  const sessionId = `seed-session-${index}`;
  const agentName = index % 2 === 0 ? "codex" : "local-agent";
  const projectId = "argus-forge-demo";
  const events: AgentEvent[] = [
    {
      type: "session.started",
      eventId: `${sessionId}-start`,
      sessionId,
      timestamp: iso(index * 120000),
      agentName,
      projectId,
      projectName: "Argus Forge",
      title: `Seed trace ${index}`,
      status: "running",
      spanId: sessionId
    }
  ];

  for (let i = 0; i < 4; i += 1) {
    const base = index * 120000 + i * 20000;
    const llmSpan = `${sessionId}-llm-${i}`;
    const toolSpan = `${sessionId}-tool-${i}`;
    const provider = i % 2 === 0 ? "openai" : "anthropic";
    const model = provider === "openai" ? "gpt-4o-mini" : "claude-3-5-sonnet";
    const failed = index === 3 && i === 2;
    events.push({
      type: "llm.request.started",
      eventId: `${llmSpan}-start`,
      sessionId,
      timestamp: iso(base + 1000),
      agentName,
      projectId,
      spanId: llmSpan,
      parentSpanId: sessionId,
      provider,
      model,
      requestId: llmSpan,
      status: "running"
    });
    events.push({
      type: failed ? "llm.request.failed" : "llm.request.completed",
      eventId: `${llmSpan}-${failed ? "fail" : "done"}`,
      sessionId,
      timestamp: iso(base + 3000 + i * 150),
      agentName,
      projectId,
      spanId: llmSpan,
      parentSpanId: sessionId,
      provider,
      model,
      requestId: llmSpan,
      status: failed ? "failed" : "completed",
      promptTokens: 900 + index * 20 + i * 50,
      completionTokens: failed ? 0 : 220 + i * 30,
      cachedTokens: i * 25,
      latencyMs: 1800 + i * 300,
      finishReason: failed ? undefined : "stop",
      errorMessage: failed ? "model timeout" : undefined
    } as AgentEvent);
    events.push({
      type: "tool.call.completed",
      eventId: `${toolSpan}-done`,
      sessionId,
      timestamp: iso(base + 5000 + i * 200),
      agentName,
      projectId,
      spanId: toolSpan,
      parentSpanId: llmSpan,
      toolName: i % 2 === 0 ? "shell_command" : "apply_patch",
      callId: toolSpan,
      status: "completed",
      argumentsSummary: i % 2 === 0 ? "run verification command" : "edit source file",
      resultSummary: "completed",
      exitStatus: "0",
      latencyMs: 400 + i * 90
    });
    events.push({
      type: "agent.log",
      eventId: `${sessionId}-log-${i}`,
      sessionId,
      timestamp: iso(base + 6000),
      agentName,
      projectId,
      level: failed ? "warn" : "info",
      message: failed ? "Retrying after model timeout" : "Step completed"
    });
  }

  events.push({
    type: "session.updated",
    eventId: `${sessionId}-complete`,
    sessionId,
    timestamp: iso(index * 120000 + 95000),
    agentName,
    projectId,
    spanId: sessionId,
    status: index === 3 ? "failed" : "completed",
    endedAt: iso(index * 120000 + 95000)
  });
  return events;
}

async function main() {
  const service = new IngestService(prisma);
  const events = Array.from({ length: 5 }, (_, index) => makeSession(index + 1)).flat();
  await service.ingestEvents(events);
  const [sessions, llms, tools] = await Promise.all([prisma.session.count(), prisma.llmRequest.count(), prisma.toolCall.count()]);
  console.log(`Seeded ${sessions} sessions, ${llms} LLM requests, ${tools} tool calls`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
