ALTER TABLE "missions" DROP CONSTRAINT "missions_site_id_sites_id_fk";
--> statement-breakpoint
ALTER TABLE "missions" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN "site_id";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN "last_known_url";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN "alternate_urls";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN "success_rate";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN "last_success_at";