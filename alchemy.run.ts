import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";

import Service from "./backend/src/Service.ts";
import { Hyperdrive, NeonDb } from "./backend/src/Db.ts";

export default Alchemy.Stack(
  "CloudflareNeonDrizzleExample",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      Neon.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { branch } = yield* NeonDb;
    const hd = yield* Hyperdrive;
    const backend = yield* Service;
    const path = yield* Path;

    const website = yield* Cloudflare.Website.Vite("Website", {
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      env: {
        VITE_API_URL: backend.url.as<string>(),
      },
    });

    return {
      backendUrl: backend.url.as<string>(),
      websiteUrl: website.url.as<string>(),
      branchId: branch.branchId,
      hyperdriveId: hd.hyperdriveId,
    };
  }),
);
