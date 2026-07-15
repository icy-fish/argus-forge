import assert from "node:assert/strict";
import test from "node:test";
import { feedbackContext } from "./update-github-issue-plans.mjs";

const comment = (createdAt, body) => ({
  createdAt,
  body,
  author: { login: "user" },
});

test("selects feedback after the latest Codex analysis in chronological order", () => {
  const result = feedbackContext([
    comment("2026-01-04T00:00:00Z", "new feedback"),
    comment("2026-01-01T00:00:00Z", "old"),
    comment("2026-01-03T00:00:00Z", "Codex session: `second-session`"),
    comment("2026-01-02T00:00:00Z", "Codex session: first-session"),
  ]);
  assert.equal(result.sessionId, "second-session");
  assert.equal(result.analysis.body, "Codex session: `second-session`");
  assert.deepEqual(
    result.feedback.map(({ body }) => body),
    ["new feedback"],
  );
  assert.equal(result.history.length, 3);
});

test("returns null when no Codex analysis exists", () => {
  assert.equal(
    feedbackContext([comment("2026-01-01T00:00:00Z", "hello")]),
    null,
  );
});
