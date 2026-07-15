import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ISOLATED_CHECKOUTS,
  WORKTREE_PRUNE_ARGS,
  codexChildEnv,
  isolatedCheckoutsToRemove,
} from "./github-issue-workflow-utils.mjs";

const DAY = 86_400_000;

test("immediately prunes missing managed worktrees", () => {
  assert.deepEqual(WORKTREE_PRUNE_ARGS, [
    "worktree",
    "prune",
    "--expire",
    "now",
  ]);
});

test("does not evict an isolated checkout while capacity remains", () => {
  const registry = Array.from(
    { length: MAX_ISOLATED_CHECKOUTS - 1 },
    (_, index) => ({
      path: `checkout-${index}`,
      createdAt: index,
    }),
  );

  assert.deepEqual(isolatedCheckoutsToRemove(registry, 2 * DAY), []);
});

test("evicts all isolated checkouts at least one day old at capacity", () => {
  const now = 3 * DAY;
  const registry = Array.from(
    { length: MAX_ISOLATED_CHECKOUTS },
    (_, index) => ({
      path: `checkout-${index}`,
      createdAt: index < 2 ? now - DAY - index : now - 1_000 + index,
    }),
  );

  assert.deepEqual(
    isolatedCheckoutsToRemove(registry, now).map(({ path }) => path).sort(),
    ["checkout-0", "checkout-1"],
  );
});

test("evicts the oldest isolated checkout when none are one day old", () => {
  const now = DAY;
  const registry = Array.from(
    { length: MAX_ISOLATED_CHECKOUTS },
    (_, index) => ({
      path: `checkout-${index}`,
      createdAt: now - 1_000 + index,
    }),
  );

  assert.deepEqual(isolatedCheckoutsToRemove(registry, now), [registry[0]]);
});

test("marks the Codex checkout as a safe Git directory", () => {
  const environment = codexChildEnv("D:\\worktree", {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
  });

  assert.equal(environment.GIT_CONFIG_COUNT, "2");
  assert.equal(environment.GIT_CONFIG_KEY_0, "core.autocrlf");
  assert.equal(environment.GIT_CONFIG_KEY_1, "safe.directory");
  assert.equal(environment.GIT_CONFIG_VALUE_1, "D:\\worktree");
});
