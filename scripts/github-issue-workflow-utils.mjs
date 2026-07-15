import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_REPO = "icy-fish/argus-forge";
export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_LIMIT = 100;
export const MAX_COMMENT_LENGTH = 60_000;
export const MAX_ISOLATED_CHECKOUTS = 20;
export const WORKTREE_PRUNE_ARGS = ["worktree", "prune", "--expire", "now"];
const ISOLATED_CHECKOUT_MAX_AGE_MS = 86_400_000;

export const commands = {
  gh: resolveCommand("gh"),
  codex: resolveCommand("codex"),
  git: resolveCommand("git"),
};

export function defaultWorkspace(repo) {
  return join(
    codexWorkspaceRoot(),
    "analysis",
    repo.replaceAll("/", "-"),
  );
}

export function defaultImplementationWorkspace(repo, issueNumber) {
  return join(
    codexWorkspaceRoot(),
    "implementation",
    repo.replaceAll("/", "-"),
    `issue-${issueNumber}-${Date.now()}`,
  );
}

function codexWorkspaceRoot() {
  return resolve(
    process.env.ARGUS_FORGE_CODEX_WORKSPACE_ROOT ??
      join(process.cwd(), ".codex-workspaces"),
  );
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
  const repositoryPath = prepareLocalRepository(repo, baseBranch);
  if (
    existsSync(checkoutPath) &&
    !isManagedWorktree(repositoryPath, checkoutPath)
  ) {
    const gitDirectory = join(checkoutPath, ".git");
    if (!existsSync(gitDirectory))
      throw new Error(
        `Reusable workspace exists but is not a Git checkout: ${checkoutPath}`,
      );
    const origin = run("git", ["remote", "get-url", "origin"], {
      cwd: checkoutPath,
    }).trim();
    if (
      !origin.toLowerCase().replace(/\.git$/u, "").endsWith(repo.toLowerCase())
    )
      throw new Error(
        `Reusable workspace origin does not match ${repo}: ${origin}`,
      );
    rmSync(checkoutPath, { recursive: true, force: true });
  }
  if (!existsSync(checkoutPath)) {
    mkdirSync(dirname(checkoutPath), { recursive: true });
    run(
      "git",
      ["worktree", "add", "--detach", checkoutPath, `origin/${baseBranch}`],
      { cwd: repositoryPath },
    );
  } else {
    assertManagedWorktree(repositoryPath, checkoutPath, "Reusable workspace");
    run("git", ["reset", "--hard", `origin/${baseBranch}`], {
      cwd: checkoutPath,
    });
    run("git", ["clean", "-fd"], { cwd: checkoutPath });
  }
  console.log(`Reusable analysis checkout is current at ${checkoutPath}.`);
}

export function prepareIsolatedCheckout({
  repo,
  baseBranch,
  checkoutPath,
  branch,
}) {
  if (existsSync(checkoutPath))
    throw new Error(`Implementation workspace already exists: ${checkoutPath}`);
  const repositoryPath = prepareLocalRepository(repo, baseBranch);
  enforceIsolatedCheckoutLimit(repositoryPath);
  mkdirSync(dirname(checkoutPath), { recursive: true });
  run(
    "git",
    ["worktree", "add", "-b", branch, checkoutPath, `origin/${baseBranch}`],
    { cwd: repositoryPath },
  );
  const registry = readIsolatedRegistry(repositoryPath);
  registry.push({ path: checkoutPath, createdAt: Date.now() });
  writeIsolatedRegistry(repositoryPath, registry);
  console.log(`Isolated implementation checkout is ready at ${checkoutPath}.`);
}

function prepareLocalRepository(repo, baseBranch) {
  const repositoryPath = join(
    tmpdir(),
    "github-issue-repositories",
    repo.replaceAll("/", "-"),
  );
  mkdirSync(dirname(repositoryPath), { recursive: true });
  if (!existsSync(join(repositoryPath, ".git"))) {
    if (existsSync(repositoryPath))
      throw new Error(
        `Repository cache exists but is not a Git checkout: ${repositoryPath}`,
      );
    run("gh", ["repo", "clone", repo, repositoryPath, "--", "--no-checkout"]);
  } else {
    const origin = run("git", ["remote", "get-url", "origin"], {
      cwd: repositoryPath,
    }).trim();
    if (
      !origin.toLowerCase().replace(/\.git$/u, "").endsWith(repo.toLowerCase())
    )
      throw new Error(`Repository cache origin does not match ${repo}: ${origin}`);
  }
  run("git", ["fetch", "origin", baseBranch, "--prune"], { cwd: repositoryPath });
  run("git", WORKTREE_PRUNE_ARGS, {
    cwd: repositoryPath,
  });
  return repositoryPath;
}

