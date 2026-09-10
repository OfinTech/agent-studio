CREATE TABLE "mock_receipts" (
	"key" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
