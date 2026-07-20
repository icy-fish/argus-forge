import assert from "node:assert/strict";
import test from "node:test";
import { ArgusForgePlugin, _test } from "../plugins/argus-forge.ts";

test("stable IDs are deterministic and redaction handles secrets and cycles", () => {
  assert.equal(_test.stableId("event", "session", 1), _test.stableId("event", "session", 1));
  const value: Record<string, unknown> = { apiKey: "secret", nested: { password: "hidden", safe: "visible" } };
  value.circular = value;
  assert.deepEqual(_test.redact(value), {
    apiKey: "[REDACTED]",
    nested: { password: "[REDACTED]", safe: "visible" },
    circular: "[Circular]"
  });
});

test("translates paired session, LLM, and tool lifecycles into one batch", async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  };

  try {
    const hooks = await ArgusForgePlugin({ directory: "C:/repo", worktree: "C:/repo", project: { id: "project-1" } } as never);
    const created = { type: "session.created", properties: { sessionID: "s1", info: { id: "s1", title: "Trace", time: { created: 1_700_000_000_000 } } } };
    const running = { type: "message.updated", properties: { sessionID: "s1", info: { id: "m1", sessionID: "s1", role: "assistant", providerID: "openai", modelID: "gpt-test", time: { created: 1_700_000_000_100 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } } } };
    const toolPart = { type: "message.part.updated", properties: { sessionID: "s1", part: { id: "p1", type: "tool", sessionID: "s1", messageID: "m1", callID: "c1" } } };
    await hooks.event?.({ event: created as never });
    await hooks.event?.({ event: running as never });
    await hooks.event?.({ event: toolPart as never });
    await hooks["tool.execute.before"]?.({ sessionID: "s1", callID: "c1", tool: "shell" }, { args: { command: "echo ok", token: "do-not-send" } });
    await hooks["tool.execute.after"]?.({ sessionID: "s1", callID: "c1", tool: "shell", args: {} }, { title: "done", output: "ok", metadata: { exitCode: 0 } });
    await hooks.event?.({ event: { ...running, properties: { ...running.properties, info: { ...running.properties.info, finish: "stop", time: { created: 1_700_000_000_100, completed: 1_700_000_000_500 }, tokens: { input: 12, output: 4, cache: { read: 2, write: 0 } } } } } as never });
    await hooks.dispose?.();

    const events = (requests[0] as { events: Array<Record<string, unknown>> }).events;
    assert.deepEqual(events.map(event => event.type), ["session.started", "llm.request.started", "tool.call.started", "tool.call.completed", "llm.request.completed"]);
    assert.equal((events[2].redactedArguments as Record<string, unknown>).token, "[REDACTED]");
    assert.equal(events[1].spanId, events[4].spanId);
    assert.equal(events[2].spanId, events[3].spanId);
    assert.equal(events[2].parentSpanId, events[1].spanId);
    assert.equal(events[4].promptTokens, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
