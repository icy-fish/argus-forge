#!/usr/bin/env node

import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_LIMIT,
  DEFAULT_REPO,
  addAnalysisComment,
  assertCommand,
  defaultWorkspace,
  editIssueLabels,
  ensureLabel,
  fail,
  getIssue,
  parseArgs,
  prepareReusableCheckout,
  run,
  runCodexAnalysis,
} from "./github-issue-workflow-utils.mjs";

const DEFAULT_ASSIGNEE = "icy-fish";
const DEFAULT_DAYS = 7;
const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? DEFAULT_REPO;
const assignee = args.assignee ?? DEFAULT_ASSIGNEE;
const doingLabel = args["doing-label"] ?? "doing";
const reviewLabel = args["review-label"] ?? "review needed";
const baseBranch = args.base ?? DEFAULT_BASE_BRANCH;
const days = Number(args.days ?? DEFAULT_DAYS);
const limit = Number(args.limit ?? DEFAULT_LIMIT);
const checkoutPath = args["workspace-dir"] ?? defaultWorkspace(repo);
const dryRun = Boolean(args["dry-run"]);
if (!Number.isInteger(days) || days <= 0)
  fail("--days must be a positive integer");
if (!Number.isInteger(limit) || limit <= 0)
  fail("--limit must be a positive integer");

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);

async function main() {
  assertCommand("gh", ["--version"]);
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const issues = JSON.parse(
    run("gh", [
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--search",
      `created:>=${cutoff.toISOString().slice(0, 10)} no:assignee no:label`,
      "--limit",
      String(limit),
      "--json",
      "number,title,createdAt,state,assignees,labels,url",
    ]),
  ).filter(
    (issue) =>
      issue.state === "OPEN" &&
      new Date(issue.createdAt) >= cutoff &&
      issue.assignees.length === 0 &&
      issue.labels.length === 0,
  );
  if (issues.length === 0) {
    console.log("No matching issues found.");
    return;
  }
  console.log(
    `Found ${issues.length} matching issue${issues.length === 1 ? "" : "s"} in ${repo}.`,
  );
  if (dryRun) {
    for (const issue of issues)
      console.log(`#${issue.number}: ${issue.title} (${issue.url})`);
    return;
  }

  assertCommand("codex", ["--version"]);
  assertCommand("git", ["--version"]);
  ensureLabel(repo, doingLabel, "FBCA04", "Issue analysis is in progress");
  ensureLabel(
    repo,
    reviewLabel,
    "0E8A16",
    "Issue analysis is ready for review",
  );
  prepareReusableCheckout({ repo, baseBranch, checkoutPath });

  for (const summary of issues) {
    const issue = getIssue(repo, summary.number);
    console.log(`\nAnalyzing #${issue.number}: ${issue.title}`);
    run("gh", [
      "issue",
      "edit",
      String(issue.number),
      "-R",
      repo,
      "--add-label",
      doingLabel,
      "--add-assignee",
      assignee,
    ]);
    const result = await runCodexAnalysis({
      prompt: buildPrompt(issue),
      model: args["codex-model"],
      cwd: checkoutPath,
      issueNumber: issue.number,
    });
    if (!result.sessionId || !result.content.trim())
      throw new Error(
        `Codex produced an incomplete analysis for #${issue.number}`,
      );
    addAnalysisComment(repo, issue.number, result);
    editIssueLabels(repo, issue.number, { add: reviewLabel });
    console.log(
      `Posted analysis for #${issue.number} (Codex session ${result.sessionId}).`,
    );
  }
}

function buildPrompt(issue) {
  const comments =
    issue.comments
      .map(
        (comment, index) =>
          `### Comment ${index + 1} by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}\n\n${comment.body || "(empty)"}`,
      )
      .join("\n\n") || "(none)";
  return [
    "Analyze the GitHub issue below in Plan mode. Do not implement it and do not modify files.",
    "Inspect the repository and its AGENTS.md instructions to ground the analysis in current code.",
    "If clarification is needed, output concise questions and why each answer matters. Otherwise output a concrete plan with likely files, behavior, edge cases, and validation.",
    "Make the response suitable for a GitHub issue comment. Do not use GitHub CLI or change repository or issue state.",
    `Repository: ${repo}`,
    `Base branch: ${baseBranch}`,
    `Checkout: ${checkoutPath}`,
    `Issue: #${issue.number}`,
    `URL: ${issue.url}`,
    `Title: ${issue.title}`,
    "",
    "## Description",
    "",
    issue.body || "(empty)",
    "",
    "## Existing comments",
    "",
    comments,
  ].join("\n");
}
