CREATE TABLE "compliance_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"grade" text NOT NULL,
	"details_json" jsonb,
	"graded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "source_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "vehicle_make" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "vehicle_model" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "vehicle_trim" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "monthly_payment" real;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "apr" real;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "cash_incentive" real;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "term_months" integer;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "due_at_signing" real;--> statement-breakpoint
ALTER TABLE "compliance_grades" ADD CONSTRAINT "compliance_grades_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_grades" ADD CONSTRAINT "compliance_grades_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_grades_evidence_unique" ON "compliance_grades" USING btree ("evidence_id");--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_source_evidence_id_evidence_id_fk" FOREIGN KEY ("source_evidence_id") REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action;