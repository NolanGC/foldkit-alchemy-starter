// One-off migration generator mirroring alchemy's Drizzle.Schema
// "programmatic" path (node_modules/alchemy/src/Drizzle/Schema.ts), so the
// generated dir layout/snapshot match what alchemy expects and no drift is
// detected at deploy time. Run with: bun scripts/generate-migration.ts
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";

import * as schema from "../backend/src/schema.ts";

const out = join(import.meta.dirname, "..", "migrations");

const dirs = readdirSync(out)
  .filter((name) => /^\d+_/.test(name))
  .sort();
const latest = dirs.at(-1);
if (!latest) throw new Error("no previous migration snapshot found");
const prev = JSON.parse(
  readFileSync(join(out, latest, "snapshot.json"), "utf8"),
);

const cur = await generateDrizzleJson(schema, prev.id);
const statements = await generateMigration(prev, cur);
if (statements.length === 0) {
  console.log("no drift");
  process.exit(0);
}

const tsStamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const dirPath = join(out, `${tsStamp}_migration`);
mkdirSync(dirPath, { recursive: true });
writeFileSync(
  join(dirPath, "migration.sql"),
  statements.join("\n--> statement-breakpoint\n") + "\n",
);
writeFileSync(join(dirPath, "snapshot.json"), JSON.stringify(cur, null, 2));
console.log(`wrote ${dirPath}`);
