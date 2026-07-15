#!/usr/bin/env node

import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_LIMIT,
  DEFAULT_REPO,
  addAnalysisComment,
  assertCommand,
  codexSessionExists,
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
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? DEFAULT_REPO;
const sourceLabel = args.label ?? "comments to be resolved";
const reviewLabel = args["review-label"] ?? "review needed";
const baseBranch = args.base ?? DEFAULT_BASE_BRANCH;
const limit = Number(args.limit ?? DEFAULT_LIMIT);
const checkoutPath = args["workspace-dir"] ?? defaultWorkspace(repo);
const dryRun = Boolean(args["dry-run"]);
if (!Number.isInteger(limit) || limit <= 0)
  fail("--limit must be a positive integer");

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
}

async function main() {
  assertCommand("gh", ["--version"]);
  const summaries = JSON.parse(
    run("gh", [
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--label",
      sourceLabel,
      "--limit",
      String(limit),
      "--json",
      "number,title,url",
    ]),
  );
  const pending = [];
  for (const summary of summaries) {
    const issue = getIssue(repo, summary.number);
    const context = feedbackContext(issue.comments);
    if (!context || context.feedback.length === 0) {
      console.log(
        `Skipping #${issue.number}: no new comments after the latest Codex analysis.`,
      );
      continue;
    }
    pending.push({ issue, ...context });
    if (dryRun)
      console.log(
        `#${issue.number}: ${issue.title} (${context.feedback.length} new comment${context.feedback.length === 1 ? "" : "s"})`,
      );
  }
  if (pending.length === 0) {
    console.log("No issue plans need updating.");
    return;
  }
  if (dryRun) return;

  assertCommand("codex", ["--version"]);
  assertCommand("git", ["--version"]);
  ensureLabel(
    repo,
    reviewLabel,
    "0E8A16",
    "Issue analysis is ready for review",
  );
  prepareReusableCheckout({ repo, baseBranch, checkoutPath });

  for (const item of pending) {
    const { issue, sessionId, history, feedback } = item;
    console.log(`\nUpdating plan for #${issue.number}: ${issue.title}`);
    editIssueLabels(repo, issue.number, { remove: sourceLabel });
    const resumable = codexSessionExists(sessionId);
    const result = await runCodexAnalysis({
      prompt: buildPrompt({
        issue,
        repo,
        baseBranch,
        checkoutPath,
        history,
        feedback,
        resumable,
      }),
      model: args["codex-model"],
      cwd: checkoutPath,
      issueNumber: issue.number,
      resumeSessionId: resumable ? sessionId : undefined,
    });
    if (!result.sessionId || !result.content.trim())
      throw new Error(
        `Codex produced an incomplete analysis for #${issue.number}`,
      );
    addAnalysisComment(repo, issue.number, result);
    editIssueLabels(repo, issue.number, { add: reviewLabel });
    console.log(
      `Posted updated analysis for #${issue.number} (Codex session ${result.sessionId}).`,
    );
  }
}

export function feedbackContext(comments) {
  const ordered = [...comments].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );
  let analysisIndex = -1;
  let sessionId;
  for (let index = 0; index < ordered.length; index += 1) {
    const match = ordered[index].body?.match(
      /Codex session:\s*`?([0-9a-z-]+)`?/iu,
    );
    if (match) {
      analysisIndex = index;
      sessionId = match[1];
    }
  }
  if (analysisIndex < 0) return null;
  return {
    sessionId,
    history: ordered.slice(0, analysisIndex + 1),
    feedback: ordered.slice(analysisIndex + 1),
  };
}

function renderComments(comments) {
  return (
    comments
      .map(
        (comment, index) =>
          `### Comment ${index + 1} by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}\n\n${comment.body || "(empty)"}`,
      )
      .join("\n\n") || "(none)"
  );
}

function buildPrompt({
  issue,
  repo,
  baseBranch,
  checkoutPath,
  history,
  feedback,
  resumable,
}) {
  const instructions = [
    "Update the GitHub issue analysis in Plan mode. Do not implement anything and do not modify files.",
    "Inspect the repository and AGENTS.md as needed. Treat the new comments as user feedback.",
    "Produce either a revised, concrete implementation plan or concise clarification questions when reliable planning still requires answers.",
    "Make the final response suitable for posting directly as a GitHub issue comment. Do not use GitHub CLI or change repository or issue state.",
    `Repository: ${repo}`,
    `Base branch: ${baseBranch}`,
    `Checkout: ${checkoutPath}`,
    `Issue: #${issue.number} ${issue.title}`,
  ];
  if (!resumable)
    instructions.push(
      "The prior Codex session is unavailable. Reconstruct context from the original requirement and session history below.",
      "",
      "## Original requirement",
      "",
      issue.body || "(empty)",
      "",
      "## Session history",
      "",
      renderComments(history),
    );
  instructions.push("", "## New user feedback", "", renderComments(feedback));
  return instructions.join("\n");
}
