// Exercises the generator against the real snapshotted templates (built by
// `bun run build:templates`, which the package `test` script runs first).
//
// The "installs and typechecks" tests are the drift alarm for this package:
// they bun-install, tsc, and (for the todo variants) run the generated
// frontend's own vitest suite, so a starter-repo change that breaks either
// the transforms or a generated app fails here.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

import {
  generate,
  ProjectName,
  type App,
  type AuthChoice,
  type DbProvider,
  type StateBackend,
} from "../src/Generate.ts";

const packageDir = path.resolve(import.meta.dirname, "..");
const templatesDir = path.join(packageDir, "templates");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "create-foldkit-"));

const scaffold = async (
  name: string,
  app: App,
  db: DbProvider,
  auth: AuthChoice = "better-auth",
  state: StateBackend = "local",
  desktop = false,
) => {
  const targetDir = path.join(tmp, name);
  await Effect.runPromise(
    generate({
      name: S.decodeSync(ProjectName)(name),
      app,
      db,
      auth,
      desktop,
      state,
      targetDir,
      templatesDir,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return targetDir;
};

const read = (dir: string, relative: string) =>
  fs.readFileSync(path.join(dir, relative), "utf8");

const exists = (dir: string, relative: string) =>
  fs.existsSync(path.join(dir, relative));

const INSTALL_AND_TYPECHECK_TIMEOUT = 600_000;

const runIn = (cwd: string, command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  expect(
    result.status,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  ).toBe(0);
};

test("scaffolds a chat + Neon app", async () => {
  const dir = await scaffold("chat-app", "chat", "neon");

  const pkg = JSON.parse(read(dir, "package.json"));
  expect(pkg.name).toBe("chat-app");
  expect(pkg.workspaces).toEqual(["backend", "frontend"]);
  expect(pkg.scripts.build).toBe("tsc --noEmit");
  expect(pkg.scripts.test).toBe("bun run --cwd frontend test");
  expect(pkg.patchedDependencies).toBeDefined();

  const db = read(dir, "backend/src/Db.ts");
  expect(db).toContain("export const PostgresLive = NeonPostgresLive;");
  expect(db).not.toContain("Planetscale");

  const stack = read(dir, "alchemy.run.ts");
  expect(stack).toContain('"ChatApp"');
  expect(stack).not.toContain("Planetscale");
  expect(stack).toContain("chat-app-web-${dnsSafeStage}");
  expect(stack).toContain("https://chat-app-chat-${dnsSafeStage}");
  // Default state backend is local (see scaffold()'s default arg).
  expect(stack).toContain("state: Alchemy.localState(),");
  expect(stack).not.toContain("Cloudflare.state()");

  expect(read(dir, "backend/src/ChatService.ts")).toContain(
    "name: `chat-app-chat-${stage",
  );

  const readme = read(dir, "README.md");
  expect(readme).toContain("# chat-app");
  expect(readme).toContain("live chat app with channels");
  expect(readme).toContain("NEON_API_KEY");
  expect(readme).not.toContain("__");
  expect(read(dir, ".env.example")).toContain("NEON_API_KEY=");

  // The derived chat integration test: opt-in guard, local state, no CI
  // remnants, and only the selected db provider.
  expect(pkg.scripts["test:integ"]).toBe("INTEG=1 bun test test/integ.test.ts");
  const integ = read(dir, "test/integ.test.ts");
  expect(integ).toContain('process.env.INTEG !== "1"');
  expect(integ).toContain("state: Alchemy.localState(),");
  expect(integ).toContain("ChatProtocol");
  expect(integ).not.toContain("process.env.CI");
  expect(integ).not.toContain("skipIf");
  expect(integ).not.toContain("Planetscale");

  // Repo-local entries and build artifacts must not leak into templates.
  expect(read(dir, ".gitignore")).not.toContain("repos/");
  expect(exists(dir, "backend/.alchemy")).toBe(false);
  expect(exists(dir, "frontend/dist")).toBe(false);
  expect(exists(dir, "bun.lock")).toBe(false);

  // Desktop is opt-in: no shell, no orphaned scripts pointing at it.
  expect(exists(dir, "packages")).toBe(false);
  expect(pkg.scripts["dev:desktop"]).toBeUndefined();
  expect(pkg.scripts["build:desktop"]).toBeUndefined();
  expect(readme).not.toContain("Desktop app");
});

test("scaffolds a chat app with the desktop shell", async () => {
  const dir = await scaffold(
    "chat-native",
    "chat",
    "neon",
    "better-auth",
    "local",
    true,
  );

  const pkg = JSON.parse(read(dir, "package.json"));
  expect(pkg.workspaces).toEqual(["backend", "frontend", "packages/desktop"]);
  expect(pkg.scripts["dev:desktop"]).toBe("bun run --cwd packages/desktop dev");
  expect(pkg.scripts["build:desktop"]).toBe(
    "bun run --cwd packages/desktop build",
  );

  expect(exists(dir, "packages/desktop/src-tauri/src/main.rs")).toBe(true);
  expect(exists(dir, "packages/desktop/src-tauri/icons/icon.icns")).toBe(true);
  // Rust build output and Tauri's generated schemas must not ship.
  expect(exists(dir, "packages/desktop/src-tauri/target")).toBe(false);
  expect(exists(dir, "packages/desktop/src-tauri/gen")).toBe(false);

  const conf = read(dir, "packages/desktop/src-tauri/tauri.conf.json");
  expect(conf).toContain('"productName": "chat-native"');
  expect(conf).toContain('"identifier": "dev.foldkit.chat-native"');
  expect(conf).not.toContain("Foldkit Chat");

  expect(read(dir, "packages/desktop/src-tauri/Cargo.toml")).toContain(
    'name = "chat-native-desktop"',
  );

  const readme = read(dir, "README.md");
  expect(readme).toContain("## Desktop app");
  expect(readme).toContain("dev:desktop");
});

test("scaffolds a chat app with remote (Cloudflare) state", async () => {
  const dir = await scaffold(
    "chat-remote-state",
    "chat",
    "neon",
    "better-auth",
    "cloudflare",
  );

  const stack = read(dir, "alchemy.run.ts");
  expect(stack).toContain("state: Cloudflare.state(),");
  expect(stack).not.toContain("Alchemy.localState()");

  const readme = read(dir, "README.md");
  expect(readme).toContain("stored remotely on Cloudflare");
});

test("scaffolds a chat + PlanetScale app", async () => {
  const dir = await scaffold("chat-ps-app", "chat", "planetscale");

  const db = read(dir, "backend/src/Db.ts");
  expect(db).toContain("export const PostgresLive = PlanetscalePostgresLive;");
  expect(db).not.toContain('import * as Neon from "alchemy/Neon"');
  expect(db).not.toContain("NeonPostgresLive");

  const stack = read(dir, "alchemy.run.ts");
  expect(stack).not.toContain('import * as Neon from "alchemy/Neon"');
  expect(stack).not.toContain("Neon.providers()");
  expect(stack).toContain("Planetscale.providers()");

  const integ = read(dir, "test/integ.test.ts");
  expect(integ).toContain("Planetscale.providers()");
  expect(integ).not.toContain('import * as Neon from "alchemy/Neon"');
  expect(integ).not.toContain("Neon.providers()");

  expect(read(dir, ".env.example")).toContain("PLANETSCALE_API_TOKEN=");
});

test("scaffolds a todo + auth + Neon app", async () => {
  const dir = await scaffold("todo-app", "todo", "neon", "better-auth");

  // Chat is fully replaced by the todo overlay.
  expect(exists(dir, "backend/src/ChatService.ts")).toBe(false);
  expect(exists(dir, "backend/src/ChatProtocol.ts")).toBe(false);
  expect(exists(dir, "backend/src/ChatPersistenceService.ts")).toBe(false);
  expect(exists(dir, "backend/src/DurableObject.ts")).toBe(false);
  expect(exists(dir, "frontend/src/page/chat.ts")).toBe(false);
  // Migrations regenerate from the todo schema on first deploy.
  expect(exists(dir, "migrations")).toBe(false);
  expect(exists(dir, "scripts")).toBe(false);

  // Shared modules are inherited from the base snapshot, not copies.
  expect(exists(dir, "backend/src/Auth.ts")).toBe(true);
  expect(exists(dir, "backend/src/auth-schema.ts")).toBe(true);
  expect(exists(dir, "frontend/src/page/login.ts")).toBe(true);
  expect(exists(dir, "frontend/src/auth.ts")).toBe(true);

  const service = read(dir, "backend/src/TodoService.ts");
  expect(service).toContain("name: `todo-app-api-${stage");
  expect(service).toContain("makeAuthGate");
  expect(service).not.toContain("__PROJECT_NAME__");

  const stack = read(dir, "alchemy.run.ts");
  expect(stack).toContain('"TodoApp"');
  expect(stack).toContain("todo-app-web-${dnsSafeStage}");
  expect(stack).toContain("https://todo-app-api-${dnsSafeStage}");
  expect(stack).not.toContain("Planetscale");
  expect(stack).not.toContain("__STACK_NAME__");

  const schema = read(dir, "backend/src/schema.ts");
  expect(schema).toContain('export * from "./auth-schema.ts"');
  expect(schema).toContain('pgTable(\n  "todos"');

  const pkg = JSON.parse(read(dir, "package.json"));
  expect(pkg.dependencies["better-auth"]).toBeDefined();

  // The chat integration test is replaced by the todo overlay's own, which
  // signs up real users and exercises per-user isolation.
  const integ = read(dir, "test/integ.test.ts");
  expect(integ).toContain("sign-up/email");
  expect(integ).toContain("bobPatch");
  expect(integ).not.toContain("ChatProtocol");
  const pkgScripts = pkg.scripts as Record<string, string>;
  expect(pkgScripts["test:integ"]).toBe("INTEG=1 bun test test/integ.test.ts");

  const readme = read(dir, "README.md");
  expect(readme).toContain("simple CRUD todo list");
  expect(readme).toContain("generates the initial Drizzle migration");
});

test("scaffolds a todo app without auth", async () => {
  const dir = await scaffold("todo-open", "todo", "planetscale", "none");

  for (const gone of [
    "backend/src/Auth.ts",
    "backend/src/auth-schema.ts",
    "backend/src/UserId.ts",
    "frontend/src/auth.ts",
    "frontend/src/page",
  ]) {
    expect(exists(dir, gone), gone).toBe(false);
  }

  const schema = read(dir, "backend/src/schema.ts");
  expect(schema).not.toContain("auth-schema");
  expect(schema).not.toContain("userId");

  expect(read(dir, "backend/src/TodoService.ts")).not.toContain("BetterAuth");
  expect(read(dir, "frontend/src/main.ts")).not.toContain("Login");

  const pkg = JSON.parse(read(dir, "package.json"));
  expect(pkg.dependencies["better-auth"]).toBeUndefined();
  const backendPkg = JSON.parse(read(dir, "backend/package.json"));
  expect(backendPkg.dependencies["better-auth"]).toBeUndefined();

  const stack = read(dir, "alchemy.run.ts");
  expect(stack).toContain("Planetscale.providers()");
  expect(stack).not.toContain("Neon.providers()");

  // The open todo app's integration test has no session handling.
  const integ = read(dir, "test/integ.test.ts");
  expect(integ).toContain("without a session");
  expect(integ).not.toContain("cookie");
  expect(integ).not.toContain('import * as Neon from "alchemy/Neon"');
  expect(integ).not.toContain("Neon.providers()");
});

test("refuses chat without auth", async () => {
  expect(scaffold("chat-open", "chat", "neon", "none")).rejects.toThrow(
    "chat app requires BetterAuth",
  );
});

test("refuses a non-empty target directory", async () => {
  const dir = path.join(tmp, "occupied");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "keep.txt"), "");
  expect(scaffold("occupied", "chat", "neon")).rejects.toThrow("not empty");
});

test(
  "chat + Neon app installs, typechecks, lints and is formatted",
  () => {
    const dir = path.join(tmp, "chat-app");
    runIn(dir, "bun", ["install"]);
    runIn(dir, "bun", ["run", "build"]);
    runIn(dir, "bun", ["run", "lint"]);
    runIn(dir, "bun", ["run", "format:check"]);
  },
  INSTALL_AND_TYPECHECK_TIMEOUT,
);

test(
  "chat + PlanetScale app installs and typechecks",
  () => {
    const dir = path.join(tmp, "chat-ps-app");
    runIn(dir, "bun", ["install"]);
    runIn(dir, "bun", ["run", "build"]);
  },
  INSTALL_AND_TYPECHECK_TIMEOUT,
);

test(
  "todo + auth app installs, typechecks, lints, is formatted, and its tests pass",
  () => {
    const dir = path.join(tmp, "todo-app");
    runIn(dir, "bun", ["install"]);
    runIn(dir, "bun", ["run", "build"]);
    runIn(dir, "bun", ["run", "lint"]);
    runIn(dir, "bun", ["run", "format:check"]);
    runIn(dir, "bun", ["run", "test"]);
  },
  INSTALL_AND_TYPECHECK_TIMEOUT,
);

test(
  "todo app without auth installs, typechecks, and its tests pass",
  () => {
    const dir = path.join(tmp, "todo-open");
    runIn(dir, "bun", ["install"]);
    runIn(dir, "bun", ["run", "build"]);
    runIn(dir, "bun", ["run", "test"]);
  },
  INSTALL_AND_TYPECHECK_TIMEOUT,
);

test("CLI end-to-end with flags", () => {
  const result = spawnSync(
    "bun",
    [
      path.join(packageDir, "src/bin.ts"),
      "e2e-app",
      "--app",
      "todo",
      "--db",
      "planetscale",
      "--auth",
      "none",
      "--yes",
    ],
    { cwd: tmp, encoding: "utf8" },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Next steps");
  const pkg = JSON.parse(read(path.join(tmp, "e2e-app"), "package.json"));
  expect(pkg.name).toBe("e2e-app");
}, 60_000);