function assertManagedWorktree(repositoryPath, checkoutPath, description) {
  if (!existsSync(join(checkoutPath, ".git")))
    throw new Error(
      `${description} exists but is not a Git worktree: ${checkoutPath}`,
    );
  if (!isManagedWorktree(repositoryPath, checkoutPath))
    throw new Error(
      `${description} does not belong to the repository cache: ${checkoutPath}`,
    );
}

function isManagedWorktree(repositoryPath, checkoutPath) {
  if (!existsSync(join(checkoutPath, ".git"))) return false;
  const commonDirectory = run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: checkoutPath },
  ).trim();
  return (
    resolve(commonDirectory).toLowerCase() ===
    resolve(repositoryPath, ".git").toLowerCase()
  );
}

function enforceIsolatedCheckoutLimit(repositoryPath, now = Date.now()) {
  let registry = readIsolatedRegistry(repositoryPath).filter(({ path }) =>
    existsSync(path),
  );
  const removals = isolatedCheckoutsToRemove(registry, now);
  for (const checkout of removals)
    removeIsolatedWorktree(repositoryPath, checkout.path);
  registry = registry.filter((checkout) => !removals.includes(checkout));
  writeIsolatedRegistry(repositoryPath, registry);
}

export function isolatedCheckoutsToRemove(registry, now = Date.now()) {
  if (registry.length < MAX_ISOLATED_CHECKOUTS) return [];
  const ordered = [...registry].sort((a, b) => a.createdAt - b.createdAt);
  const removals = ordered.filter(
    ({ createdAt }) => now - createdAt >= ISOLATED_CHECKOUT_MAX_AGE_MS,
  );
  const retained = ordered.filter((checkout) => !removals.includes(checkout));
  while (retained.length >= MAX_ISOLATED_CHECKOUTS)
    removals.push(retained.shift());
  return removals;
}

function removeIsolatedWorktree(repositoryPath, checkoutPath) {
  run("git", ["worktree", "remove", "--force", checkoutPath], {
    cwd: repositoryPath,
  });
}

function isolatedRegistryPath(repositoryPath) {
  return join(repositoryPath, ".git", "argus-forge-isolated-worktrees.json");
}

function readIsolatedRegistry(repositoryPath) {
  const path = isolatedRegistryPath(repositoryPath);
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeIsolatedRegistry(repositoryPath, registry) {
  writeFileSync(
    isolatedRegistryPath(repositoryPath),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
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
      env: codexChildEnv(cwd),
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

export async function runCodexImplementation({ prompt, model, cwd, issueNumber }) {
  const codexArgs = [
    "exec",
    "--cd",
    cwd,
    "--sandbox",
    "workspace-write",
    ...(model ? ["--model", model] : []),
    "-",
  ];
  const child = spawn(
    commands.codex.file,
    [...commands.codex.argsPrefix, ...codexArgs],
    {
      cwd,
      env: codexChildEnv(cwd),
      stdio: ["pipe", "inherit", "inherit"],
      shell: false,
    },
  );
  child.stdin.end(prompt);
  const exitCode = await waitForProcess(child);
  if (exitCode !== 0)
    throw new Error(
      `Codex implementation failed for #${issueNumber} with exit code ${exitCode}`,
    );
}

export function codexChildEnv(cwd, environment = process.env) {
  const count = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isInteger(count) && count >= 0 ? count : 0;
  return {
    ...environment,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "safe.directory",
    [`GIT_CONFIG_VALUE_${index}`]: resolve(cwd),
  };
}

export function latestAnalysisContext(comments) {
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
    analysis: ordered[analysisIndex],
    history: ordered.slice(0, analysisIndex + 1),
    feedback: ordered.slice(analysisIndex + 1),
  };
}

export function renderComments(comments) {
  return (
    comments
      .map(
        (comment, index) =>
          `### Comment ${index + 1} by ${comment.author?.login ?? "unknown"} at ${comment.createdAt}\n\n${comment.body || "(empty)"}`,
      )
      .join("\n\n") || "(none)"
  );
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
