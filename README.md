# WIP - Foldkit+Alchemy Starter

A small full-stack starter (live chat app with channels) that combines Foldkit and Alchemy for building
apps end-to-end with Effect, running on Cloudflare with Neon Postgres via Hyperdrive.

This repo is a work in progress. The goal is to build a strongly opinionated stack
designed to dramatically improve the effectiveness of building apps with agents. Please contribute!

TODOs:

- Opentelemetry integration with Axiom and instrumentation inside Effect services
- Documentation for agents
- Payments scaffolding

## Setup

```sh
bun install
echo "NEON_API_KEY=..." > .env
bun dev
```

That's it — `bun dev` prompts a Cloudflare login (OAuth) on first run and provisions
everything else (Neon branch, Hyperdrive, workers) automatically.

## Structure

Following the [single-stack monorepo Alchemy example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/monorepo-single-stack).

```txt
alchemy.run.ts        # shared Alchemy stack
backend/src/          # Effect HTTP API, Worker service, Drizzle schema
frontend/src/         # Foldkit app and Foldkit tests
test/                 # Alchemy integration tests
```
