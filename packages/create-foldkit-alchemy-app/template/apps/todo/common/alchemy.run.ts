import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";

import { Hyperdrive, Postgres, PostgresLive } from "./backend/src/Db.ts";
import TodoServiceLive, { TodoService } from "./backend/src/TodoService.ts";

export default Alchemy.Stack(
  "__STACK_NAME__",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Neon.providers(),
      Planetscale.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { branchId } = yield* Postgres;
    const hd = yield* Hyperdrive;
    const path = yield* Path;
    const stage = yield* Alchemy.Stage;
    const { dev } = yield* Alchemy.AlchemyContext;

    // The account's workers.dev subdomain — fixed for this Cloudflare
    // account (`wrangler whoami` / dashboard), not per-stage. Set in .env
    // locally and in CI env for cloud deploys. Combined with each worker's
    // deterministic `name` (below), this makes both URLs plain strings known
    // before either resource deploys, so Website and TodoService never need
    // each other's live Output to configure VITE_API_URL / FRONTEND_ORIGIN —
    // no circular dependency, no bootstrap-order deploy required. Worker
    // names must be DNS-safe, so stage names like `dev_someone` are
    // sanitized. `alchemy dev` serves both workers locally on the strict
    // ports below, so dev cross-references point at localhost and don't need
    // the subdomain.
    const subdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
    if (!dev && subdomain === undefined) {
      return yield* Effect.die(
        new Error(
          "CLOUDFLARE_WORKERS_SUBDOMAIN must be set for cloud deploys (see `wrangler whoami`).",
        ),
      );
    }
    const dnsSafeStage = stage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const apiUrl = dev
      ? "http://localhost:1339"
      : `https://__PROJECT_NAME__-api-${dnsSafeStage}.${subdomain}.workers.dev`;
    const websiteUrl = dev
      ? "http://localhost:1337"
      : `https://__PROJECT_NAME__-web-${dnsSafeStage}.${subdomain}.workers.dev`;

    const api = yield* TodoService;

    yield* Cloudflare.Website.Vite("Website", {
      name: `__PROJECT_NAME__-web-${dnsSafeStage}`,
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      dev: { port: 1337, strictPort: true },
      assets: {
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_API_URL: apiUrl,
      },
    });

    yield* api.bind("FRONTEND_ORIGIN", {
      bindings: [
        { type: "plain_text", name: "FRONTEND_ORIGIN", text: websiteUrl },
      ],
    });

    return {
      apiUrl,
      websiteUrl,
      branchId,
      hyperdriveId: hd.hyperdriveId,
    };
  }).pipe(Effect.provide(TodoServiceLive), Effect.provide(PostgresLive)),
);
