import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_REPO = "icy-fish/argus-forge";
export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_LIMIT = 100;
export const MAX_COMMENT_LENGTH = 60_000;

export const commands = {
  gh: resolveCommand("gh"),
  codex: resolveCommand("codex"),
  git: resolveCommand("git"),
};

export function defaultWorkspace(repo) {
  return join(tmpdir(), "github-issue-analysis", repo.replaceAll("/", "-"));
}

export function getIssue(repo, number) {
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

export function prepareReusableCheckout({ repo, baseBranch, checkoutPath }) {
  mkdirSync(dirname(checkoutPath), { recursive: true });
  if (!existsSync(join(checkoutPath, ".git"))) {
    if (existsSync(checkoutPath))
      throw new Error(
        `Reusable workspace exists but is not a Git checkout: ${checkoutPath}`,
      );
    run("gh", ["repo", "clone", repo, checkoutPath, "--", "--no-checkout"]);
  } else {
    const origin = run("git", ["remote", "get-url", "origin"], {
      cwd: checkoutPath,
    }).trim();
    if (
      !origin
        .toLowerCase()
        .replace(/\.git$/u, "")
        .endsWith(repo.toLowerCase())
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

export async function runCodexAnalysis({
  prompt,
  model,
  cwd,
  issueNumber,
  resumeSessionId,
}) {
  const outputFile = join(
    dirname(cwd),
    `.issue-${issueNumber}-codex-output.md`,
  );
  rmSync(outputFile, { force: true });
  const commonArgs = [
    "--json",
    "--output-last-message",
    outputFile,
    "--config",
    'collaboration_mode="plan"',
  ];
  const codexArgs = resumeSessionId
    ? [
        "exec",
        "--cd",
        cwd,
        "--sandbox",
        "read-only",
        "resume",
        ...commonArgs,
        ...(model ? ["--model", model] : []),
        resumeSessionId,
        "-",
      ]
    : [
        "exec",
        "--cd",
        cwd,
        "--sandbox",
        "read-only",
        ...commonArgs,
        ...(model ? ["--model", model] : []),
        "-",
      ];
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
      sessionId: extractSessionId(jsonl) ?? resumeSessionId,
      content: readFileSync(outputFile, "utf8"),
    };
  } finally {
    rmSync(outputFile, { force: true });
  }
}

export function codexSessionExists(
  sessionId,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
) {
  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return false;
  const pending = [sessionsDir];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
      else if (entry.name.includes(sessionId)) return true;
    }
  }
  return false;
}

export function addAnalysisComment(repo, number, { sessionId, content }) {
  let body = [
    "## Codex issue analysis",
    "",
    `Codex session: ${sessionId}`,
    "",
    content.trim(),
  ].join("\n");
  if (body.length > MAX_COMMENT_LENGTH)
    body = `${body.slice(0, MAX_COMMENT_LENGTH)}\n\n_Analysis truncated to fit GitHub's comment limit._`;
  run(
    "gh",
    ["issue", "comment", String(number), "-R", repo, "--body-file", "-"],
    { input: body },
  );
}

export function ensureLabel(repo, label, color, description) {
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

export function editIssueLabels(repo, number, { add, remove }) {
  const args = ["issue", "edit", String(number), "-R", repo];
  if (add) args.push("--add-label", add);
  if (remove) args.push("--remove-label", remove);
  run("gh", args);
}

export function assertCommand(command, versionArgs) {
  try {
    run(command, versionArgs, { stdio: "ignore" });
  } catch {
    throw new Error(`Required command is not available: ${command}`);
  }
}

export function run(command, commandArgs, options = {}) {
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

export function parseArgs(argv) {
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

export function fail(message) {
  console.error(message);
  process.exit(1);
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
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
      /* Ignore non-JSON diagnostics. */
    }
  }
  return null;
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
        if (existsSync(codexJs))
          return {
            file: existsSync(join(basedir, "node.exe"))
              ? join(basedir, "node.exe")
              : "node",
            argsPrefix: [codexJs],
          };
      }
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
