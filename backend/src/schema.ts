import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const Rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
});
export type RoomRow = typeof Rooms.$inferSelect;

export const ChatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    senderId: text("sender_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_messages_room_created_idx").on(table.roomId, table.createdAt),
  ],
);
export type ChatMessageRow = typeof ChatMessages.$inferSelect;
