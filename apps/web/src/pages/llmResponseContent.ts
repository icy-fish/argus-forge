import { isRecord } from "./llmRequestMessages";

export type LlmResponseItem = {
  index: number;
  type: string;
  content: string;
  structured: boolean;
};

function responsePayload(preview: unknown): unknown {
  if (!isRecord(preview)) return preview;
  if (typeof preview.type === "string" && preview.type.trim()) return preview;

  const choice = Array.isArray(preview.choices) && isRecord(preview.choices[0]) ? preview.choices[0] : undefined;
  const choiceMessage = choice && isRecord(choice.message) ? choice.message : undefined;
  return preview.content ??
    preview.text ??
    preview.output ??
    (isRecord(preview.message) ? responsePayload(preview.message) : preview.message) ??
    choiceMessage?.content ??
    choice?.text ??
    preview;
}

function formatted(value: unknown): { content: string; structured: boolean } | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim().length ? { content: value, structured: false } : null;
  if (typeof value === "number" || typeof value === "boolean") return { content: String(value), structured: false };
  if (typeof value === "object") {
    try {
      return { content: JSON.stringify(value, null, 2), structured: true };
    } catch {
      return { content: String(value), structured: false };
    }
  }
  return null;
}

export function responseItemsFromPreview(preview: unknown): LlmResponseItem[] {
  const items: LlmResponseItem[] = [];

  const append = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }

    let type = "text";
    let displayValue = value;
    if (isRecord(value)) {
      type = typeof value.type === "string" && value.type.trim() ? value.type : "unknown";
      if (type === "toolCall" || type === "unknown") {
        displayValue = value;
      } else {
        displayValue = value.text ?? value.thinking ?? value.content ?? value.input ?? value.output ?? value;
      }
    }

    const display = formatted(displayValue);
    if (!display) return;
    items.push({ index: items.length, type, ...display });
  };

  append(responsePayload(preview));
  return items;
}
