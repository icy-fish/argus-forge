import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_ISOLATED_CHECKOUTS,
  WORKTREE_PRUNE_ARGS,
  addIsolatedWorktree,
  codexChildEnv,
  isolatedCheckoutsToRemove,
} from "./github-issue-workflow-utils.mjs";

const DAY = 86_400_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "argus-forge-worktree-test-"));
  const repository = join(root, "repository");
  git(root, "init", repository);
  git(repository, "config", "user.email", "test@example.com");
  git(repository, "config", "user.name", "Test User");
  writeFileSync(join(repository, "README.md"), "base\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "base");
  git(repository, "branch", "-M", "main");
  git(repository, "update-ref", "refs/remotes/origin/main", "HEAD");
  return {
    root,
    repository,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

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
    (_, index) => ({ path: `checkout-${index}`, createdAt: index }),
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

test("reuses an unattached stale branch that still points at the base", () => {
  const context = fixture();
  try {
    git(context.repository, "branch", "codex/issue-1", "origin/main");
    const checkout = join(context.root, "checkout");
    addIsolatedWorktree(
      context.repository,
      checkout,
      "codex/issue-1",
      "origin/main",
    );
    assert.equal(git(checkout, "branch", "--show-current"), "codex/issue-1");
  } finally {
    context.cleanup();
  }
});

test("does not overwrite an existing implementation branch with work", () => {
  const context = fixture();
  try {
    git(context.repository, "branch", "codex/issue-1", "origin/main");
    git(context.repository, "switch", "codex/issue-1");
    writeFileSync(join(context.repository, "change.txt"), "work\n");
    git(context.repository, "add", "change.txt");
    git(context.repository, "commit", "-m", "work");
    git(context.repository, "switch", "main");
    assert.throws(
      () =>
        addIsolatedWorktree(
          context.repository,
          join(context.root, "checkout"),
          "codex/issue-1",
          "origin/main",
        ),
      /already contains work/u,
    );
  } finally {
    context.cleanup();
  }
});

test("reports when an implementation branch is already checked out", () => {
  const context = fixture();
  try {
    const firstCheckout = join(context.root, "first-checkout");
    git(
      context.repository,
      "worktree",
      "add",
      "-b",
      "codex/issue-1",
      firstCheckout,
      "origin/main",
    );
    assert.throws(
      () =>
        addIsolatedWorktree(
          context.repository,
          join(context.root, "second-checkout"),
          "codex/issue-1",
          "origin/main",
        ),
      /already checked out/u,
    );
  } finally {
    context.cleanup();
  }
});
