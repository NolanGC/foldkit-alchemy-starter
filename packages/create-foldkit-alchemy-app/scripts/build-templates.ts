// Snapshots the starter repo (the workspace root two levels up) into
// templates/base so the published CLI is self-contained. Runs before tests
// and on prepublish; templates/ is gitignored build output.
//
// Copies are verbatim — every project-specific rewrite (name, db provider,
// stack id) happens at generate time in src/Generate.ts, so drift between
// the repo and the transforms is caught by this package's tests, not
// discovered by users.
import * as fs from "node:fs";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");
const templatesDir = path.join(packageDir, "templates");
const baseDir = path.join(templatesDir, "base");

// Repo-root files copied as-is. Notable exclusions: bun.lock (fresh installs
// should resolve fresh), flake.* / .envrc (the author's nix setup), .github
// (workflows deploy real infra and need repo secrets). test/ is not copied
// verbatim either — the integ test is derived below (CI-specific state and
// teardown swapped for a solo local run, plus an opt-in guard).
const rootFiles = [
  "alchemy.run.ts",
  "package.json",
  "tsconfig.json",
  "bunfig.toml",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  "AGENTS.md",
];

const rootDirs = ["backend", "frontend", "migrations", "patches"];

// Build artifacts and local state that must never ship inside a template.
const excludedNames = new Set([
  "node_modules",
  "dist",
  ".alchemy",
  ".DS_Store",
]);
const isExcluded = (p: string) =>
  excludedNames.has(path.basename(p)) || p.endsWith(".tsbuildinfo");

// .gitignore lines that only make sense in the starter repo itself.
const gitignoreOnlyInRepo = new Set([
  "# Vendored reference repos (foldkit, alchemy-effect) — reference material for",
  "# Claude skills, not app code",
  "repos/",
  "# Session transcripts and scratch notes",
  "*-local-command-caveat*.txt",
  "notes/",
]);

fs.rmSync(templatesDir, { recursive: true, force: true });
fs.mkdirSync(baseDir, { recursive: true });

for (const file of rootFiles) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(baseDir, file));
}

for (const dir of rootDirs) {
  fs.cpSync(path.join(repoRoot, dir), path.join(baseDir, dir), {
    recursive: true,
    filter: (src) => !isExcluded(src),
  });
}

const gitignore = fs
  .readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
  .split("\n")
  .filter((line) => !gitignoreOnlyInRepo.has(line.trim()))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n");
fs.writeFileSync(path.join(baseDir, ".gitignore"), gitignore);

// The optional Tauri desktop shell, snapshotted from packages/desktop into
// its own overlay (not base — it only ships when the user opts in). Rust
// build output and Tauri's generated schemas are local artifacts.
const desktopExcluded = new Set(["target", "gen"]);
fs.cpSync(
  path.join(repoRoot, "packages/desktop"),
  path.join(templatesDir, "desktop"),
  {
    recursive: true,
    filter: (src) =>
      !isExcluded(src) && !desktopExcluded.has(path.basename(src)),
  },
);

// Hand-authored assets: the README (rendered at generate time) and the todo
// app overlay (template/apps/todo/{common,auth,no-auth} mirror the repo
// layout and replace the chat app when the user picks todo). Everything the
// todo app shares with the chat app — the auth service and gate, the login
// page submodel, the frontend auth commands, Db.ts, auth-schema.ts — comes
// from the base snapshot, so upstream fixes flow into both apps.
fs.cpSync(path.join(packageDir, "template"), path.join(templatesDir), {
  recursive: true,
});

// Derive the chat integration test from the repo's own (proven) one, rather
// than hand-copying it, so upstream fixes keep flowing in. Two differences
// for a generated app: no CI — state lives on disk and teardown always runs
// (the repo skips destroy locally to keep dev stacks alive); and an opt-in
// guard so a bare `bun test` in a fresh scaffold never deploys anything.
const replaceOnce = (
  file: string,
  content: string,
  from: string,
  to: string,
) => {
  if (content.split(from).length - 1 !== 1) {
    throw new Error(
      `${file}: expected exactly one occurrence of ${JSON.stringify(from)} — the starter repo and the template derivation have drifted`,
    );
  }
  return content.replace(from, to);
};

const integFile = "test/integ.test.ts";
let integ = fs.readFileSync(path.join(repoRoot, integFile), "utf8");
integ = replaceOnce(
  integFile,
  integ,
  "three Cloudflare workers) before the tests and destroys it after (CI only).",
  "three Cloudflare workers) before the tests and destroys it after.",
);
integ = replaceOnce(
  integFile,
  integ,
  "//   stranded by earlier failed runs (remote state + `adopt` in CI).",
  "//   stranded by earlier failed runs (`adopt: true`).",
);
integ = replaceOnce(
  integFile,
  integ,
  "const { test, beforeAll, afterAll, deploy, destroy } = Test.make({",
  `// Opt-in guard: a bare \`bun test\` must never deploy real infrastructure.
// \`bun run test:integ\` sets INTEG=1.
if (process.env.INTEG !== "1") {
  console.log(
    "Skipping integration tests — run \`bun run test:integ\` (deploys real infrastructure).",
  );
  process.exit(0);
}

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({`,
);
integ = replaceOnce(
  integFile,
  integ,
  `  // Remote state in CI: runners are ephemeral, so with local state a failed
  // teardown strands resources with no record. With Cloudflare-backed state
  // the next run (all CI runs share the "test" stage, serialized by the
  // workflow's concurrency group) sees the leftovers and cleans them up.
  // Locally, keep state on disk so dev runs don't touch the shared record.
  state: process.env.CI ? Cloudflare.state() : Alchemy.localState(),`,
  `  // Local state on disk: each run deploys and destroys its own stack.
  state: Alchemy.localState(),`,
);
integ = replaceOnce(
  integFile,
  integ,
  "// Adopt instead of failing: the run takes ownership and the teardown\n  // finally deletes it. Safe because CI serializes runs on this stage.",
  "// Adopt instead of failing: the run takes ownership and the teardown\n  // finally deletes it. Safe as long as runs on this stage don't overlap.",
);
integ = replaceOnce(
  integFile,
  integ,
  "afterAll.skipIf(!process.env.CI)(",
  "afterAll(",
);
fs.mkdirSync(path.join(baseDir, "test"), { recursive: true });
fs.writeFileSync(path.join(baseDir, integFile), integ);

// Auth.ts is otherwise identical between the two apps (inherited from the
// base snapshot), but it imports the branded `UserId` from ChatProtocol.ts,
// which the todo app doesn't have — UserId isn't worth a shared module for
// one type alias, so the todo overlay gets its own copy of Auth.ts with
// just that import swapped to TodoProtocol.ts (which defines its own
// UserId, see template/apps/todo/auth/backend/src/TodoProtocol.ts).
const authSource = fs.readFileSync(
  path.join(baseDir, "backend/src/Auth.ts"),
  "utf8",
);
const anchor = 'import { UserId } from "./ChatProtocol.ts";\n';
if (authSource.split(anchor).length - 1 !== 1) {
  throw new Error(
    `backend/src/Auth.ts: expected exactly one occurrence of ${JSON.stringify(anchor)} — the starter repo and the todo overlay derivation have drifted`,
  );
}
fs.writeFileSync(
  path.join(templatesDir, "apps/todo/auth/backend/src/Auth.ts"),
  authSource.replace(anchor, 'import { UserId } from "./TodoProtocol.ts";\n'),
);

console.log(`Templates built at ${templatesDir}`);
