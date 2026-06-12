CREATE TABLE "collection_run_missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"last_known_url" text,
	"alternate_urls" text[] DEFAULT '{}' NOT NULL,
	"success_rate" real,
	"last_success_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "mission_results_run_mission_unique";--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "collection_run_missions" ADD CONSTRAINT "collection_run_missions_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_run_missions" ADD CONSTRAINT "collection_run_missions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_missions" ADD CONSTRAINT "site_missions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_missions" ADD CONSTRAINT "site_missions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_run_missions_unique" ON "collection_run_missions" USING btree ("collection_run_id","mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_missions_unique" ON "site_missions" USING btree ("site_id","mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_results_run_site_mission_unique" ON "mission_results" USING btree ("collection_run_id","site_id","mission_id");