import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import * as S from "effect/Schema";

// Also the scaffolded directory name, so the usual npm rules apply; the
// length cap keeps derived Cloudflare worker names (`<name>-chat-pr-123`)
// inside DNS label limits.
export const ProjectName = S.String.check(
  S.isPattern(/^[a-z][a-z0-9-]*$/),
  S.isMaxLength(30),
).pipe(S.brand("ProjectName"));
export type ProjectName = typeof ProjectName.Type;

export const PROJECT_NAME_HINT =
  "lowercase letters, digits and dashes, starting with a letter (max 30 chars)";

export const apps = ["chat", "todo"] as const;
export type App = (typeof apps)[number];

export const dbProviders = ["neon", "planetscale"] as const;
export type DbProvider = (typeof dbProviders)[number];

export const authChoices = ["better-auth", "none"] as const;
export type AuthChoice = (typeof authChoices)[number];

export const stateBackends = ["local", "cloudflare"] as const;
export type StateBackend = (typeof stateBackends)[number];

const dbTitle: Record<DbProvider, string> = {
  neon: "Neon",
  planetscale: "PlanetScale",
};

const appDescription: Record<App, string> = {
  chat: "live chat app with channels",
  todo: "simple CRUD todo list",
};

export class GenerateError extends Data.TaggedError("GenerateError")<{
  readonly message: string;
}> {}

// Every rewrite of a snapshotted file asserts how often its anchor text
// occurs, so when the starter repo drifts the tests fail loudly here
// instead of silently shipping an untransformed template.
const replaceCounted = (
  file: string,
  content: string,
  from: string,
  to: string,
  expected: number,
): Effect.Effect<string, GenerateError> => {
  const count = content.split(from).length - 1;
  if (count !== expected) {
    return Effect.fail(
      new GenerateError({
        message: `${file}: expected ${expected} occurrence(s) of ${JSON.stringify(from)}, found ${count} — the starter repo and the generator transforms have drifted`,
      }),
    );
  }
  return Effect.succeed(content.split(from).join(to));
};

// Removes [start, end-of-`end`) once. Used to cut the unselected provider's
// layer out of Db.ts; `end` is the block's closing `);` at column zero.
const cutBlock = (
  file: string,
  content: string,
  start: string,
  end: string,
): Effect.Effect<string, GenerateError> => {
  const startIdx = content.indexOf(start);
  if (startIdx === -1 || content.indexOf(start, startIdx + 1) !== -1) {
    return Effect.fail(
      new GenerateError({
        message: `${file}: expected exactly one occurrence of ${JSON.stringify(start)} — the starter repo and the generator transforms have drifted`,
      }),
    );
  }
  const endIdx = content.indexOf(end, startIdx);
  if (endIdx === -1) {
    return Effect.fail(
      new GenerateError({
        message: `${file}: no ${JSON.stringify(end)} after ${JSON.stringify(start)}`,
      }),
    );
  }
  return Effect.succeed(
    content.slice(0, startIdx) + content.slice(endIdx + end.length),
  );
};

const collapseBlankLines = (content: string) =>
  content.replace(/\n{3,}/g, "\n\n");

const otherProvider: Record<DbProvider, "Neon" | "Planetscale"> = {
  neon: "Planetscale",
  planetscale: "Neon",
};

const activeLayer: Record<DbProvider, string> = {
  neon: "NeonPostgresLive",
  planetscale: "PlanetscalePostgresLive",
};

// The snapshot ships both provider layers; keep only the selected one so the
// generated app contains a single `PostgresLive` implementation.
const transformDb = (db: DbProvider, content: string) =>
  Effect.gen(function* () {
    const file = "backend/src/Db.ts";
    const other = otherProvider[db];
    let out = yield* replaceCounted(
      file,
      content,
      `import * as ${other} from "alchemy/${other}";\n`,
      "",
      1,
    );
    out = yield* cutBlock(
      file,
      out,
      `export const ${other}PostgresLive = Layer.effect(`,
      "\n);\n",
    );
    out = yield* replaceCounted(
      file,
      out,
      "/**\n * The active database provider — swap between `NeonPostgresLive` and\n * `PlanetscalePostgresLive` here; nothing else changes.\n */\nexport const PostgresLive = NeonPostgresLive;",
      `/** The active database provider. */\nexport const PostgresLive = ${activeLayer[db]};`,
      1,
    );
    return collapseBlankLines(out);
  });

