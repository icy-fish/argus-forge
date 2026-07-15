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

Run the Codex issue workflow:

```bash
pnpm issues:codex
```

The workflow uses the local `gh`, `codex`, and `git` commands to:

1. find open issues in `icy-fish/argus-forge` created in the last 7 days with no assignees and no labels;
2. clone or refresh a reusable checkout of the repository's latest default branch under the system temp directory;
3. label each issue `doing` and assign it to `icy-fish`;
4. run Codex in Plan mode and a read-only sandbox to either produce a grounded implementation plan or questions for every unclear requirement;
5. comment the analysis and Codex session ID on the issue, then add the `review needed` label.

The workflow never edits the analysis checkout, commits code, pushes branches, or opens pull requests.

Preview matching issues without changing GitHub or git state:

```bash
pnpm issues:codex -- --dry-run
```

Useful options:

```bash
pnpm issues:codex -- --repo icy-fish/argus-forge --days 7 --limit 20 --base main --codex-model gpt-5 --workspace-dir D:\tmp\argus-forge-analysis
```

Update plans after reviewers add feedback and label an issue `comments to be resolved`:

```bash
pnpm issues:codex:update-plans
```

This workflow orders issue comments chronologically, resumes the latest recorded Codex analysis session when it is available locally, and otherwise rebuilds its context from the issue and comment history. Issues without newer feedback are skipped. It removes `comments to be resolved` before running Codex in Plan mode in the same reusable read-only workspace, posts the revised plan or clarification questions, and adds `review needed`. Pass the same `--repo`, `--base`, `--limit`, `--codex-model`, `--workspace-dir`, or `--dry-run` options as needed.

Implement recently approved issues labeled `ready to go`:

```bash
pnpm issues:codex:implement -- --repo icy-fish/argus-forge
```

The implementation workflow finds open issues created within the last 7 days, removes `ready to go`, and creates a fresh isolated checkout from the latest `main` branch for each issue. Codex receives workspace write access and uses the issue description as the original requirement, the latest Codex analysis as its plan, and all later comments as additional requirements. It also checks whether project documentation needs updating and runs relevant verification. The workflow then commits the resulting changes, pushes a `codex/issue-...` feature branch, and opens a pull request to `main`. Issues without a Codex analysis comment are skipped without removing the label.

Preview the selection with `--dry-run`. Use `--days`, `--limit`, `--label`, `--base`, `--codex-model`, or `--workspace-dir` to override defaults; `--workspace-dir` is a parent directory under which per-issue checkouts are created.

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
