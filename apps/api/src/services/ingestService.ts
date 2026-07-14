import type { Prisma, PrismaClient } from "@prisma/client";
import { agentEventSchema, eventBatchSchema, estimateCostUsd, type AgentEvent } from "@argus-forge/shared";
import { durationMs, parseTimestamp } from "../utils/time.js";

type IngestResult = { inserted: number; duplicates: number; processed: number };

function jsonText(value: unknown): string | undefined {
  return value == null ? undefined : JSON.stringify(value);
}

function parseJsonText(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function mergeMetadata(existing: string | null | undefined, next: unknown): string | undefined {
  if (next == null) return undefined;
  const previous = parseJsonText(existing);
  if (previous && typeof previous === "object" && !Array.isArray(previous) && typeof next === "object" && !Array.isArray(next)) {
    return jsonText({ ...previous, ...next });
  }
  return jsonText(next);
}

function eventSpanId(event: AgentEvent): string {
  return event.spanId ?? `${event.sessionId}:${event.type}:${"requestId" in event && event.requestId ? event.requestId : "callId" in event && event.callId ? event.callId : event.eventId}`;
}

function eventParentSpanId(event: AgentEvent): string | undefined {
  return event.parentSpanId ?? (event.type === "session.started" || event.type === "session.updated" ? undefined : event.sessionId);
}

function isTerminal(status: string | undefined): status is "completed" | "failed" {
  return status === "completed" || status === "failed";
}

export class IngestService {
  constructor(private readonly db: PrismaClient) {}

  async ingestSingle(payload: unknown): Promise<IngestResult> {
    const event = agentEventSchema.parse(payload);
    return this.ingestEvents([event]);
  }

  async ingestBatch(payload: unknown): Promise<IngestResult> {
    const batch = eventBatchSchema.parse(payload);
    return this.ingestEvents(batch.events);
  }

  async ingestEvents(events: AgentEvent[]): Promise<IngestResult> {
    let duplicates = 0;
    let inserted = 0;

    await this.db.$transaction(async (tx) => {
      for (const event of events) {
        const duplicate = await tx.agentEvent.findUnique({ where: { eventId: event.eventId }, select: { id: true } });
        if (duplicate) {
          duplicates += 1;
          continue;
        }

        await this.upsertProject(tx, event);
        await this.upsertSession(tx, event);
        const spanId = await this.upsertSpan(tx, event);

        await tx.agentEvent.create({
          data: {
            eventId: event.eventId,
            sessionId: event.sessionId,
            spanId,
            type: event.type,
            timestamp: parseTimestamp(event.timestamp),
            agentName: event.agentName,
            projectId: event.projectId,
            raw: JSON.stringify(event)
          }
        });

        if (event.type.startsWith("llm.request") || event.type === "llm.stream.chunk") {
          await this.upsertLlmRequest(tx, event, spanId);
        }
        if (event.type.startsWith("tool.call")) {
          await this.upsertToolCall(tx, event, spanId);
        }

        inserted += 1;
      }
    });

    return { inserted, duplicates, processed: events.length };
  }

  private async upsertProject(tx: Prisma.TransactionClient, event: AgentEvent) {
    if (!event.projectId) return;
    await tx.project.upsert({
      where: { id: event.projectId },
      update: { name: "projectName" in event ? event.projectName : undefined },
      create: { id: event.projectId, name: "projectName" in event ? event.projectName : undefined }
    });
  }

  private async upsertSession(tx: Prisma.TransactionClient, event: AgentEvent) {
    const timestamp = parseTimestamp(event.timestamp);
    const endedAt = "endedAt" in event && event.endedAt ? parseTimestamp(event.endedAt) : undefined;
    const status = "status" in event && event.status ? event.status : event.type.includes("failed") ? "failed" : "running";

    await tx.session.upsert({
      where: { id: event.sessionId },
      update: {
        projectId: event.projectId,
        projectName: "projectName" in event ? event.projectName : undefined,
        agentName: event.agentName,
        title: "title" in event ? event.title : undefined,
        status: isTerminal(status) ? status : undefined,
        endedAt,
        lastEventAt: timestamp,
        metadata: jsonText(event.metadata)
      },
      create: {
        id: event.sessionId,
        projectId: event.projectId,
        projectName: "projectName" in event ? event.projectName : undefined,
        agentName: event.agentName,
        title: "title" in event ? event.title : null,
        status,
        startedAt: timestamp,
        endedAt,
        lastEventAt: timestamp,
        metadata: jsonText(event.metadata)
      }
    });
  }

  private async upsertSpan(tx: Prisma.TransactionClient, event: AgentEvent): Promise<string | null> {
    if (event.type === "agent.log") return null;
    const id = event.type.startsWith("session.") ? event.sessionId : eventSpanId(event);
    const startedAt = parseTimestamp(event.timestamp);
    const existing = await tx.span.findUnique({ where: { id } });
    let parentSpanId = eventParentSpanId(event);
    if (parentSpanId === event.sessionId && id !== event.sessionId) {
      await tx.span.upsert({
        where: { id: event.sessionId },
        update: { startedAt: { set: startedAt } },
        create: {
          id: event.sessionId,
          sessionId: event.sessionId,
          type: "session",
          name: event.sessionId,
          status: "running",
          startedAt
        }
      });
    } else if (parentSpanId) {
      const parent = await tx.span.findUnique({ where: { id: parentSpanId }, select: { id: true } });
      if (!parent) parentSpanId = undefined;
    }
    const status = "status" in event && event.status ? event.status : event.type.includes("failed") ? "failed" : "running";
    const endedAt = isTerminal(status) ? startedAt : null;
    const type = event.type.startsWith("llm.") ? "llm" : event.type.startsWith("tool.") ? "tool" : "session";
    const name =
      type === "llm" && "model" in event ? `${event.provider}/${event.model}` : type === "tool" && "toolName" in event ? event.toolName : event.sessionId;

    if (!existing) {
      await tx.span.create({
        data: {
          id,
          sessionId: event.sessionId,
          parentSpanId,
          type,
          name,
          status,
          startedAt,
          endedAt,
          durationMs: durationMs(startedAt, endedAt),
          errorMessage: "errorMessage" in event ? event.errorMessage : null,
          metadata: jsonText(event.metadata)
        }
      });
      return id;
    }

    await tx.span.update({
      where: { id },
      data: {
        status: isTerminal(status) ? status : existing.status,
        endedAt: endedAt ?? existing.endedAt,
        durationMs: endedAt ? durationMs(existing.startedAt, endedAt) : existing.durationMs,
        errorMessage: "errorMessage" in event ? event.errorMessage : existing.errorMessage,
        metadata: jsonText(event.metadata)
      }
    });
    return id;
  }

  private async upsertLlmRequest(tx: Prisma.TransactionClient, event: AgentEvent, spanId: string | null) {
    if (!spanId || !("provider" in event) || !event.provider || !("model" in event) || !event.model) return;
    const existing = await tx.llmRequest.findUnique({ where: { spanId } });
    const timestamp = parseTimestamp(event.timestamp);
    const status = "status" in event && event.status ? event.status : existing?.status ?? "running";
    const endedAt = isTerminal(status) ? timestamp : existing?.endedAt ?? null;
    const promptTokens = "promptTokens" in event ? event.promptTokens ?? existing?.promptTokens ?? 0 : existing?.promptTokens ?? 0;
    const completionTokens =
      "completionTokens" in event ? event.completionTokens ?? existing?.completionTokens ?? 0 : existing?.completionTokens ?? 0;
    const cachedTokens = "cachedTokens" in event ? event.cachedTokens ?? existing?.cachedTokens ?? 0 : existing?.cachedTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;
    const estimatedCostUsd = estimateCostUsd({ provider: event.provider, model: event.model, promptTokens, completionTokens, cachedTokens });
    const latencyMs = "latencyMs" in event && event.latencyMs != null ? Math.round(event.latencyMs) : endedAt && existing ? durationMs(existing.startedAt, endedAt) : null;

    const data = {
      sessionId: event.sessionId,
      spanId,
      provider: event.provider,
      model: event.model,
      requestId: "requestId" in event ? event.requestId : undefined,
      status,
      endedAt,
      latencyMs,
      promptTokens,
      completionTokens,
      cachedTokens,
      inputBytes: "inputBytes" in event ? event.inputBytes : undefined,
      outputBytes: "outputBytes" in event ? event.outputBytes : undefined,
      totalTokens,
      estimatedCostUsd,
      finishReason: "finishReason" in event ? event.finishReason : undefined,
      errorCode: "errorCode" in event ? event.errorCode : undefined,
      errorMessage: "errorMessage" in event ? event.errorMessage : undefined,
      metadata: "requestMetadata" in event ? mergeMetadata(existing?.metadata, event.requestMetadata) : undefined
    };

    const llm = await tx.llmRequest.upsert({
      where: { spanId },
      update: data,
      create: { id: spanId, startedAt: existing?.startedAt ?? timestamp, ...data }
    });

    if (isTerminal(status)) {
      await tx.usageMetric.upsert({
        where: { llmRequestId: llm.id },
        update: { promptTokens, completionTokens, cachedTokens, totalTokens, estimatedCostUsd, timestamp: endedAt ?? timestamp },
        create: {
          sessionId: event.sessionId,
          llmRequestId: llm.id,
          provider: event.provider,
          model: event.model,
          timestamp: endedAt ?? timestamp,
          promptTokens,
          completionTokens,
          cachedTokens,
          totalTokens,
          estimatedCostUsd
        }
      });
    }
  }

  private async upsertToolCall(tx: Prisma.TransactionClient, event: AgentEvent, spanId: string | null) {
    if (!spanId || !("toolName" in event)) return;
    const existing = await tx.toolCall.findUnique({ where: { spanId } });
    const timestamp = parseTimestamp(event.timestamp);
    const status = "status" in event && event.status ? event.status : existing?.status ?? "running";
    const endedAt = isTerminal(status) ? timestamp : existing?.endedAt ?? null;
    const latencyMs = "latencyMs" in event && event.latencyMs != null ? Math.round(event.latencyMs) : endedAt && existing ? durationMs(existing.startedAt, endedAt) : null;

    await tx.toolCall.upsert({
      where: { spanId },
      update: {
        toolName: event.toolName,
        callId: event.callId,
        status,
        endedAt,
        latencyMs,
        argumentsSummary: event.argumentsSummary,
        redactedArguments: jsonText(event.redactedArguments),
        resultSummary: event.resultSummary,
        exitStatus: event.exitStatus,
        errorCode: "errorCode" in event ? event.errorCode : undefined,
        errorMessage: "errorMessage" in event ? event.errorMessage : undefined
      },
      create: {
        id: spanId,
        sessionId: event.sessionId,
        spanId,
        toolName: event.toolName,
        callId: event.callId,
        status,
        startedAt: existing?.startedAt ?? timestamp,
        endedAt,
        latencyMs,
        argumentsSummary: event.argumentsSummary,
        redactedArguments: jsonText(event.redactedArguments),
        resultSummary: event.resultSummary,
        exitStatus: event.exitStatus,
        errorCode: "errorCode" in event ? event.errorCode : undefined,
        errorMessage: "errorMessage" in event ? event.errorMessage : undefined
      }
    });
  }
}
