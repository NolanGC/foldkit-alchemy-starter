# WIP - Foldkit+Alchemy Starter

A small full-stack starter that combines Foldkit and Alchemy for building
apps end-to-end with Effect.

Infra stack currently centers around Cloudflare with Neon connected via Hyperdrive for
Postgres.

This repo is a work in progress. The goal is to build a strongly opinionated stack
designed to dramatically improve the effectiveness of building apps with agents. Please contribute!

TODOs:

- Auth integration with BetterAuth
- Migration to a slightly more complex multi-page example to include more Foldkit features
- Opentelemetry integration with Axiom and instrumentation inside Effect services
- Documentation for agents
- Payments scaffolding

## Setup

With Nix and direnv:

```sh
direnv allow
bun install
```

Without Nix:

```sh
bun install
```

Credentials for Cloudflare/Neon are still provided through your normal Alchemy
setup and local environment.

## Structure

```txt
alchemy.run.ts        # shared Alchemy stack (following the [single-stack monorepo Alchemy example](https://github.com/alchemy-run/alchemy-effect/tree/main/examples/monorepo-single-stack))
backend/src/          # Effect HTTP API, Worker service, Drizzle schema
frontend/src/         # Foldkit app and Foldkit tests
test/                 # Alchemy integration tests
```
