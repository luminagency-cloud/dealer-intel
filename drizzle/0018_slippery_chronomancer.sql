ALTER TABLE "collection_runs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "collection_runs" ALTER COLUMN "status" SET DEFAULT 'pending'::text;--> statement-breakpoint
UPDATE "collection_runs" SET "status" = 'complete' WHERE "status" = 'published';--> statement-breakpoint
DROP TYPE "public"."run_status";--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'review', 'complete', 'failed');--> statement-breakpoint
ALTER TABLE "collection_runs" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."run_status";--> statement-breakpoint
ALTER TABLE "collection_runs" ALTER COLUMN "status" SET DATA TYPE "public"."run_status" USING "status"::"public"."run_status";
