CREATE TABLE generated_reports (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  node_id text NOT NULL,
  checksum text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  page_count integer NOT NULL CHECK (page_count BETWEEN 1 AND 20),
  extracted_text text,
  text_truncated boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expired_at timestamptz
);
--> statement-breakpoint
CREATE INDEX generated_reports_run ON generated_reports(run_id);
--> statement-breakpoint
CREATE TABLE report_attempts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  node_id text NOT NULL,
  attempt_order integer NOT NULL,
  source_hash text NOT NULL,
  renderer_profile text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  result jsonb,
  report_id text REFERENCES generated_reports(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,node_id,attempt_order)
);
--> statement-breakpoint
CREATE INDEX report_attempts_run_node ON report_attempts(run_id,node_id);
