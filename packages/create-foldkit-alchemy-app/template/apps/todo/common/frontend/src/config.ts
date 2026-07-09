// Always injected by Alchemy (localhost:1339 under `alchemy dev`, the
// deterministic workers.dev URL on deploys) — see alchemy.run.ts. Builds
// only ever run through Alchemy, so absence is a wiring bug, not a mode.
const url = import.meta.env.VITE_API_URL;
if (url === undefined) {
  throw new Error("VITE_API_URL is not set.");
}
export const API_URL: string = url;
