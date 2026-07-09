import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const Todos = pgTable(
  "todos",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    completed: boolean("completed").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("todos_created_idx").on(table.createdAt)],
);
export type TodoRow = typeof Todos.$inferSelect;
