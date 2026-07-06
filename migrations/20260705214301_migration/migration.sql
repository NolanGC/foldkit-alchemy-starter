ALTER TABLE "posts" DROP CONSTRAINT "posts_user_id_users_id_fkey";
--> statement-breakpoint
DROP TABLE "posts";
--> statement-breakpoint
DROP TABLE "users";
--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
DROP SEQUENCE "chat_messages_id_seq";
--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;
--> statement-breakpoint
CREATE INDEX "chat_messages_room_created_idx" ON "chat_messages" ("room_id","created_at");
