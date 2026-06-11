import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const missionTypeEnum = pgEnum("mission_type", [
  "homepage_offers",
  "finance_offers",
  "service_specials",
  "promotional_banners",
]);

export type MissionType = (typeof missionTypeEnum.enumValues)[number];

export const MISSION_TYPE_LABELS: Record<MissionType, string> = {
  homepage_offers: "Homepage Offers",
  finance_offers: "Finance Offers",
  service_specials: "Service Specials",
  promotional_banners: "Promotional Banners",
};

/** Dealer and competitor websites. Generic per AD-002 — competitor
 *  relationships live in a separate table arriving in Phase 2. */
export const sites = pgTable("sites", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  platform: text("platform"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Business information to collect from a site. success_rate and
 *  last_success_at are written by the collector (Phase 5+). */
export const missions = pgTable("missions", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  missionType: missionTypeEnum("mission_type").notNull(),
  lastKnownUrl: text("last_known_url"),
  successRate: real("success_rate"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const relationshipTypeEnum = pgEnum("relationship_type", [
  "competitor",
  "group_member",
  "comparison_set",
]);

export type RelationshipType = (typeof relationshipTypeEnum.enumValues)[number];

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  competitor: "Competitor",
  group_member: "Group Member",
  comparison_set: "Comparison Set",
};

/** Reporting relationships between sites (AD-002). Collection never reads
 *  this table; reporting does. */
export const siteRelationships = pgTable(
  "site_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    relatedSiteId: uuid("related_site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    relationshipType: relationshipTypeEnum("relationship_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_relationships_unique").on(
      table.siteId,
      table.relatedSiteId,
      table.relationshipType
    ),
  ]
);

// Statuses follow the roadmap's Phase 3 run lifecycle rather than the
// shorter list in Docs/Data Model.md ("completed" -> review/published).
export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "review",
  "published",
  "failed",
]);

export type RunStatus = (typeof runStatusEnum.enumValues)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "Pending",
  running: "Running",
  review: "Review",
  published: "Published",
  failed: "Failed",
};

/** A complete collection attempt. Orchestration arrives in Phase 3. */
export const collectionRuns = pgTable("collection_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: runStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const evidenceTypeEnum = pgEnum("evidence_type", [
  "screenshot",
  "html_snapshot",
  "failure_screenshot",
  "disclaimer_screenshot",
]);

export type EvidenceType = (typeof evidenceTypeEnum.enumValues)[number];

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  screenshot: "Screenshot",
  html_snapshot: "HTML Snapshot",
  failure_screenshot: "Failure Screenshot",
  disclaimer_screenshot: "Disclaimer Screenshot",
};

/** Screenshots, disclaimers, and HTML captures (AD-005, AD-010). URLs point
 *  at object storage; upload/retrieval services arrive in Phase 4. */
export const evidence = pgTable("evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionRunId: uuid("collection_run_id")
    .notNull()
    .references(() => collectionRuns.id, { onDelete: "cascade" }),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  missionType: missionTypeEnum("mission_type").notNull(),
  evidenceType: evidenceTypeEnum("evidence_type").notNull(),
  screenshotUrl: text("screenshot_url"),
  htmlUrl: text("html_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const offerTypeEnum = pgEnum("offer_type", [
  "lease",
  "finance",
  "cash",
  "service",
  "promotional",
]);

export type OfferType = (typeof offerTypeEnum.enumValues)[number];

/** Normalized offer records. Discovery/normalization arrive in Phases 9-10;
 *  normalized_json holds the structured fields until those phases firm up. */
export const offers = pgTable("offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionRunId: uuid("collection_run_id")
    .notNull()
    .references(() => collectionRuns.id, { onDelete: "cascade" }),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  offerType: offerTypeEnum("offer_type").notNull(),
  rawText: text("raw_text"),
  normalizedJson: jsonb("normalized_json"),
  disclaimerText: text("disclaimer_text"),
  confidence: real("confidence"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Approved reporting datasets (AD-006). Reports only ever read snapshots,
 *  never live collection data. */
export const reportSnapshots = pgTable("report_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionRunId: uuid("collection_run_id")
    .notNull()
    .references(() => collectionRuns.id, { onDelete: "cascade" }),
  approvedAt: timestamp("approved_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  approvedBy: text("approved_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;
export type SiteRelationship = typeof siteRelationships.$inferSelect;
export type NewSiteRelationship = typeof siteRelationships.$inferInsert;
export type CollectionRun = typeof collectionRuns.$inferSelect;
export type NewCollectionRun = typeof collectionRuns.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
export type ReportSnapshot = typeof reportSnapshots.$inferSelect;
export type NewReportSnapshot = typeof reportSnapshots.$inferInsert;
