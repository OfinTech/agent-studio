ALTER TABLE "tool_calls" ADD COLUMN "node_id" text;
CREATE INDEX "tool_calls_run_node" ON "tool_calls" ("run_id", "node_id");
