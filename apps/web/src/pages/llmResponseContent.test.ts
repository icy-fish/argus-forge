import { describe, expect, it } from "vitest";
import { responseItemsFromPreview } from "./llmResponseContent";

describe("LLM response content", () => {
  it("keeps multipart response types separate and ordered", () => {
    const items = responseItemsFromPreview({ content: [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "reasoning" },
      { type: "toolCall", name: "search", input: { q: "test" } }
    ] });

    expect(items.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: "text", content: "answer" },
      { type: "thinking", content: "reasoning" },
      { type: "toolCall", content: JSON.stringify({ type: "toolCall", name: "search", input: { q: "test" } }, null, 2) }
    ]);
    expect(items.every((item) => item.type.length > 0)).toBe(true);
  });

  it("supports primitive and single-object responses", () => {
    expect(responseItemsFromPreview("hello")[0]).toMatchObject({ type: "text", content: "hello" });
    expect(responseItemsFromPreview({ type: "text", text: "hello" })[0]).toMatchObject({ type: "text", content: "hello" });
  });

  it("unwraps OpenAI choice message content and text", () => {
    expect(responseItemsFromPreview({ choices: [{ message: { content: "chat" } }] })[0]?.content).toBe("chat");
    expect(responseItemsFromPreview({ choices: [{ text: "completion" }] })[0]?.content).toBe("completion");
  });

  it("retains unknown and structured typed data as JSON", () => {
    const unknown = responseItemsFromPreview({ unexpected: { nested: true } })[0];
    const structured = responseItemsFromPreview({ type: "data", content: { value: 3 } })[0];
    expect(unknown).toMatchObject({ type: "unknown", structured: true });
    expect(unknown?.content).toContain('"nested": true');
    expect(structured).toMatchObject({ type: "data", structured: true });
    expect(structured?.content).toContain('"value": 3');
  });

  it("omits empty content and tolerates malformed mixed arrays", () => {
    expect(responseItemsFromPreview(null)).toEqual([]);
    expect(responseItemsFromPreview([])).toEqual([]);
    expect(responseItemsFromPreview({ content: "" })).toEqual([]);
    expect(responseItemsFromPreview({ content: [null, "", { type: "text", text: "valid" }, undefined] }))
      .toEqual([{ index: 0, type: "text", content: "valid", structured: false }]);
  });
});
