import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";
import * as Output from "alchemy/Output";

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
    const browserBackendUrl = Output.map(backend.url.as<string>(), (url) =>
      url.replace("http://localhost:", "http://127.0.0.1:"),
    );

    const website = yield* Cloudflare.Website.Vite("Website", {
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      env: {
        VITE_API_URL: browserBackendUrl,
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
