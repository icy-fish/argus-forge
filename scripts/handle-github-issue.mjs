#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LIMIT,
  DEFAULT_REPO,
  assertCommand,
  fail,
  parseArgs,
  run,
} from "./github-issue-workflow-utils.mjs";

const DEFAULT_DAYS = 7;
const COMMENTS_LABEL = "comments to be resolved";
const READY_LABEL = "ready to go";
const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? DEFAULT_REPO;
const days = Number(args.days ?? DEFAULT_DAYS);
const limit = Number(args.limit ?? DEFAULT_LIMIT);
const dryRun = Boolean(args["dry-run"]);

if (!Number.isInteger(days) || days <= 0)
  fail("--days must be a positive integer");
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
      `created:>=${cutoff.toISOString().slice(0, 10)}`,
      "--limit",
      String(limit),
      "--json",
      "number,title,createdAt,state,assignees,labels,url",
    ]),
  ).filter(
    (issue) =>
      issue.state === "OPEN" &&
      new Date(issue.createdAt).getTime() >= cutoff.getTime(),
  );

  const dispatches = issues
    .map((issue) => ({ issue, workflow: classifyIssue(issue) }))
    .filter(({ workflow }) => workflow);
  console.log(
    `Found ${issues.length} recent open issue${issues.length === 1 ? "" : "s"} in ${repo}; ${dispatches.length} matched a workflow.`,
  );

  for (const { issue, workflow } of dispatches) {
    console.log(
      `#${issue.number}: ${workflow.name} - ${issue.title} (${issue.url})`,
    );
    if (!dryRun) dispatch(workflow, issue.number);
  }
}

export function classifyIssue(issue) {
  const labels = new Set(
    (issue.labels ?? []).map(({ name }) => name.toLocaleLowerCase()),
  );
  if (labels.has(COMMENTS_LABEL))
    return { name: "update plan", script: "update-github-issue-plans.mjs" };
  if (labels.has(READY_LABEL))
    return { name: "implement", script: "implement-github-issues.mjs" };
  if ((issue.assignees ?? []).length === 0 && labels.size === 0)
    return { name: "analyze", script: "analyse-github-issues.mjs" };
  return null;
}

function dispatch(workflow, issueNumber) {
  const childArgs = [
    join(dirname(fileURLToPath(import.meta.url)), workflow.script),
    "--repo",
    repo,
    "--issue",
    String(issueNumber),
  ];
  for (const option of [
    "base",
    "codex-model",
    "workspace-dir",
    "assignee",
    "doing-label",
    "review-label",
  ]) {
    if (args[option] !== undefined) childArgs.push(`--${option}`, args[option]);
  }
  execFileSync(process.execPath, childArgs, { stdio: "inherit" });
}
