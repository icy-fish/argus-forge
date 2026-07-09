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

## Dashboard

Open `http://localhost:5173` for aggregate metrics and charts. Use `/sessions` to browse runs, then open a session detail page for per-session metrics, nested spans, and raw event JSON.

## Limitations

This MVP has no authentication, uses local SQLite storage, and stores raw event payloads for debugging. Pricing is a local static table in `packages/shared/src/costs.ts`; unknown provider/model combinations return `null` cost instead of a fabricated estimate. There is no automatic instrumentation SDK in this version.
