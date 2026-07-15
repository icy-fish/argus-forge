import type { TraceSpan } from "@argus-forge/shared";

export type LlmMessage = { index: number; role: string; content: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function textFromContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item)) {
        if (item.type === "toolCall") return JSON.stringify(item, null, 2);
        return textFromContent(item.text ?? item.thinking ?? item.content ?? item.input ?? item.output);
      }
      return textFromContent(item);
    }).filter(Boolean).join("\n");
  }
  if (isRecord(value)) return textFromContent(value.text ?? value.content ?? value.input ?? value.output ?? JSON.stringify(value, null, 2));
  return "";
}

export function messagesFromPreview(preview: unknown): LlmMessage[] {
  const source = Array.isArray(preview) ? preview : isRecord(preview) ? preview.messages : undefined;
  if (!Array.isArray(source)) return [];
  return source.map((message, index) => ({
    index,
    role: isRecord(message) && typeof message.role === "string" ? message.role : `message ${index + 1}`,
    content: isRecord(message) ? textFromContent(message.content ?? message.text ?? message.parts) : textFromContent(message)
  })).filter((message) => message.content.length > 0);
}

export function requestMessages(span: TraceSpan): LlmMessage[] {
  if (span.type !== "llm" || !isRecord(span.requestMetadata)) return [];
  return messagesFromPreview(span.requestMetadata.requestPreview);
}

export function newRequestMessages(current: LlmMessage[], previous?: LlmMessage[]): LlmMessage[] {
  if (!previous) return current;
  const previousIsPrefix = previous.length <= current.length && previous.every((message, index) => {
    const candidate = current[index];
    return candidate?.role === message.role && candidate.content === message.content;
  });
  return previousIsPrefix ? current.slice(previous.length) : current;
}

function flattenSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans.flatMap((span) => [span, ...flattenSpans(span.children)]);
}

function comparisonKey(span: TraceSpan): string {
  return JSON.stringify([span.parentSpanId, span.provider ?? null, span.model ?? null]);
}

export function previousRequestMessages(spans: TraceSpan[]): Map<string, LlmMessage[]> {
  const llmSpans = flattenSpans(spans).filter((span) => span.type === "llm")
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  const latestByGroup = new Map<string, LlmMessage[]>();
  const previousBySpan = new Map<string, LlmMessage[]>();
  for (const span of llmSpans) {
    const key = comparisonKey(span);
    const previous = latestByGroup.get(key);
    if (previous) previousBySpan.set(span.id, previous);
    latestByGroup.set(key, requestMessages(span));
  }
  return previousBySpan;
}
