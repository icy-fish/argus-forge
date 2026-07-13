#!/usr/bin/env node

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_REPO = "icy-fish/argus-forge";
const DEFAULT_AUTHOR = "icy-fish";
const DEFAULT_ASSIGNEE = "icy-fish";
const DEFAULT_LABEL = "doing";
const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 100;

const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? DEFAULT_REPO;
const author = args.author ?? DEFAULT_AUTHOR;
const assignee = args.assignee ?? DEFAULT_ASSIGNEE;
const doingLabel = args.label ?? DEFAULT_LABEL;
const days = Number(args.days ?? DEFAULT_DAYS);
const limit = Number(args.limit ?? DEFAULT_LIMIT);
const dryRun = Boolean(args["dry-run"]);
const codexModel = args["codex-model"];
const worktreeRoot = args["worktree-dir"] ?? join(tmpdir(), "argus-forge-codex-worktrees");
const commands = {
  gh: resolveCommand("gh"),
  codex: resolveCommand("codex"),
  git: resolveCommand("git"),
};

if (!Number.isInteger(days) || days <= 0) {
  fail("--days must be a positive integer");
}

if (!Number.isInteger(limit) || limit <= 0) {
  fail("--limit must be a positive integer");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main() {
  assertCommand("gh", ["--version"]);
  assertCommand("codex", ["--version"]);
  assertCommand("git", ["--version"]);

  const baseBranch = args.base ?? getDefaultBranch(repo);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const issues = listCandidateIssues({ repo, author, cutoffDate, limit }).filter(
    (issue) =>
      issue.state === "OPEN" &&
      issue.author?.login === author &&
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
    for (const issue of issues) {
      console.log(`#${issue.number}: ${issue.title} (${issue.url})`);
    }
    return;
  }

  ensureLabel(repo, doingLabel);
  fetchBaseBranch(baseBranch);

  for (const summary of issues) {
    const issue = getIssue(repo, summary.number);
    const branch = uniqueBranchName(
      `codex/issue-${issue.number}-${slugify(issue.title)}`,
    );
    let worktreePath;

    console.log(`\nHandling #${issue.number}: ${issue.title}`);

    try {
      worktreePath = createIssueWorktree({ baseBranch, branch, issueNumber: issue.number });
      const prompt = buildCodexPrompt({ issue, repo, baseBranch, worktreePath });

      console.log(`Starting Codex with issue context in ${worktreePath}.`);
      const codexProcess = startCodex(prompt, codexModel, worktreePath);

      try {
        markIssueInProgress(repo, issue.number, doingLabel, assignee);
      } catch (error) {
        codexProcess.kill("SIGTERM");
        throw error;
      }

      const codexExitCode = await waitForProcess(codexProcess);
      if (codexExitCode !== 0) {
        throw new Error(`Codex failed for #${issue.number} with exit code ${codexExitCode}`);
      }

      const status = gitStatus(worktreePath);
      if (!status) {
        console.log(`Codex made no changes for #${issue.number}; skipping PR creation.`);
        continue;
      }

      run("git", ["add", "-A"], { cwd: worktreePath });
      run(
        "git",
        [
          "commit",
          "-m",
          `Fix #${issue.number}: ${truncate(issue.title, 60)}`,
          "-m",
          `Closes #${issue.number}`,
        ],
        { cwd: worktreePath },
      );
      run("git", ["push", "-u", "origin", branch], { cwd: worktreePath });
      run(
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
          `Fix #${issue.number}: ${issue.title}`,
          "--body",
          [
            `Closes #${issue.number}`,
            "",
            `Original issue: ${issue.url}`,
            "",
            "Implemented by Codex via the issue handling workflow.",
          ].join("\n"),
        ],
        { cwd: worktreePath },
      );
    } finally {
      if (worktreePath) {
        removeIssueWorktree(worktreePath);
      }
    }
  }
}

function listCandidateIssues({ repo, author, cutoffDate, limit }) {
  const search = `created:>=${cutoffDate} no:assignee no:label`;
  const stdout = run("gh", [
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--author",
    author,
    "--search",
    search,
    "--limit",
    String(limit),
    "--json",
    "number,title,createdAt,state,author,assignees,labels,url",
  ]);
  return JSON.parse(stdout);
}

