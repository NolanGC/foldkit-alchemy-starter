import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

import tailwindcss from "@tailwindcss/vite";

const IMPORT_META_ENV_PREFIX = "import.meta.env.";

// Prerenders the landing page: after the client bundle is written,
// scripts/prerender.ts boots the app in happy-dom at `/` and injects the
// rendered HTML into dist index.html, so the landing is served as static
// markup. VITE_ vars are forwarded to the script because app modules read
// import.meta.env at import time; `config.define` covers builds driven by
// Alchemy (which injects env via define), `config.env` covers plain
// `vite build` runs.
const prerenderLanding = (): Plugin => {
  let config: ResolvedConfig;

  return {
    name: "prerender-landing",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    writeBundle: {
      sequential: true,
      handler(outputOptions) {
        const fileEnv = Object.fromEntries(
          Object.entries(config.env).filter(([key]) => key.startsWith("VITE_")),
        );
        const definedEnv = Object.fromEntries(
          Object.entries(config.define ?? {}).flatMap(([key, value]) =>
            key.startsWith(IMPORT_META_ENV_PREFIX)
              ? [
                  [
                    key.slice(IMPORT_META_ENV_PREFIX.length),
                    JSON.parse(String(value)),
                  ],
                ]
              : [],
          ),
        );
        const outdir = resolve(
          config.root,
          outputOptions.dir ?? config.build.outDir,
        );

        const result = spawnSync(
          "bun",
          [
            fileURLToPath(new URL("scripts/prerender.ts", import.meta.url)),
            outdir,
          ],
          {
            stdio: "inherit",
            env: { ...process.env, ...fileEnv, ...definedEnv },
          },
        );

        if (result.status !== 0) {
          throw new Error("Prerendering the landing page failed.");
        }
      },
    },
  };
};

export default defineConfig({
  plugins: [tailwindcss(), prerenderLanding()],
});
