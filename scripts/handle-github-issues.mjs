#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_REPO = "icy-fish/argus-forge";
const DEFAULT_ASSIGNEE = "icy-fish";
const DEFAULT_DOING_LABEL = "doing";
const DEFAULT_REVIEW_LABEL = "review needed";
const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 100;
const MAX_COMMENT_LENGTH = 60_000;

const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? DEFAULT_REPO;
const assignee = args.assignee ?? DEFAULT_ASSIGNEE;
const doingLabel = args["doing-label"] ?? DEFAULT_DOING_LABEL;
const reviewLabel = args["review-label"] ?? DEFAULT_REVIEW_LABEL;
const days = Number(args.days ?? DEFAULT_DAYS);
const limit = Number(args.limit ?? DEFAULT_LIMIT);
const dryRun = Boolean(args["dry-run"]);
const codexModel = args["codex-model"];
const checkoutPath =
  args["workspace-dir"] ??
  join(tmpdir(), "github-issue-analysis", repo.replaceAll("/", "-"));
const commands = {
  gh: resolveCommand("gh"),
  codex: resolveCommand("codex"),
  git: resolveCommand("git"),
};

if (!Number.isInteger(days) || days <= 0)
  fail("--days must be a positive integer");
if (!Number.isInteger(limit) || limit <= 0)
  fail("--limit must be a positive integer");

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);

async function main() {
  assertCommand("gh", ["--version"]);
  assertCommand("codex", ["--version"]);
  assertCommand("git", ["--version"]);

  const baseBranch = args.base ?? DEFAULT_BASE_BRANCH;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const issues = listCandidateIssues({ repo, cutoffDate, limit }).filter(
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

    markIssueInProgress(repo, issue.number, doingLabel, assignee);
    const prompt = buildCodexPrompt({ issue, repo, baseBranch, checkoutPath });
    const result = await runCodexAnalysis(
      prompt,
      codexModel,
      checkoutPath,
      issue.number,
    );
    if (!result.sessionId) {
      throw new Error(`Codex did not report a session id for #${issue.number}`);
    }
    if (!result.content.trim()) {
      throw new Error(`Codex produced no analysis for #${issue.number}`);
    }

    addAnalysisComment(repo, issue.number, result);
    markIssueReadyForReview(repo, issue.number, reviewLabel);
    console.log(
      `Posted analysis for #${issue.number} (Codex session ${result.sessionId}).`,
    );
  }
}

function listCandidateIssues({ repo, cutoffDate, limit }) {
  const stdout = run("gh", [
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--search",
    `created:>=${cutoffDate} no:assignee no:label`,
    "--limit",
    String(limit),
    "--json",
    "number,title,createdAt,state,assignees,labels,url",
  ]);
  return JSON.parse(stdout);
}

function getIssue(repo, number) {
  return JSON.parse(
    run("gh", [
      "issue",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "number,title,body,createdAt,updatedAt,state,author,assignees,labels,comments,url",
    ]),
  );
}

function prepareReusableCheckout({ repo, baseBranch, checkoutPath }) {
  mkdirSync(dirname(checkoutPath), { recursive: true });
  if (!existsSync(join(checkoutPath, ".git"))) {
    if (existsSync(checkoutPath)) {
      throw new Error(
        `Reusable workspace exists but is not a Git checkout: ${checkoutPath}`,
      );
    }
    run("gh", ["repo", "clone", repo, checkoutPath, "--", "--no-checkout"]);
  } else {
    const origin = run("git", ["remote", "get-url", "origin"], {
      cwd: checkoutPath,
    }).trim();
    const expected = repo.toLowerCase();
    if (
      !origin
        .toLowerCase()
        .replace(/\.git$/u, "")
        .endsWith(expected)
    ) {
      throw new Error(
        `Reusable workspace origin does not match ${repo}: ${origin}`,
      );
    }
  }

  run("git", ["fetch", "origin", baseBranch, "--prune"], { cwd: checkoutPath });
  run("git", ["checkout", "-B", baseBranch, `origin/${baseBranch}`], {
    cwd: checkoutPath,
  });
  run("git", ["reset", "--hard", `origin/${baseBranch}`], {
    cwd: checkoutPath,
  });
  console.log(`Reusable analysis checkout is current at ${checkoutPath}.`);
}

function buildCodexPrompt({ issue, repo, baseBranch, checkoutPath }) {
  const comments = issue.comments
    .map(
      (comment, index) =>
        `### Comment ${index + 1} by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}\n\n${comment.body || "(empty)"}`,
    )
    .join("\n\n");

  return [
    "Analyze the GitHub issue below in Plan mode. Do not implement it and do not modify files.",
    "Inspect the repository and its AGENTS.md instructions to ground the analysis in the current code.",
    "First decide whether the issue is clear and complete enough to produce a reliable implementation plan.",
    "Be rigorous: identify every fuzzy description, unstated behavior, ambiguous scope, missing acceptance criterion, or technical decision that must be clarified.",
    "If clarification is needed, output concise questions for the user to answer and explain why each answer affects implementation. Do not invent requirements and do not provide a speculative implementation plan.",
    "If no clarification is needed, output a concrete implementation plan with likely files/components, behavioral changes, edge cases, and validation/tests.",
    "Make the final response suitable for posting directly as a GitHub issue comment.",
    "Do not use GitHub CLI, edit the issue, commit, branch, push, or open a pull request.",
    "",
    `Repository: ${repo}`,
    `Base branch: ${baseBranch}`,
    `Checkout: ${checkoutPath}`,
    `Issue: #${issue.number}`,
    `URL: ${issue.url}`,
    `Title: ${issue.title}`,
    `Author: ${issue.author?.login ?? "unknown"}`,
    `Created: ${issue.createdAt}`,
    `Updated: ${issue.updatedAt}`,
    "",
    "## Description",
    "",
    issue.body || "(empty)",
    "",
    "## Existing comments",
    "",
    comments || "(none)",
  ].join("\n");
}

