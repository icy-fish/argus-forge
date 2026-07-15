# Argus Forge Observability MVP

Local observability for generic coding-agent LLM and tool traces. The project collects HTTP trace events in a Fastify API backed by SQLite/Prisma and visualizes sessions, timelines, and aggregate metrics in a React dashboard.

## Setup

```bash
pnpm install
cp .env.example apps/api/.env
pnpm db:migrate
pnpm --filter @argus-forge/api seed
pnpm dev
```

The API listens on `http://localhost:4000` and the dashboard runs on `http://localhost:5173`.

API logging defaults to `API_LOG_LEVEL=info` with detailed HTTP request logging disabled. To trace request URL, headers, and body while debugging locally, set `API_LOG_LEVEL=debug` and `API_HTTP_REQUEST_LOG_DETAILS=true`.

## Verification

```bash
pnpm test
pnpm build
```

## GitHub Issue Handling Workflow

Run the unified Codex issue workflow:

```bash
pnpm codex:handle-github-issue
```

The command uses the local `gh`, `codex`, and `git` commands. It fetches open
issues from `icy-fish/argus-forge` that were created within the last 7 days,
then dispatches every matching issue in turn:

1. Issues with no assignee and no label go to the analysis workflow. It labels
   the issue `doing`, assigns it to `icy-fish`, runs Codex in Plan mode in a
   reusable read-only checkout, posts the analysis, and adds `review needed`.
2. Issues labeled `comments to be resolved` go to the plan-update workflow.
   It resumes the latest recorded Codex session when possible, incorporates
   comments posted after the latest analysis, posts the revised plan, and adds
   `review needed`.
3. Issues labeled `ready to go` go to the implementation workflow. It creates
   an isolated worktree, runs Codex with workspace write access, verifies and
   commits the changes, pushes a feature branch, and opens a pull request.

Issues that do not match one of these states are left unchanged. If both
workflow labels are present, `comments to be resolved` takes precedence so
review feedback is incorporated before implementation.

Preview matching issues without changing GitHub or git state:

```bash
pnpm codex:handle-github-issue -- --dry-run
```

Useful options:

```bash
pnpm codex:handle-github-issue -- --repo icy-fish/argus-forge --days 7 --limit 20 --base main --codex-model gpt-5 --workspace-dir D:\tmp\argus-forge-workspaces
```

Use `--repo` to select another GitHub project, `--days` and `--limit` to adjust
the single fetch, and `--base`, `--codex-model`, `--workspace-dir`,
`--assignee`, `--doing-label`, or `--review-label` to configure the dispatched
workflows. `--workspace-dir` is reused directly for analysis and plan updates;
implementation creates a separate per-issue checkout beneath it. At most 20
isolated implementation worktrees are retained per repository.

Useful API checks:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/v1/sessions
curl http://localhost:4000/v1/metrics/summary
```

## Ingestion

Single event:

```bash
curl -X POST http://localhost:4000/v1/ingest/event \
  -H "content-type: application/json" \
  -d '{
    "type": "llm.request.completed",
    "eventId": "evt-demo-1",
    "sessionId": "session-demo",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "agentName": "codex",
    "projectId": "argus-forge-demo",
    "spanId": "span-llm-1",
    "parentSpanId": "session-demo",
    "provider": "openai",
    "model": "gpt-4o-mini",
    "status": "completed",
    "promptTokens": 1200,
    "completionTokens": 260,
    "cachedTokens": 100,
    "latencyMs": 1800,
    "finishReason": "stop"
  }'
```

Batch events:

```bash
curl -X POST http://localhost:4000/v1/ingest/events \
  -H "content-type: application/json" \
  -d '{
    "events": [
      {
        "type": "session.started",
        "eventId": "session-demo-start",
        "sessionId": "session-demo",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "agentName": "codex",
        "projectId": "argus-forge-demo",
        "spanId": "session-demo",
        "title": "Demo trace",
        "status": "running"
      },
      {
        "type": "tool.call.completed",
        "eventId": "tool-demo-1",
        "sessionId": "session-demo",
        "timestamp": "2026-01-01T00:00:04.000Z",
        "agentName": "codex",
        "projectId": "argus-forge-demo",
        "spanId": "tool-span-1",
        "parentSpanId": "span-llm-1",
        "toolName": "shell_command",
        "status": "completed",
        "argumentsSummary": "run tests",
        "resultSummary": "all tests passed",
        "exitStatus": "0",
        "latencyMs": 520
      }
    ]
  }'
