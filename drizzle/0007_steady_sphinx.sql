CREATE TABLE "collection_run_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"site_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_runs" DROP CONSTRAINT "collection_runs_site_id_sites_id_fk";
--> statement-breakpoint
ALTER TABLE "collection_run_sites" ADD CONSTRAINT "collection_run_sites_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_run_sites" ADD CONSTRAINT "collection_run_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_run_sites_unique" ON "collection_run_sites" USING btree ("collection_run_id","site_id");--> statement-breakpoint
ALTER TABLE "collection_runs" DROP COLUMN "site_id";