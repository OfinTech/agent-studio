CREATE TABLE "email_sends" (
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"message" jsonb NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"provider_email_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_run_node" ON "email_sends" USING btree ("run_id","node_id");