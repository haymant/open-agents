ALTER TABLE "sessions" ADD COLUMN "type" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "parent_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;