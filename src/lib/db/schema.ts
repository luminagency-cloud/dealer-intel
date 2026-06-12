import {
  boolean,
  integer,
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
  /** Vehicle brand(s) sold, e.g. "Kia" or "Chrysler, Dodge, Jeep, Ram". */
  brand: text("brand"),
  /** Two-letter US state code. */
  state: text("state"),
  active: boolean("active").notNull().default(true),
  /** Last time any mission collected successfully for this site (Phase 8
   *  freshness). Set by the run executor; drives the fresh/stale indicator. */
  lastCollectedAt: timestamp("last_collected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** The global mission layer: what business information to collect ("collect
 *  the service specials"), independent of any dealer. The mission_type maps
 *  to collection behavior in src/lib/collector/mission-knowledge.ts.
 *  Per-dealer URLs/learning live in site_missions. */
export const missions = pgTable("missions", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  missionType: missionTypeEnum("mission_type").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Per-site collection config + memory for a global mission: which URLs to
 *  visit on this dealer and what the collector has learned. Managed from the
 *  site's edit page, not as standalone missions. */
export const siteMissions = pgTable(
  "site_missions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    lastKnownUrl: text("last_known_url"),
    alternateUrls: text("alternate_urls").array().notNull().default([]),
    successRate: real("success_rate"),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("site_missions_unique").on(table.siteId, table.missionId),
  ]
);

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

/** Named operational batches of sites — a first-order dealer plus its
 *  related dealers. Scopes which missions a run executes; the collector
 *  itself stays competition-blind (AD-002). Reporting may later treat a
 *  group's primary sites as the comparison anchor. */
export const runGroups = pgTable("run_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const runGroupMembers = pgTable(
  "run_group_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runGroupId: uuid("run_group_id")
      .notNull()
      .references(() => runGroups.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** First-order dealer(s) the group is built around. */
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => [
    uniqueIndex("run_group_members_unique").on(table.runGroupId, table.siteId),
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
  /** When set, the run only executes missions for the group's sites. */
  runGroupId: uuid("run_group_id").references(() => runGroups.id, {
    onDelete: "set null",
  }),
  status: runStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Mission selection for a run. No rows = all active missions; otherwise
 *  the run only executes the listed missions across its site scope. */
export const collectionRunMissions = pgTable(
  "collection_run_missions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionRunId: uuid("collection_run_id")
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("collection_run_missions_unique").on(
      table.collectionRunId,
      table.missionId
    ),
  ]
);

export type CollectionRunMission = typeof collectionRunMissions.$inferSelect;

/** Ad-hoc run scope: an unsaved, temporary "group" of dealers picked at run
 *  creation. A run with rows here (and no run_group_id) only executes these
 *  sites' missions. */
export const collectionRunSites = pgTable(
  "collection_run_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionRunId: uuid("collection_run_id")
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("collection_run_sites_unique").on(
      table.collectionRunId,
      table.siteId
    ),
  ]
);

export type CollectionRunSite = typeof collectionRunSites.$inferSelect;

// Phase 7 status types (success / needs review / failure / not found) plus
// queue states for background execution and the operator's "content removed"
// resolution.
export const missionResultStatusEnum = pgEnum("mission_result_status", [
  "pending",
  "running",
  "success",
  "needs_review",
  "failure",
  "not_found",
  "content_removed",
]);

export type MissionResultStatus =
  (typeof missionResultStatusEnum.enumValues)[number];

export const MISSION_RESULT_STATUS_LABELS: Record<MissionResultStatus, string> =
  {
    pending: "Pending",
    running: "Running",
    success: "Success",
    needs_review: "Needs Review",
    failure: "Failure",
    not_found: "Not Found",
    content_removed: "Content Removed",
  };

/** One row per mission per run: the execution outcome that drives the
 *  review workflow (Phase 7) and live run progress. */
export const missionResults = pgTable(
  "mission_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionRunId: uuid("collection_run_id")
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    missionType: missionTypeEnum("mission_type").notNull(),
    status: missionResultStatusEnum("status").notNull().default("pending"),
    pagesCaptured: integer("pages_captured").notNull().default(0),
    successfulUrl: text("successful_url"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Mission ids are global (one row per type), so uniqueness includes the
    // site: one result per run per site per mission.
    uniqueIndex("mission_results_run_site_mission_unique").on(
      table.collectionRunId,
      table.siteId,
      table.missionId
    ),
  ]
);

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
export type SiteMission = typeof siteMissions.$inferSelect;
export type NewSiteMission = typeof siteMissions.$inferInsert;
export type SiteRelationship = typeof siteRelationships.$inferSelect;
export type NewSiteRelationship = typeof siteRelationships.$inferInsert;
export type RunGroup = typeof runGroups.$inferSelect;
export type NewRunGroup = typeof runGroups.$inferInsert;
export type RunGroupMember = typeof runGroupMembers.$inferSelect;
export type NewRunGroupMember = typeof runGroupMembers.$inferInsert;
export type CollectionRun = typeof collectionRuns.$inferSelect;
export type NewCollectionRun = typeof collectionRuns.$inferInsert;
export type MissionResult = typeof missionResults.$inferSelect;
export type NewMissionResult = typeof missionResults.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;
export type ReportSnapshot = typeof reportSnapshots.$inferSelect;
export type NewReportSnapshot = typeof reportSnapshots.$inferInsert;
