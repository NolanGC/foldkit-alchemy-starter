import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { resolve } from "node:path";

const RENDER_TIMEOUT_MS = 5000;
const RENDER_POLL_INTERVAL_MS = 25;
const ROOT_PLACEHOLDER = '<div id="root"></div>';

const outdir = process.argv[2];
if (outdir === undefined || outdir === "") {
  throw new Error("Usage: bun scripts/prerender.ts <outdir>");
}
if (process.env.VITE_CHAT_SERVICE_URL === undefined) {
  throw new Error(
    "VITE_CHAT_SERVICE_URL must be set: app modules read it at import time.",
  );
}

const indexPath = resolve(outdir, "index.html");
const baseHtml = await Bun.file(indexPath).text();
if (!baseHtml.includes(ROOT_PLACEHOLDER)) {
  throw new Error(`${indexPath} does not contain ${ROOT_PLACEHOLDER}.`);
}

GlobalRegistrator.register({ url: "http://localhost/" });

const [{ Runtime }, main] = await Promise.all([
  import("foldkit"),
  import("../src/main"),
]);

const container = document.createElement("div");
container.id = "root";
document.body.appendChild(container);

Runtime.run(
  Runtime.makeApplication({
    Model: main.Model,
    Flags: main.Flags,
    flags: main.flags,
    init: main.init,
    update: main.update,
    view: main.view,
    subscriptions: main.subscriptions,
    managedResources: main.managedResources,
    container,
    routing: {
      onUrlRequest: (request) => main.ClickedLink({ request }),
      onUrlChange: (url) => main.ChangedUrl({ url }),
    },
  }),
);

const waitForRenderedRoot = async (): Promise<Element> => {
  const startedAt = Date.now();
  while (true) {
    const firstElement = document.body.firstElementChild;
    if (
      firstElement !== null &&
      firstElement.id !== "root" &&
      firstElement.children.length > 0
    ) {
      return firstElement;
    }
    if (Date.now() - startedAt > RENDER_TIMEOUT_MS) {
      throw new Error("Timed out waiting for the landing page to render.");
    }
    await new Promise((done) => setTimeout(done, RENDER_POLL_INTERVAL_MS));
  }
};

const renderedHtml = (await waitForRenderedRoot()).outerHTML;

await Bun.write(
  indexPath,
  baseHtml.replace(ROOT_PLACEHOLDER, `<div id="root">${renderedHtml}</div>`),
);

console.log(`Prerendered / into ${indexPath}`);
process.exit(0);