const pascalCase = (name: ProjectName) =>
  name
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

// Removes the unselected provider's import and providers() entry; applies
// to both apps' alchemy.run.ts and test/integ.test.ts (the todo overlay
// keeps identical lines; the two files differ only in indentation).
const removeUnusedDbProvider = (
  db: DbProvider,
  content: string,
  file: string,
  indent: string,
) =>
  Effect.gen(function* () {
    const other = otherProvider[db];
    let out = yield* replaceCounted(
      file,
      content,
      `import * as ${other} from "alchemy/${other}";\n`,
      "",
      1,
    );
    out = yield* replaceCounted(
      file,
      out,
      `${indent}${other}.providers(),\n`,
      "",
      1,
    );
    return out;
  });

// `Cloudflare.state()` persists deployment state remotely, keyed by (stack
// name, stage) — shared across every clone/machine using the same names, so
// unrelated projects that happen to reuse a name and the default
// `dev_${USER}` stage can see each other's stale resources. `local` avoids
// that entirely (state lives in `.alchemy/`, gitignored) at the cost of not
// being resumable from a different machine or checkout.
const transformStateBackend = (backend: StateBackend, content: string) =>
  backend === "cloudflare"
    ? Effect.succeed(content)
    : replaceCounted(
        "alchemy.run.ts",
        content,
        "state: Cloudflare.state(),",
        "state: Alchemy.localState(),",
        1,
      );

const transformChatAlchemyRun = (name: ProjectName, content: string) =>
  Effect.gen(function* () {
    const file = "alchemy.run.ts";
    let out = yield* replaceCounted(
      file,
      content,
      '"CloudflareNeonDrizzleExample"',
      `"${pascalCase(name)}"`,
      1,
    );
    // Worker names are namespaced with the project name so two generated
    // apps on the same Cloudflare account don't collide per stage. The
    // website prefix appears in the worker `name` and in `websiteUrl`; the
    // chat prefix here (in `chatUrl`) must match ChatService.ts's own
    // stage-derived `name`, rewritten identically below. The chat URL is
    // rewritten first: doing the website prefix first would mint a fresh
    // `https://chat-` occurrence whenever the project name starts with
    // "chat".
    out = yield* replaceCounted(
      file,
      out,
      "https://chat-",
      `https://${name}-chat-`,
      1,
    );
    out = yield* replaceCounted(file, out, "foldkitchat-", `${name}-web-`, 2);
    return out;
  });

const transformChatService = (name: ProjectName, content: string) =>
  replaceCounted(
    "backend/src/ChatService.ts",
    content,
    "name: `chat-${stage",
    `name: \`${name}-chat-\${stage`,
    1,
  );

const transformRootPackageJson = (name: ProjectName, content: string) =>
  Effect.try({
    try: () => {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      pkg.name = name;
      // The starter repo's packages/ workspace (this CLI) is not part of the
      // template, and its root test script runs test/integ.test.ts, which is
      // excluded too (it deploys real infrastructure).
      pkg.workspaces = ["backend", "frontend"];
      const scripts = pkg.scripts as Record<string, string>;
      scripts.build = "tsc --noEmit";
      scripts.test = "bun run --cwd frontend test";
      // Opt-in (INTEG=1): deploys and destroys a real stack, so it must
      // never run as a side effect of a bare `bun test`.
      scripts["test:integ"] = "INTEG=1 bun test test/integ.test.ts";
      return `${JSON.stringify(pkg, null, 2)}\n`;
    },
    catch: (cause) =>
      new GenerateError({ message: `package.json: ${String(cause)}` }),
  });

const envSetup: Record<DbProvider, string> = {
  neon: 'echo "NEON_API_KEY=..." > .env',
  planetscale: "cp .env.example .env  # then fill in the PlanetScale values",
};

