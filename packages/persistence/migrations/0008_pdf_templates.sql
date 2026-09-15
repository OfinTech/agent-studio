CREATE TABLE "template_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_attempts" ADD COLUMN "generation_fingerprint" text;--> statement-breakpoint
ALTER TABLE "report_attempts" ADD COLUMN "template_node_id" text;--> statement-breakpoint
ALTER TABLE "template_resources" ADD CONSTRAINT "template_resources_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_resources_workflow" ON "template_resources" USING btree ("workflow_id");