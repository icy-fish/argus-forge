# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

Argus Forge is a pnpm TypeScript workspace for a local observability MVP for coding-agent traces.

- `apps/api`: Fastify API backed by Prisma and SQLite.
- `apps/web`: React/Vite dashboard for sessions, timelines, and metrics.
- `packages/shared`: Shared event schemas, API types, and cost helpers.

## Working Rules

- Use `pnpm`; the repository is pinned to `pnpm@9.15.4`.
- Keep changes scoped to the package that owns the behavior.
- Prefer shared schemas and types from `@argus-forge/shared` over duplicating contracts in app packages.
- Build `@argus-forge/shared` before running API code that imports its built output.
- Do not commit local `.env` files, SQLite databases, generated build output, or dependency folders.

## Common Commands

```bash
pnpm install
cp .env.example apps/api/.env
pnpm db:migrate
pnpm --filter @argus-forge/api seed
pnpm dev
```

Root verification:

```bash
pnpm test
pnpm build
pnpm typecheck
pnpm lint
```

Package-level checks:

```bash
pnpm --filter @argus-forge/shared build
pnpm --filter @argus-forge/api test
pnpm --filter @argus-forge/web build
```

## Runtime Notes

- API dev server: `http://localhost:4000`
- Web dev server: `http://localhost:5173`
- Useful health checks:
  - `GET /health`
  - `GET /v1/sessions`
  - `GET /v1/metrics/summary`

## Code Organization

- API routes live in `apps/api/src/routes`.
- API business logic lives in `apps/api/src/services`.
- API utilities live in `apps/api/src/utils`.
- Web API clients and query hooks live in `apps/web/src/api`.
- Web pages live in `apps/web/src/pages`.
- Reusable web components live in `apps/web/src/components`.
- Shared contracts live in `packages/shared/src`.

## Testing and Validation

- API tests use Vitest via `pnpm --filter @argus-forge/api test`.
- TypeScript `lint` scripts currently run `tsc --noEmit`; there is no separate ESLint setup.
- Run `pnpm build` before handing off changes that touch shared contracts, API behavior, or web build paths.
- For database-related changes, run Prisma generation/migration commands through the API package scripts.

## Data Contract Notes

- Trace ingestion events require stable `eventId`, shared `sessionId`, ISO `timestamp`, and `agentName`.
- Reuse `spanId` across lifecycle events so the backend can pair start/completion/failure records.
- `parentSpanId` is optional but should be preserved when available for nested timelines.
- Duplicate `eventId` values are expected to be treated as no-ops.
