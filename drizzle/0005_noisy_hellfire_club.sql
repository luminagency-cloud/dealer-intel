CREATE TYPE "public"."mission_result_status" AS ENUM('pending', 'running', 'success', 'needs_review', 'failure', 'not_found', 'content_removed');--> statement-breakpoint
CREATE TABLE "mission_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"mission_type" "mission_type" NOT NULL,
	"status" "mission_result_status" DEFAULT 'pending' NOT NULL,
	"pages_captured" integer DEFAULT 0 NOT NULL,
	"successful_url" text,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_results" ADD CONSTRAINT "mission_results_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_results" ADD CONSTRAINT "mission_results_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_results" ADD CONSTRAINT "mission_results_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mission_results_run_mission_unique" ON "mission_results" USING btree ("collection_run_id","mission_id");