function getIssue(repo, number) {
  const stdout = run("gh", [
    "issue",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,title,body,createdAt,updatedAt,state,author,assignees,labels,comments,url",
  ]);
  return JSON.parse(stdout);
}

function buildCodexPrompt({ issue, repo, baseBranch, worktreePath }) {
  const comments = issue.comments
    .map(
      (comment, index) =>
        `### Comment ${index + 1} by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}\n\n${comment.body || "(empty)"}`,
    )
    .join("\n\n");

  return [
    "You are working in the existing repository checkout.",
    "",
    "Implement the GitHub issue below.",
    "",
    "Rules:",
    "- Keep the change scoped to the issue.",
    "- Inspect the codebase before editing.",
    "- Follow AGENTS.md and existing package conventions.",
    "- Run validation appropriate to the changed package, using pnpm scripts when applicable.",
    "- Do not commit, push, create branches, edit the GitHub issue, or create a pull request. The wrapper workflow handles those steps.",
    "",
    `Repository: ${repo}`,
    `Base branch: ${baseBranch}`,
    `Worktree: ${worktreePath}`,
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
    "## Comments",
    "",
    comments || "(none)",
  ].join("\n");
}

function startCodex(prompt, model, cwd) {
  const codexArgs = [
    "exec",
    "--cd",
    cwd,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
  ];

  if (model) {
    codexArgs.push("--model", model);
  }

  codexArgs.push("-");

  const child = spawn(commands.codex.file, [...commands.codex.argsPrefix, ...codexArgs], {
    cwd,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });

  child.stdin.end(prompt);
  return child;
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
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

function ensureLabel(repo, label) {
  const stdout = run("gh", [
    "label",
    "list",
    "-R",
    repo,
    "--search",
    label,
    "--json",
    "name",
  ]);
  const labels = JSON.parse(stdout);
  const exists = labels.some((candidate) => candidate.name === label);

  if (!exists) {
    run("gh", [
      "label",
      "create",
      label,
      "-R",
      repo,
      "--color",
      "FBCA04",
      "--description",
      "Issue is currently being handled",
    ]);
  }
}

function getDefaultBranch(repo) {
  const stdout = run("gh", [
    "repo",
    "view",
    repo,
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]);
  return stdout.trim();
}

function fetchBaseBranch(baseBranch) {
  run("git", ["fetch", "origin", baseBranch]);
}

function createIssueWorktree({ baseBranch, branch, issueNumber }) {
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreePath = mkdtempSync(join(worktreeRoot, `issue-${issueNumber}-`));
  run("git", ["worktree", "add", "-b", branch, worktreePath, `origin/${baseBranch}`]);
  return worktreePath;
}

function removeIssueWorktree(worktreePath) {
  try {
    run("git", ["worktree", "remove", "--force", worktreePath], { stdio: "ignore" });
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
    run("git", ["worktree", "prune"], { stdio: "ignore" });
  }
}

function gitStatus(cwd = process.cwd()) {
  return run("git", ["status", "--porcelain"], { cwd }).trim();
}

function uniqueBranchName(baseName) {
  const base = baseName.slice(0, 80).replace(/-+$/u, "");
  if (!refExists(base) && !remoteBranchExists(base)) {
    return base;
  }

  const suffix = new Date()
    .toISOString()
    .replace(/[-:TZ.]/gu, "")
    .slice(0, 14);
  return `${base}-${suffix}`;
}

function refExists(ref) {
  try {
    run("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function remoteBranchExists(branch) {
  try {
    run("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
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

  return execFileSync(commandSpec.file, [...commandSpec.argsPrefix, ...commandArgs], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
}

function resolveCommand(command) {
  if (process.platform !== "win32") {
    return { file: command, argsPrefix: [] };
  }

  try {
    const stdout = execFileSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidates = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    if (command === "codex") {
      const codexSpec = resolveCodexShim(candidates);
      if (codexSpec) {
        return codexSpec;
      }
    }

    return {
      file:
        candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe")) ??
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
    if (!candidate.toLowerCase().endsWith(".cmd")) {
      continue;
    }

    const basedir = dirname(candidate);
    const codexJs = join(basedir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(codexJs)) {
      continue;
    }

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
    if (arg === "--") {
      continue;
    }

    if (!arg.startsWith("--")) {
      fail(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (rawKey === "dry-run") {
      parsed[rawKey] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${rawKey}`);
    }

    parsed[rawKey] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
