CREATE TABLE "system_notices" (
	"run_id" text PRIMARY KEY NOT NULL,
	"message" jsonb,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"suppression_reason" text,
	"queue_job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"uncertain" boolean DEFAULT false NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"provider_email_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "reply_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "queue_job_id" text;--> statement-breakpoint
ALTER TABLE "system_notices" ADD CONSTRAINT "system_notices_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE runs r SET deadline_at=r.started_at+make_interval(secs => coalesce((v.snapshot->'workflow'->>'executionTimeoutSeconds')::int,300)) FROM versions v WHERE v.id=r.version_id AND r.started_at IS NOT NULL;
--> statement-breakpoint
-- Existing executions are reconciled but never receive retrospective notices.
INSERT INTO system_notices(run_id,mode,status,suppression_reason)
SELECT id,'live','suppressed','Run predates system-error notices' FROM runs WHERE status IN ('queued','running');