const envExample: Record<DbProvider, string> = {
  neon: `# Neon API key — https://console.neon.tech (Account settings → API keys).
NEON_API_KEY=
`,
  planetscale: `# PlanetScale service token — https://app.planetscale.com
# (Organization settings → Service tokens).
PLANETSCALE_API_TOKEN_ID=
PLANETSCALE_API_TOKEN=
PLANETSCALE_ORGANIZATION=
`,
};

const cloudflareEnvExample = `
# Required for cloud deploys (\`bun run deploy\`): your account's workers.dev
# subdomain, shown by \`wrangler whoami\`. Not needed for \`bun dev\`.
#CLOUDFLARE_WORKERS_SUBDOMAIN=
`;

// The first `bun dev` of a todo app generates the initial Drizzle migration
// (alchemy's Drizzle.Schema diffs against an empty baseline when
// migrations/ is missing), so the overlay ships without one.
const appNotes: Record<App, string> = {
  chat: "",
  todo: `
> The first \`bun dev\` (or deploy) generates the initial Drizzle migration
> into \`migrations/\` — commit it.
`,
};

const stateNote: Record<StateBackend, string> = {
  local: `Deployment state lives in \`.alchemy/\` on disk (gitignored) — nothing
to configure, but it only knows what *this* checkout has deployed. Deleting
the folder or cloning it fresh elsewhere loses track of what's live; you'd
need to destroy the old deployment manually (Cloudflare / Neon / PlanetScale
dashboards) before it becomes an orphaned, still-billing resource. Switch to
\`Cloudflare.state()\` in \`alchemy.run.ts\` if you need to resume deploys
from another machine or a team needs to share one.`,
  cloudflare: `Deployment state is stored remotely on Cloudflare, keyed by
stack name + stage (stage defaults to \`dev_$USER\`) — so \`bun dev\`/\`bun
run deploy\` are resumable from any machine or fresh checkout. The tradeoff:
if you ever reuse this project's name for an unrelated app on the same
Cloudflare account and stage, they'll share state. Switch to
\`Alchemy.localState()\` in \`alchemy.run.ts\` for a project-local
alternative (state then lives in \`.alchemy/\`, gitignored).`,
};

// Chat-app files the todo overlay replaces or has no use for. migrations/
// and scripts/ go too: the todo schema regenerates its migrations on first
// deploy, and generate-migration.ts requires an existing snapshot. test/
// holds the chat integration test; the overlay ships its own.
const todoDeletions = [
  "backend/src/ChatService.ts",
  "backend/src/ChatProtocol.ts",
  "backend/src/ChatPersistenceService.ts",
  "backend/src/DurableObject.ts",
  "frontend/src/page/chat.ts",
  "migrations",
  "scripts",
  "test",
];

// Auth files only make sense with BetterAuth; frontend/src/page holds only
// the login submodel once chat.ts is gone.
const noAuthDeletions = [
  "backend/src/Auth.ts",
  "backend/src/auth-schema.ts",
  "frontend/src/auth.ts",
  "frontend/src/page",
];

const removeBetterAuthDependency = (content: string) =>
  Effect.try({
    try: () => {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const dependencies = pkg.dependencies as Record<string, string>;
      delete dependencies["better-auth"];
      return `${JSON.stringify(pkg, null, 2)}\n`;
    },
    catch: (cause) =>
      new GenerateError({ message: `package.json: ${String(cause)}` }),
  });

export interface GenerateOptions {
  readonly name: ProjectName;
  readonly app: App;
  readonly db: DbProvider;
  readonly auth: AuthChoice;
  readonly state: StateBackend;
  /** Absolute path of the directory to scaffold into. */
  readonly targetDir: string;
  /** The built templates/ directory of this package. */
  readonly templatesDir: string;
}

