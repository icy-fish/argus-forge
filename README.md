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

1. find open issues in `icy-fish/argus-forge` created in the last 14 days by `icy-fish` with no assignees and no labels;
2. create a clean temporary Git worktree for each issue;
3. send each issue description and comments to `codex exec`;
4. label the issue `doing` and assign it to `icy-fish`;
5. commit Codex changes to an issue branch, push it, and open a PR that references the issue.

Local changes in the main checkout are ignored because issue implementation happens in isolated worktrees under the system temp directory by default.

Preview matching issues without changing GitHub or git state:

```bash
pnpm issues:codex -- --dry-run
```

Useful options:

```bash
pnpm issues:codex -- --days 7 --limit 20 --base main --codex-model gpt-5 --worktree-dir D:\tmp\argus-forge-worktrees
```

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

```bash
ARGUS_FORGE_INGEST_URL=http://localhost:4000/v1/ingest/events pi
```

If you do not want auto-discovery, run Pi with the extension explicitly:

```bash
ARGUS_FORGE_INGEST_URL=http://localhost:4000/v1/ingest/events pi -e ./.pi/extensions/argus-forge/index.ts
```

Optional settings:

- `ARGUS_FORGE_AGENT_NAME`: agent name stored on events, default `pi`.
- `ARGUS_FORGE_PROJECT_ID`: project id, default is a slug from the current working directory.
- `ARGUS_FORGE_PROJECT_NAME`: project display name, default is the current directory name.
- `ARGUS_FORGE_FLUSH_INTERVAL_MS`: queue flush interval, default `1000`.
- `ARGUS_FORGE_FLUSH_TIMEOUT_MS`: per-request ingest timeout, default `2000`.
- `ARGUS_FORGE_BATCH_SIZE`: max events per POST, default `100` and capped at `500`.
- `ARGUS_FORGE_MAX_QUEUE_SIZE`: bounded in-memory queue length while the API is unavailable, default `5000`.
- `ARGUS_FORGE_MAX_RETRY_ATTEMPTS`: retry attempts before dropping an undeliverable batch, default `3`.
- `ARGUS_FORGE_EMIT_STREAM_CHUNKS`: set to `1` or `true` to emit throttled `llm.stream.chunk` previews; disabled by default to keep local SQLite volume low.

The extension sends `{ "events": [...] }` only to `POST /v1/ingest/events`. It redacts common secret-shaped fields and stores truncated previews for prompts, tool arguments, and tool results. The API remains unauthenticated, so run it only in a trusted local environment or behind your own access controls.

## Dashboard

Open `http://localhost:5173` for aggregate metrics and charts. Use `/sessions` to browse runs, then open a session detail page for per-session metrics, nested spans, and raw event JSON.

## Limitations

This MVP has no authentication, uses local SQLite storage, and stores raw event payloads for debugging. Pricing is a local static table in `packages/shared/src/costs.ts`; unknown provider/model combinations return `null` cost instead of a fabricated estimate. There is no automatic instrumentation SDK in this version.