async function runCodexAnalysis(prompt, model, cwd, issueNumber) {
  const outputFile = join(
    dirname(cwd),
    `.issue-${issueNumber}-codex-output.md`,
  );
  rmSync(outputFile, { force: true });
  const codexArgs = [
    "exec",
    "--cd",
    cwd,
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--output-last-message",
    outputFile,
    "--config",
    'collaboration_mode="plan"',
  ];
  if (model) codexArgs.push("--model", model);
  codexArgs.push("-");

  const child = spawn(
    commands.codex.file,
    [...commands.codex.argsPrefix, ...codexArgs],
    {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
      shell: false,
    },
  );
  let jsonl = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    jsonl += chunk;
  });
  child.stdin.end(prompt);
  const exitCode = await waitForProcess(child);
  if (exitCode !== 0)
    throw new Error(
      `Codex failed for #${issueNumber} with exit code ${exitCode}`,
    );

  try {
    return {
      sessionId: extractSessionId(jsonl),
      content: readFileSync(outputFile, "utf8"),
    };
  } finally {
    rmSync(outputFile, { force: true });
  }
}

function extractSessionId(jsonl) {
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const id =
        event.thread_id ??
        event.session_id ??
        event.thread?.id ??
        event.session?.id;
      if (typeof id === "string" && id) return id;
    } catch {
      // Ignore non-JSON diagnostic output; Codex's final exit status is checked separately.
    }
  }
  return null;
}

function addAnalysisComment(repo, number, { sessionId, content }) {
  let body = [
    `## Codex issue analysis`,
    "",
    `Codex session: \`${sessionId}\``,
    "",
    content.trim(),
  ].join("\n");
  if (body.length > MAX_COMMENT_LENGTH) {
    body = `${body.slice(0, MAX_COMMENT_LENGTH)}\n\n_Analysis truncated to fit GitHub's comment limit._`;
  }
  run(
    "gh",
    ["issue", "comment", String(number), "-R", repo, "--body-file", "-"],
    { input: body },
  );
}

function markIssueInProgress(repo, number, label, assignee) {
  run("gh", [
    "issue",
    "edit",
    String(number),
    "-R",
    repo,
    "--add-label",
    label,
    "--add-assignee",
    assignee,
  ]);
}

function markIssueReadyForReview(repo, number, label) {
  run("gh", [
    "issue",
    "edit",
    String(number),
    "-R",
    repo,
    "--add-label",
    label,
  ]);
}

function ensureLabel(repo, label, color, description) {
  const labels = JSON.parse(
    run("gh", [
      "label",
      "list",
      "-R",
      repo,
      "--search",
      label,
      "--json",
      "name",
    ]),
  );
  if (!labels.some((candidate) => candidate.name === label)) {
    run("gh", [
      "label",
      "create",
      label,
      "-R",
      repo,
      "--color",
      color,
      "--description",
      description,
    ]);
  }
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
}

function assertCommand(command, versionArgs) {
  try {
    run(command, versionArgs, { stdio: "ignore" });
  } catch {
    throw new Error(`Required command is not available: ${command}`);
  }
}

function run(command, commandArgs, options = {}) {
  const commandSpec = commands[command] ?? { file: command, argsPrefix: [] };
  return execFileSync(
    commandSpec.file,
    [...commandSpec.argsPrefix, ...commandArgs],
    {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: options.stdio ?? [
        options.input === undefined ? "ignore" : "pipe",
        "pipe",
        "inherit",
      ],
      input: options.input,
    },
  );
}

function resolveCommand(command) {
  if (process.platform !== "win32") return { file: command, argsPrefix: [] };
  try {
    const candidates = execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (command === "codex") {
      const codexSpec = resolveCodexShim(candidates);
      if (codexSpec) return codexSpec;
    }
    return {
      file:
        candidates.find((candidate) =>
          candidate.toLowerCase().endsWith(".exe"),
        ) ??
        candidates.find((candidate) => !/\.[^\\/]+$/u.test(candidate)) ??
        candidates[0] ??
        command,
      argsPrefix: [],
    };
  } catch {
    return { file: command, argsPrefix: [] };
  }
}

function resolveCodexShim(candidates) {
  for (const candidate of candidates) {
    if (!candidate.toLowerCase().endsWith(".cmd")) continue;
    const basedir = dirname(candidate);
    const codexJs = join(
      basedir,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (!existsSync(codexJs)) continue;
    const siblingNode = join(basedir, "node.exe");
    return {
      file: existsSync(siblingNode) ? siblingNode : "node",
      argsPrefix: [codexJs],
    };
  }
  return null;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (rawKey === "dry-run") {
      parsed[rawKey] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${rawKey}`);
    parsed[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
