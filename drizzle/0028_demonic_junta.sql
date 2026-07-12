ALTER TABLE "report_snapshots" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_share_token_unique" UNIQUE("share_token");