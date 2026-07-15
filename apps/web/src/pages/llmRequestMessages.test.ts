import type { TraceSpan } from "@argus-forge/shared";
import { describe, expect, it } from "vitest";
import { messagesFromPreview, newRequestMessages, previousRequestMessages, requestMessages } from "./llmRequestMessages";

function span(id: string, startedAt: string, messages: unknown[], overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id,
    parentSpanId: "agent",
    sessionId: "session",
    type: "llm",
    name: id,
    status: "completed",
    startedAt,
    endedAt: null,
    durationMs: null,
    provider: "openai",
    model: "model",
    requestMetadata: { requestPreview: { messages } },
    events: [],
    children: [],
    ...overrides
  };
}

const message = (role: string, content: unknown, metadata?: unknown) => ({ role, content, metadata });

describe("LLM request messages", () => {
  it("keeps original indexes when malformed messages are filtered", () => {
    expect(messagesFromPreview({ messages: [message("system", ""), message("user", "hello")] })).toEqual([
      { index: 1, role: "user", content: "hello" }
    ]);
    expect(messagesFromPreview(null)).toEqual([]);
    expect(messagesFromPreview({ messages: "invalid" })).toEqual([]);
  });

  it("normalizes multipart and tool-call content", () => {
    const messages = messagesFromPreview([message("assistant", [
      { type: "text", text: "thinking" },
      { type: "toolCall", name: "search", input: { q: "test" } }
    ])]);
    expect(messages[0]?.content).toContain("thinking");
    expect(messages[0]?.content).toContain('"name": "search"');
  });

  it("shows all messages for a first request and only an appended suffix thereafter", () => {
    const first = messagesFromPreview([message("system", "rules"), message("user", "one")]);
    const next = messagesFromPreview([message("system", "rules"), message("user", "one"), message("assistant", "two")]);
    expect(newRequestMessages(first)).toEqual(first);
    expect(newRequestMessages(next, first)).toEqual([{ index: 2, role: "assistant", content: "two" }]);
    expect(newRequestMessages(first, first)).toEqual([]);
  });

  it.each([
    ["changed", [message("system", "changed"), message("user", "one")]],
    ["removed", [message("user", "one")]],
    ["reordered", [message("user", "one"), message("system", "rules")]],
    ["shortened", [message("system", "rules")]]
  ])("shows the full current request when messages are %s", (_case, currentPreview) => {
    const previous = messagesFromPreview([message("system", "rules"), message("user", "one")]);
    const current = messagesFromPreview(currentPreview);
    expect(newRequestMessages(current, previous)).toEqual(current);
  });

  it("compares normalized role/content and ignores indexes and metadata", () => {
    const previous = [{ index: 99, role: "user", content: "same" }];
    const current = messagesFromPreview([message("user", "same", { cache: false }), message("assistant", "new")]);
    expect(newRequestMessages(current, previous)).toEqual([{ index: 1, role: "assistant", content: "new" }]);
    expect(newRequestMessages(messagesFromPreview([message("user", "different")]), previous)).toHaveLength(1);
  });
});

describe("previous comparable request selection", () => {
  it("flattens nested spans and sorts chronologically with an ID tie-breaker", () => {
    const later = span("c", "2025-01-01T00:00:02Z", [message("user", "c")]);
    const sameTimeSecond = span("b", "2025-01-01T00:00:01Z", [message("user", "b")]);
    const sameTimeFirst = span("a", "2025-01-01T00:00:01Z", [message("user", "a")], { children: [later] });
    const previous = previousRequestMessages([sameTimeSecond, sameTimeFirst]);
    expect(previous.get("b")).toEqual(requestMessages(sameTimeFirst));
    expect(previous.get("c")).toEqual(requestMessages(sameTimeSecond));
  });

  it.each([
    ["parent", { parentSpanId: "other" }],
    ["provider", { provider: "other" }],
    ["model", { model: "other" }]
  ])("does not compare requests with a different %s", (_field, overrides) => {
    const first = span("a", "2025-01-01T00:00:00Z", [message("user", "a")]);
    const second = span("b", "2025-01-01T00:00:01Z", [message("user", "b")], overrides);
    expect(previousRequestMessages([first, second]).has("b")).toBe(false);
  });

  it("treats null parent IDs as the same exact group", () => {
    const first = span("a", "2025-01-01T00:00:00Z", [], { parentSpanId: null });
    const second = span("b", "2025-01-01T00:00:01Z", [], { parentSpanId: null });
    expect(previousRequestMessages([first, second]).has("b")).toBe(true);
  });
});
