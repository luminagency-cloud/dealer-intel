CREATE TABLE "ocr_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"image_text" text,
	"pages_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ocr_artifacts" ADD CONSTRAINT "ocr_artifacts_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_artifacts" ADD CONSTRAINT "ocr_artifacts_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ocr_artifacts_evidence_unique" ON "ocr_artifacts" USING btree ("evidence_id");