export const generate = ({
  app,
  auth,
  db,
  name,
  state,
  targetDir,
  templatesDir,
}: GenerateOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    if (app === "chat" && auth === "none") {
      return yield* Effect.fail(
        new GenerateError({
          message:
            "The chat app requires BetterAuth (identity is part of its protocol); --auth none is only available with --app todo.",
        }),
      );
    }

    if (yield* fs.exists(targetDir)) {
      const entries = yield* fs.readDirectory(targetDir);
      if (entries.length > 0) {
        return yield* Effect.fail(
          new GenerateError({
            message: `${targetDir} already exists and is not empty`,
          }),
        );
      }
      yield* fs.remove(targetDir);
    }

    yield* fs.copy(path.join(templatesDir, "base"), targetDir);

    const rewrite = (
      relative: string,
      transform: (content: string) => Effect.Effect<string, GenerateError>,
    ) =>
      Effect.gen(function* () {
        const file = path.join(targetDir, relative);
        const content = yield* fs.readFileString(file);
        yield* fs.writeFileString(file, yield* transform(content));
      });

    if (app === "todo") {
      const deletions =
        auth === "none"
          ? [...todoDeletions, ...noAuthDeletions]
          : todoDeletions;
      yield* Effect.forEach(deletions, (relative) =>
        fs.remove(path.join(targetDir, relative), { recursive: true }),
      );

      yield* fs.copy(path.join(templatesDir, "apps/todo/common"), targetDir, {
        overwrite: true,
      });
      yield* fs.copy(
        path.join(
          templatesDir,
          auth === "none" ? "apps/todo/no-auth" : "apps/todo/auth",
        ),
        targetDir,
        { overwrite: true },
      );

      // The overlay is written with name tokens; fill them in everywhere,
      // then verify none slipped through (e.g. a new overlay file the walk
      // missed would strand a literal token in the generated app).
      const files = yield* fs.readDirectory(targetDir, { recursive: true });
      yield* Effect.forEach(
        files.filter((file) => /\.(ts|html)$/.test(file)),
        (relative) =>
          Effect.gen(function* () {
            const file = path.join(targetDir, relative);
            const content = yield* fs.readFileString(file);
            const rendered = content
              .replaceAll("__PROJECT_NAME__", name)
              .replaceAll("__STACK_NAME__", pascalCase(name));
            if (/__(PROJECT_NAME|STACK_NAME)__/.test(rendered)) {
              return yield* Effect.fail(
                new GenerateError({
                  message: `${relative}: unrendered template token`,
                }),
              );
            }
            if (rendered !== content) {
              yield* fs.writeFileString(file, rendered);
            }
          }),
      );

      if (auth === "none") {
        yield* rewrite("package.json", removeBetterAuthDependency);
        yield* rewrite("backend/package.json", removeBetterAuthDependency);
      }
    }

    yield* rewrite("package.json", (c) => transformRootPackageJson(name, c));
    yield* rewrite("alchemy.run.ts", (c) =>
      removeUnusedDbProvider(db, c, "alchemy.run.ts", "      "),
    );
    yield* rewrite("alchemy.run.ts", (c) => transformStateBackend(state, c));
    yield* rewrite("test/integ.test.ts", (c) =>
      removeUnusedDbProvider(db, c, "test/integ.test.ts", "    "),
    );
    yield* rewrite("backend/src/Db.ts", (c) => transformDb(db, c));
    if (app === "chat") {
      yield* rewrite("alchemy.run.ts", (c) => transformChatAlchemyRun(name, c));
      yield* rewrite("backend/src/ChatService.ts", (c) =>
        transformChatService(name, c),
      );
    }

    const readme = yield* fs.readFileString(
      path.join(templatesDir, "README.md"),
    );
    yield* fs.writeFileString(
      path.join(targetDir, "README.md"),
      readme
        .replaceAll("__PROJECT_NAME__", name)
        .replaceAll("__APP_DESCRIPTION__", appDescription[app])
        .replaceAll("__APP_NOTES__", appNotes[app])
        .replaceAll("__DB_TITLE__", dbTitle[db])
        .replaceAll("__ENV_SETUP__", envSetup[db])
        .replaceAll("__STATE_NOTE__", stateNote[state]),
    );

    yield* fs.writeFileString(
      path.join(targetDir, ".env.example"),
      envExample[db] + cloudflareEnvExample,
    );
  });
