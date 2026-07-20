#!/usr/bin/env node

import { join } from "node:path";
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_REPO,
  assertCommand,
  defaultImplementationWorkspace,
  editIssueLabels,
  fail,
  getIssue,
  latestAnalysisContext,
  parseArgs,
  prepareIsolatedCheckout,
  renderComments,
  run,
  runCodexImplementation,
} from "./github-issue-workflow-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? DEFAULT_REPO;
const issueNumber = Number(args.issue);
const sourceLabel = args.label ?? "ready to go";
const baseBranch = args.base ?? DEFAULT_BASE_BRANCH;
const workspaceRoot = args["workspace-dir"];
const dryRun = Boolean(args["dry-run"]);
main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);

async function main() {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    fail("--issue must be a positive integer");
  assertCommand("gh", ["--version"]);
  const issue = getIssue(repo, issueNumber);
  if (dryRun) {
    console.log(`#${issue.number}: implement (${issue.url})`);
    return;
  }
  assertCommand("codex", ["--version"]);
  assertCommand("git", ["--version"]);

  const context = latestAnalysisContext(issue.comments);
  if (!context) {
    console.log(`Skipping #${issue.number}: no Codex issue analysis comment found.`);
    return;
  }
  const branch = `codex/issue-${issue.number}-${slug(issue.title)}`;
  const checkoutPath = workspaceRoot
    ? join(
      workspaceRoot,
      `${repo.replaceAll("/", "-")}-issue-${issue.number}-${Date.now()}`,
    )
    : defaultImplementationWorkspace(repo, issue.number);
  console.log(`\nImplementing #${issue.number}: ${issue.title}`);
  prepareIsolatedCheckout({ repo, baseBranch, checkoutPath, branch });
  // Claim the issue only after checkout preparation succeeds. A checkout
  // failure must leave the source label in place so the dispatcher can retry.
  editIssueLabels(repo, issue.number, { remove: sourceLabel });
  await runCodexImplementation({
    prompt: buildPrompt(issue, context, checkoutPath),
    model: args["codex-model"],
    cwd: checkoutPath,
    issueNumber: issue.number,
  });
  if (!run("git", ["status", "--porcelain"], { cwd: checkoutPath }).trim())
    throw new Error(`Codex produced no changes for #${issue.number}`);
  run("git", ["add", "--all"], { cwd: checkoutPath });
  run(
    "git",
    [
      "commit",
      "-m",
      commitSubject(issue),
      "-m",
      `Implement the approved requirements and Codex plan for GitHub issue #${issue.number}.`,
    ],
    { cwd: checkoutPath },
  );
  run("git", ["push", "--set-upstream", "origin", branch], {
    cwd: checkoutPath,
  });
  const prUrl = run(
    "gh",
    [
      "pr",
      "create",
      "-R",
      repo,
      "--base",
      baseBranch,
      "--head",
      branch,
      "--title",
      `Implement #${issue.number}: ${issue.title}`,
      "--body",
      `Closes #${issue.number}.\n\nGenerated from the approved Codex issue analysis and subsequent user feedback.`,
    ],
  ).trim();
  console.log(`Created pull request for #${issue.number}: ${prUrl}`);
}

function buildPrompt(issue, context, checkoutPath) {
  return [
    "Implement the GitHub issue in this isolated workspace.",
    "Follow every applicable AGENTS.md instruction. Treat the issue description as the original user requirement, the latest Codex issue analysis comment as the implementation plan, and later user comments as additional requirements.",
    "Inspect and update existing project documentation when the implementation makes documentation changes necessary.",
    "Run appropriate tests and checks. Do not commit, push, create a pull request, or change GitHub issue state; the workflow handles those steps.",
    `Repository: ${repo}`,
    `Base branch: ${baseBranch}`,
    `Workspace: ${checkoutPath}`,
    `Issue: #${issue.number} ${issue.title}`,
    `URL: ${issue.url}`,
    "",
    "## Original user requirement",
    "",
    issue.body || "(empty)",
    "",
    "## Latest Codex implementation plan",
    "",
    context.analysis.body || "(empty)",
    "",
    "## Additional user requirements",
    "",
    renderComments(context.feedback),
  ].join("\n");
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 48) || "implementation"
  );
}

function commitSubject(issue) {
  const subject = `feat: implement issue #${issue.number} ${issue.title}`;
  return subject.length <= 72 ? subject : `feat: implement issue #${issue.number}`;
}