```

## Event Lifecycle

Every event needs a stable `eventId`, shared `sessionId`, ISO `timestamp`, and `agentName`. Clients should reuse `spanId` across start/completion/failure events so the backend can pair lifecycle records. `parentSpanId` is optional, but enables nested timelines. Completion-only LLM and tool events are accepted and create completed spans directly.

Supported event types are `session.started`, `session.updated`, `llm.request.started`, `llm.request.completed`, `llm.request.failed`, `llm.stream.chunk`, `tool.call.started`, `tool.call.completed`, `tool.call.failed`, and `agent.log`.

Duplicate `eventId` values are treated as no-ops and do not create duplicate raw events, spans, request rows, tool calls, or usage metrics.

## Pi Extension

This repo includes a project-local Pi extension at `.pi/extensions/argus-forge/index.ts`. After the project is trusted, Pi can auto-discover the extension and send session, LLM, model, and tool telemetry to the Argus Forge ingestion API.

By default, the extension posts batches to:

```bash
http://localhost:4000/v1/ingest/events
```

Override the target endpoint when the API runs elsewhere:

```json
{
  "ingestUrl": "http://localhost:4000/v1/ingest/events"
}
```

Save persistent settings as `.pi/extensions/argus-forge/argus-forge.settings.json`. A full example is available at `.pi/extensions/argus-forge/argus-forge.settings.example.json`. Environment variables still override the settings file for one-off runs.

If you do not want auto-discovery, run Pi with the extension explicitly:

```bash
pi -e ./.pi/extensions/argus-forge/index.ts
```

Optional settings:

- `ingestUrl` / `ARGUS_FORGE_INGEST_URL`: ingest endpoint, default `http://localhost:4000/v1/ingest/events`.
- `agentName` / `ARGUS_FORGE_AGENT_NAME`: agent name stored on events, default `pi`.
- `projectId` / `ARGUS_FORGE_PROJECT_ID`: project id, default is a slug from the current working directory.
- `projectName` / `ARGUS_FORGE_PROJECT_NAME`: project display name, default is the current directory name.
- `flushIntervalMs` / `ARGUS_FORGE_FLUSH_INTERVAL_MS`: queue flush interval, default `1000`.
- `flushTimeoutMs` / `ARGUS_FORGE_FLUSH_TIMEOUT_MS`: per-request ingest timeout, default `2000`.
- `batchSize` / `ARGUS_FORGE_BATCH_SIZE`: max events per POST, default `100` and capped at `500`.
- `maxQueueSize` / `ARGUS_FORGE_MAX_QUEUE_SIZE`: bounded in-memory queue length while the API is unavailable, default `5000`.
- `maxRetryAttempts` / `ARGUS_FORGE_MAX_RETRY_ATTEMPTS`: retry attempts before dropping an undeliverable batch, default `3`.
- `emitStreamChunks` / `ARGUS_FORGE_EMIT_STREAM_CHUNKS`: set to `true` in JSON or `1`/`true` in the environment to emit throttled `llm.stream.chunk` previews; disabled by default to keep local SQLite volume low.
- `logLevel` / `ARGUS_FORGE_LOG_LEVEL`: extension log level, default `warn`; supported values are `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and `silent`.
- `httpRequestLogDetails` / `ARGUS_FORGE_HTTP_REQUEST_LOG_DETAILS`: set to `true` in JSON or `1`/`true` in the environment to log ingest request URL, headers, and body at `debug` level; disabled by default.

The extension sends `{ "events": [...] }` only to `POST /v1/ingest/events`. It redacts common secret-shaped fields and stores truncated previews for prompts, tool arguments, and tool results. The API remains unauthenticated, so run it only in a trusted local environment or behind your own access controls.

## Dashboard

Open `http://localhost:5173` for aggregate metrics and charts. Use `/sessions` to browse runs, then open a session detail page for per-session metrics, nested spans, and raw event JSON.

## Limitations

This MVP has no authentication, uses local SQLite storage, and stores raw event payloads for debugging. Pricing is a local static table in `packages/shared/src/costs.ts`; unknown provider/model combinations return `null` cost instead of a fabricated estimate. There is no automatic instrumentation SDK in this version.
