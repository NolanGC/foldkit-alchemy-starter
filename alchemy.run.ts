import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";

import ChatService from "./backend/src/ChatService.ts";
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
    const chat = yield* ChatService;
    const path = yield* Path;

    const website = yield* Cloudflare.Website.Vite("Website", {
      rootDir: path.resolve(import.meta.dirname, "frontend"),
      dev: { port: 1337, strictPort: true },
      assets: {
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_CHAT_SERVICE_URL: chat.url.as<string>(),
      },
    });

    // Website ⇄ ChatService is intentionally circular: the site needs the
    // chat URL at build time, and the chat worker needs the site's origin
    // for its credentialed-CORS allowlist (`Auth.ts` reads FRONTEND_ORIGIN
    // from its environment). Alchemy resolves the cycle via bindings.
    yield* chat.bind("FRONTEND_ORIGIN", {
      bindings: [
        {
          type: "plain_text",
          name: "FRONTEND_ORIGIN",
          text: website.url.as<string>(),
        },
      ],
    });

    return {
      chatUrl: chat.url.as<string>(),
      websiteUrl: website.url.as<string>(),
      branchId: branch.branchId,
      hyperdriveId: hd.hyperdriveId,
    };
  }),
);
