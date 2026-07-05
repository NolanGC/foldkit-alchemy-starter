CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY,
	"room_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

