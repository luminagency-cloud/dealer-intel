CREATE TABLE "snapshot_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"site_id" uuid,
	"site_name" text NOT NULL,
	"site_brand" text,
	"site_state" text,
	"source_evidence_id" uuid,
	"mission_type" "mission_type" NOT NULL,
	"offer_type" "offer_type" NOT NULL,
	"vehicle_make" text,
	"vehicle_model" text,
	"vehicle_trim" text,
	"monthly_payment" real,
	"apr" real,
	"cash_incentive" real,
	"term_months" integer,
	"due_at_signing" real,
	"raw_text" text,
	"normalized_json" jsonb,
	"disclaimer_text" text,
	"confidence" real,
	"compliance_grade" text,
	"compliance_details_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD COLUMN "run_group_id" uuid;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD COLUMN "run_group_name" text;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD COLUMN "offer_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD COLUMN "site_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshot_offers" ADD CONSTRAINT "snapshot_offers_snapshot_id_report_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."report_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_offers" ADD CONSTRAINT "snapshot_offers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_offers" ADD CONSTRAINT "snapshot_offers_source_evidence_id_evidence_id_fk" FOREIGN KEY ("source_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE set null ON UPDATE no action;