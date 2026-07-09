import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import * as S from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Prompt from "effect/unstable/cli/Prompt";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  apps,
  authChoices,
  dbProviders,
  generate,
  PROJECT_NAME_HINT,
  ProjectName,
  stateBackends,
  type App,
  type AuthChoice,
  type DbProvider,
  type StateBackend,
} from "./Generate.ts";

const decodeProjectName = S.decodeEffect(ProjectName);

const promptName = Prompt.text({
  message: "Project name",
  default: "my-foldkit-app",
  validate: (value) =>
    decodeProjectName(value).pipe(
      Effect.mapError(() => PROJECT_NAME_HINT),
      Effect.map(() => value),
    ),
}).pipe(Effect.flatMap(decodeProjectName), Effect.orDie);

const promptApp = Prompt.select<App>({
  message: "Which example app?",
  choices: [
    { title: "Live chat (rooms, websockets, auth)", value: "chat" },
    { title: "Simple CRUD todo list", value: "todo" },
  ],
});

const promptDb = Prompt.select<DbProvider>({
  message: "Postgres provider",
  choices: [
    { title: "Neon (has a free tier)", value: "neon" },
    { title: "PlanetScale", value: "planetscale" },
  ],
});

const promptAuth = Prompt.confirm({
  message: "Include BetterAuth (email + password sign-in)?",
  initial: true,
}).pipe(
  Effect.map((withAuth): AuthChoice => (withAuth ? "better-auth" : "none")),
);

const promptState = Prompt.select<StateBackend>({
  message: "Where should Alchemy store deployment state?",
  choices: [
    {
      title: "Local (.alchemy/ on disk — simplest, no cross-machine resume)",
      value: "local",
    },
    {
      title: "Cloudflare (remote — resumable from another machine/checkout)",
      value: "cloudflare",
    },
  ],
});

// Exit code of a spawned step, with the child sharing our terminal.
const run = (cwd: string, command: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    return yield* handle.exitCode;
  }).pipe(Effect.scoped);

// A fresh git history is nice-to-have: skip silently when git is missing
// and tolerate a failed commit (e.g. no user.name configured).
const gitInit = (cwd: string) =>
  Effect.gen(function* () {
    yield* run(cwd, "git", "init", "--quiet");
    yield* run(cwd, "git", "add", "--all");
    yield* run(
      cwd,
      "git",
      "commit",
      "--quiet",
      "--message",
      "Initial commit from create-foldkit-alchemy-app",
    );
  }).pipe(Effect.ignore);

export const command = Command.make(
  "create-foldkit-alchemy-app",
  {
    name: Argument.string("name").pipe(
      Argument.withSchema(ProjectName),
      Argument.withDescription(`Project name — ${PROJECT_NAME_HINT}`),
      Argument.optional,
    ),
    app: Flag.choice("app", apps).pipe(
      Flag.withDescription("Example app to scaffold"),
      Flag.optional,
    ),
    db: Flag.choice("db", dbProviders).pipe(
      Flag.withDescription("Postgres provider"),
      Flag.optional,
    ),
    auth: Flag.choice("auth", authChoices).pipe(
      Flag.withDescription(
        "Include BetterAuth (todo app only; chat always has auth)",
      ),
      Flag.optional,
    ),
    state: Flag.choice("state", stateBackends).pipe(
      Flag.withDescription(
        "Where Alchemy stores deployment state (default: local)",
      ),
      Flag.optional,
    ),
    install: Flag.boolean("install").pipe(
      Flag.withDescription("Run `bun install` without asking"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription(
        "Skip prompts; use defaults for anything not given as a flag",
      ),
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const path = yield* Path;

      const name = yield* Option.match(args.name, {
        onSome: Effect.succeed,
        onNone: () =>
          args.yes
            ? decodeProjectName("my-foldkit-app").pipe(Effect.orDie)
            : promptName,
      });
      const app = yield* Option.match(args.app, {
        onSome: Effect.succeed,
        onNone: () => (args.yes ? Effect.succeed<App>("chat") : promptApp),
      });
      const db = yield* Option.match(args.db, {
        onSome: Effect.succeed,
        onNone: () =>
          args.yes ? Effect.succeed<DbProvider>("neon") : promptDb,
      });
      // Chat requires auth (identity is part of its protocol), so the
      // question is only asked for the todo app.
      const auth = yield* Option.match(args.auth, {
        onSome: Effect.succeed,
        onNone: () =>
          app === "chat" || args.yes
            ? Effect.succeed<AuthChoice>("better-auth")
            : promptAuth,
      });
      const state = yield* Option.match(args.state, {
        onSome: Effect.succeed,
        onNone: () =>
          args.yes ? Effect.succeed<StateBackend>("local") : promptState,
      });

      const targetDir = path.resolve(name);
      const templatesDir = path.resolve(import.meta.dirname, "../templates");

      yield* generate({ name, app, auth, db, state, targetDir, templatesDir });
      yield* gitInit(targetDir);
      yield* Console.log(
        `\nScaffolded ${name} (${app}, ${db}, auth: ${auth}, state: ${state}) at ${targetDir}`,
      );

      const install =
        args.install ||
        (!args.yes &&
          (yield* Prompt.confirm({
            message: "Install dependencies with bun?",
            initial: true,
          })));
      if (install) {
        const exitCode = yield* run(targetDir, "bun", "install");
        if (exitCode !== 0) {
          yield* Console.error("bun install failed; run it manually.");
        }
      }

      const steps = [
        `cd ${name}`,
        ...(install ? [] : ["bun install"]),
        "cp .env.example .env   # then fill in the values",
        "bun dev",
      ];
      yield* Console.log(
        `\nNext steps:\n${steps.map((s) => `  ${s}`).join("\n")}\n`,
      );
    }),
);
