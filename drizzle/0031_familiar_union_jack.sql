ALTER TYPE "public"."evidence_type" ADD VALUE 'state_html_snapshot' BEFORE 'failure_screenshot';--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "capture_key" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "capture_state_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "capture_state" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "capture_order" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_capture_key_unique" ON "evidence" USING btree ("capture_key");