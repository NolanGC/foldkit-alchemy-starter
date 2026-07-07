import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";

import ChatServiceLive, { ChatService } from "./backend/src/ChatService.ts";
import { Hyperdrive, NeonDb } from "./backend/src/Db.ts";

export default Alchemy.Stack(
  "CloudflareNeonDrizzleExample",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Neon.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { branch } = yield* NeonDb;
    const hd = yield* Hyperdrive;
    const path = yield* Path;
    const stage = yield* Alchemy.Stage;
    const { dev } = yield* Alchemy.AlchemyContext;

    // The account's workers.dev subdomain — fixed for this Cloudflare
    // account (`wrangler whoami` / dashboard), not per-stage. Set in .env
    // locally and in the GitHub workflow env for CI. Combined with each
    // worker's deterministic `name` (below), this makes both URLs plain
    // strings known before either resource deploys, so Website and
    // ChatService no longer need each other's live Output to configure
    // VITE_CHAT_SERVICE_URL / FRONTEND_ORIGIN — no circular dependency, no
    // bootstrap-order deploy required. Worker names must be DNS-safe, so
    // stage names like `dev_nolanclement` are sanitized. `alchemy dev`
    // serves both workers locally on the strict ports below, so dev
    // cross-references point at localhost and don't need the subdomain.
    const subdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN;
    if (!dev && subdomain === undefined) {
      return yield* Effect.die(
        new Error(
          "CLOUDFLARE_WORKERS_SUBDOMAIN must be set for cloud deploys (see `wrangler whoami`).",
        ),
      );
    }
    const dnsSafeStage = stage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const chatUrl = dev
      ? "http://localhost:1339"
      : `https://chat-${dnsSafeStage}.${subdomain}.workers.dev`;
    const websiteUrl = dev
      ? "http://localhost:1337"
      : `https://website-${dnsSafeStage}.${subdomain}.workers.dev`;

    const chat = yield* ChatService;

    yield* Cloudflare.Website.Vite("Website", {
      name: `website-${dnsSafeStage}`,
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      dev: { port: 1337, strictPort: true },
      assets: {
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_CHAT_SERVICE_URL: chatUrl,
      },
    });

    yield* chat.bind("FRONTEND_ORIGIN", {
      bindings: [
        { type: "plain_text", name: "FRONTEND_ORIGIN", text: websiteUrl },
      ],
    });

    return {
      chatUrl,
      websiteUrl,
      branchId: branch.branchId,
      hyperdriveId: hd.hyperdriveId,
    };
  }).pipe(Effect.provide(ChatServiceLive)),
);
