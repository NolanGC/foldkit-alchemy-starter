CREATE TABLE "rooms" (
	"id" text PRIMARY KEY
);

--> statement-breakpoint
INSERT INTO "rooms" ("id") VALUES ('general'), ('random'), ('feature-requests') ON CONFLICT DO NOTHING;
