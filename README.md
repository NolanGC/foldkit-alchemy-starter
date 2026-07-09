# WIP - Foldkit+Alchemy Starter

A small full-stack starter (live chat app with channels) that combines Foldkit and Alchemy for building
apps end-to-end with Effect, running on Cloudflare with Postgres (Neon or
PlanetScale) via Hyperdrive.

This repo is a work in progress. The goal is to build a strongly opinionated stack
designed to dramatically improve the effectiveness of building apps with agents. Please contribute!

TODOs:

- Opentelemetry integration with Axiom and instrumentation inside Effect services
- Documentation for agents
- Payments scaffolding

## Quick start

Scaffold your own app with the CLI — no need to clone this repo:

```sh
bun create foldkit-alchemy-app@latest
```

It'll prompt you through the example app (live chat or a CRUD todo list), a
Postgres provider (Neon or PlanetScale), whether to include BetterAuth, and
where Alchemy should store deployment state (local by default).
## Working on this repo

The sections below are for developing on the starter itself (this repo),
not for scaffolding a new app — use `bun create` above for that.

### Setup

```sh
bun install
echo "NEON_API_KEY=..." > .env
bun dev
```

`bun dev` prompts a Cloudflare login (OAuth) on first run and provisions
everything else (Postgres branch, Hyperdrive, workers) automatically.

Postgres is provided through the `Postgres` service in `backend/src/Db.ts`, with
two interchangeable layers: `NeonPostgresLive` (free tier) and
`PlanetscalePostgresLive`. Point the `PostgresLive` export in
`backend/src/Db.ts` at either layer to switch providers — nothing else
changes. PlanetScale needs
`PLANETSCALE_API_TOKEN_ID`, `PLANETSCALE_API_TOKEN`, and
`PLANETSCALE_ORGANIZATION` in `.env` instead of `NEON_API_KEY`.

### Structure

Following the [single-stack monorepo Alchemy example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/monorepo-single-stack).

```txt
alchemy.run.ts        # shared Alchemy stack
backend/src/          # Effect HTTP API, Worker service, Drizzle schema
frontend/src/         # Foldkit app and Foldkit tests
test/                 # Alchemy integration tests
```
