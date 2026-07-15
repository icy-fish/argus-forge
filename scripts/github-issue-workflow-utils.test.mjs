import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ISOLATED_CHECKOUTS,
  isolatedCheckoutsToRemove,
} from "./github-issue-workflow-utils.mjs";

const DAY = 86_400_000;

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
