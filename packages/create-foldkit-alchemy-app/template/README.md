# __PROJECT_NAME__

A full-stack starter (__APP_DESCRIPTION__) that combines
[Foldkit](https://foldkit.dev) and [Alchemy](https://alchemy.run) for building
apps end-to-end with Effect, running on Cloudflare with Postgres
(__DB_TITLE__) via Hyperdrive.

## Setup

```sh
bun install
__ENV_SETUP__
bun dev
```

That's it — `bun dev` prompts a Cloudflare login (OAuth) on first run and
provisions everything else (Postgres branch, Hyperdrive, workers)
automatically.

Postgres is provided through the `Postgres` service in `backend/src/Db.ts`;
everything else depends on that service, never on the provider directly.

## Structure

```txt
alchemy.run.ts        # shared Alchemy stack
backend/src/          # Effect HTTP API, Worker service, Drizzle schema
frontend/src/         # Foldkit app and Foldkit tests
migrations/           # Drizzle migrations, applied on deploy
test/                 # integration test (deploys real infrastructure)
```
__APP_NOTES__
## Scripts

| Script                   | What it does                                     |
| ------------------------ | ------------------------------------------------ |
| `bun dev`                | Run the whole stack locally                      |
| `bun run deploy`         | Deploy the `production` stage                    |
| `bun run destroy`        | Tear the deployed stage down                     |
| `bun run dev:branch`     | Dev against a stage named after your git branch  |
| `bun run deploy:branch`  | Deploy a stage named after your git branch       |
| `bun run destroy:branch` | Destroy that branch stage                        |
| `bun run test`           | Frontend (Foldkit) tests                         |
| `bun run test:integ`     | Integration tests (deploys real infrastructure!) |
| `bun run build`          | Typecheck                                        |
| `bun run lint`           | Lint (oxlint)                                    |
| `bun run format`         | Format (oxfmt)                                   |

__DESKTOP_NOTE__## Cloud deploys

Deploys need `CLOUDFLARE_WORKERS_SUBDOMAIN` in `.env` — your account's
`workers.dev` subdomain, shown by `wrangler whoami`. See `.env.example` for
every variable this app reads.

## Deployment state

__STATE_NOTE__

## Integration tests

`bun run test:integ` deploys a disposable copy of the whole stack (Postgres
branch, migrations, Hyperdrive, both workers) to real Cloudflare and
__DB_TITLE__ infrastructure, runs API-level tests against it, and destroys
it afterwards. It needs the same credentials as a cloud deploy: the
__DB_TITLE__ variables from `.env.example`, `CLOUDFLARE_WORKERS_SUBDOMAIN`,
and a Cloudflare login (`wrangler` OAuth, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` in CI). Each run costs real deploy/destroy cycles;
nothing runs unless you invoke it explicitly.
