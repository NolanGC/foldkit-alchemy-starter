import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { User } from "./auth-schema.ts";

// BetterAuth tables live in auth-schema.ts; re-exported so drizzle-kit (and
// alchemy's Drizzle.Schema) see the whole database through this one module.
export * from "./auth-schema.ts";

export const Todos = pgTable(
  "todos",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => User.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    completed: boolean("completed").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("todos_user_created_idx").on(table.userId, table.createdAt),
  ],
);
export type TodoRow = typeof Todos.$inferSelect;
