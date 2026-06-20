CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_key" text NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"source_url" text NOT NULL,
	"published_at" text NOT NULL,
	"category" text NOT NULL,
	"brand" text,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "news_items_source_url_week_idx" ON "news_items" USING btree ("source_url","week_key");--> statement-breakpoint
CREATE INDEX "news_items_week_brand_idx" ON "news_items" USING btree ("week_key","brand");