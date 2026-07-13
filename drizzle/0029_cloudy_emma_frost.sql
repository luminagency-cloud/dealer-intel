CREATE TYPE "public"."offer_disposition" AS ENUM('passed', 'deleted');--> statement-breakpoint
CREATE TABLE "offer_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_run_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"source_evidence_id" uuid,
	"disposition" "offer_disposition" NOT NULL,
	"confidence" real,
	"offer_type" "offer_type" NOT NULL,
	"ai_assisted" boolean DEFAULT false NOT NULL,
	"mission_type" "mission_type",
	"evidence_type" "evidence_type",
	"offer_snapshot" jsonb,
	"operator" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
