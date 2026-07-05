import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/vitest-setup.ts"],
    env: {
      VITE_CHAT_SERVICE_URL: "http://localhost:8788",
    },
    server: {
      deps: {
        inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"],
      },
    },
  },
});
