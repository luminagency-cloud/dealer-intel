CREATE TABLE "inventory_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"week_key" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"detected_platform" text,
	"access_route" text,
	"attempts" integer,
	"source_url" text,
	"totals" jsonb,
	"make_subtotals" jsonb,
	"models" jsonb,
	"warnings" text[],
	"error" jsonb
);
--> statement-breakpoint
ALTER TABLE "inventory_results" ADD CONSTRAINT "inventory_results_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_results_site_idx" ON "inventory_results" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "inventory_results_batch_idx" ON "inventory_results" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "inventory_results_week_idx" ON "inventory_results" USING btree ("week_key");