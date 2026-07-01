import {
  boolean,
  index,
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
  /** Two-letter US state code where the dealer primarily operates. */
  state: text("state"),
  /** Additional states this dealer runs ads in (for multi-jurisdiction compliance). */
  otherStates: text("other_states").array(),
  /** URL path override sent to the inventory API (e.g. "/new-inventory"). */
  inventoryPath: text("inventory_path"),
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
  "complete",
  "failed",
]);

export type RunStatus = (typeof runStatusEnum.enumValues)[number];

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  pending: "Pending",
  running: "Running",
  review: "Review",
  complete: "Complete",
  failed: "Failed",
};

/** A complete collection attempt. Orchestration arrives in Phase 3. */
export const collectionRuns = pgTable("collection_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** When set, the run only executes missions for the group's sites. */
  runGroupId: uuid("run_group_id").references(() => runGroups.id, {
    onDelete: "set null",
  }),
  /** ISO week label for the reporting cycle this run belongs to (e.g. "2026-W31").
   *  Defaults to the current ISO week at creation time; operator can override. */
  cycle: text("cycle"),
  status: runStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  analysisStartedAt: timestamp("analysis_started_at", { withTimezone: true }),
  analysisCompletedAt: timestamp("analysis_completed_at", { withTimezone: true }),
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
    pending: "Queued",
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
  /** Human-readable name captured at collection time so identical-typed rows
   *  are distinguishable in the viewer: page title + path for page captures,
   *  slide/tab labels for exploration shots, and — for disclaimer shots — the
   *  ad-anchor text (vehicle + price from the disclaimer's ad card). That
   *  anchor is also the join key tying a disclaimer screenshot back to its
   *  offer for the compliance pass (which pairs ad image + disclaimer text in
   *  one call). Null on legacy rows captured before labeling existed. */
  label: text("label"),
  /** Text scraped from the source at capture time. For disclaimer shots this is
   *  the disclaimer modal's full text (offer + fine print) — the real
   *  disclosure the compliance pass needs, captured directly so no OCR is
   *  required and so it isn't lost when the modal closes before the HTML
   *  snapshot. Null for captures with no associated text. */
  textContent: text("text_content"),
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

export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  lease: "Lease",
  finance: "Finance",
  cash: "Cash",
  service: "Service",
  promotional: "Promotional",
};

/** Normalized offer records produced by the Phase 9 analysis passes
 *  (classification + normalization) over stored evidence. Derived and
 *  re-runnable: re-analysis replaces a run's offers. normalized_json keeps
 *  extras and the raw regex matches alongside the typed columns. */
export const offers = pgTable("offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionRunId: uuid("collection_run_id")
    .notNull()
    .references(() => collectionRuns.id, { onDelete: "cascade" }),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  /** Evidence this offer was extracted from. Null for manual/legacy offers. */
  sourceEvidenceId: uuid("source_evidence_id").references(() => evidence.id, {
    onDelete: "set null",
  }),
  offerType: offerTypeEnum("offer_type").notNull(),
  /** Classification: vehicle context where present. */
  vehicleMake: text("vehicle_make"),
  vehicleModel: text("vehicle_model"),
  vehicleTrim: text("vehicle_trim"),
  /** Normalization: the roadmap's core offer fields. Dollars and percent as
   *  plain numbers; term in whole months. */
  monthlyPayment: real("monthly_payment"),
  apr: real("apr"),
  cashIncentive: real("cash_incentive"),
  salePrice: real("sale_price"),
  termMonths: integer("term_months"),
  dueAtSigning: real("due_at_signing"),
  rawText: text("raw_text"),
  normalizedJson: jsonb("normalized_json"),
  disclaimerText: text("disclaimer_text"),
  confidence: real("confidence"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Compliance grades from the external compliance service (Phase 9). The
 *  grading logic lives entirely in that service; we send evidence + disclaimer
 *  + ad type and store what comes back, one current grade per evidence record
 *  (re-analysis upserts). */
export const complianceGrades = pgTable(
  "compliance_grades",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    collectionRunId: uuid("collection_run_id")
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    /** Service-defined grade, e.g. "pass" / "warn" / "fail" or a letter. */
    grade: text("grade").notNull(),
    /** Full service response payload for drill-down. */
    detailsJson: jsonb("details_json"),
    gradedAt: timestamp("graded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("compliance_grades_evidence_unique").on(table.evidenceId),
  ]
);

/** Platform users — operators and dealer clients. Operators have full admin
 *  access; dealers see only the run groups they're associated with via
 *  user_run_groups. Passwords are bcrypt-hashed. */
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  /** "admin" = full operator access. "dealer" = read-only report viewer. */
  role: text("role", { enum: ["admin", "dealer"] })
    .notNull()
    .default("dealer"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Which run groups a dealer user can see. Admins bypass this table (they
 *  see everything). */
export const userRunGroups = pgTable(
  "user_run_groups",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runGroupId: uuid("run_group_id")
      .notNull()
      .references(() => runGroups.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("user_run_groups_unique").on(table.userId, table.runGroupId),
  ]
);

/** Approved reporting datasets (AD-006), the Phase 10 wall between analysis
 *  and reporting. A snapshot is a FROZEN copy of a run's analysis output at
 *  approval time: re-running analysis or re-collecting never changes a
 *  published snapshot. Reports (Phase 11) read only from here and the frozen
 *  `snapshot_offers`, never from the live offers/grades tables. */
export const reportSnapshots = pgTable("report_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionRunId: uuid("collection_run_id")
    .notNull()
    .references(() => collectionRuns.id, { onDelete: "cascade" }),
  /** Scope anchor frozen from the run (group → primary dealer for reporting).
   *  Set null if the group is later deleted; runGroupName preserves the label. */
  runGroupId: uuid("run_group_id").references(() => runGroups.id, {
    onDelete: "set null",
  }),
  runGroupName: text("run_group_name"),
  /** Optional operator label for the snapshot. */
  label: text("label"),
  /** Denormalized counts for list display (the frozen offers carry the truth). */
  offerCount: integer("offer_count").notNull().default(0),
  siteCount: integer("site_count").notNull().default(0),
  /** Whether this snapshot is visible to dealer users in the viewer app.
   *  Operators toggle this after reviewing; defaults to false so unpublished
   *  snapshots stay invisible to clients until explicitly released. */
  clientVisible: boolean("client_visible").notNull().default(false),
  approvedAt: timestamp("approved_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  approvedBy: text("approved_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Frozen, denormalized copy of one analyzed offer at snapshot time. Carries
 *  everything a report needs without touching the live analysis tables: site
 *  identity, normalized offer fields, the compliance grade, and a link back to
 *  the source evidence (which survives as long as the run, and thus the
 *  snapshot, does). Immutable once written. */
export const snapshotOffers = pgTable("snapshot_offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: uuid("snapshot_id")
    .notNull()
    .references(() => reportSnapshots.id, { onDelete: "cascade" }),
  /** Live site link for relationship joins; the frozen name/brand/state below
   *  keep the report intact even if the site is later renamed or deleted. */
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  siteName: text("site_name").notNull(),
  siteBrand: text("site_brand"),
  siteState: text("site_state"),
  /** Source evidence for image drill-down; set null if the evidence is gone. */
  sourceEvidenceId: uuid("source_evidence_id").references(() => evidence.id, {
    onDelete: "set null",
  }),
  /** Direct public R2 URL for the evidence file, frozen at snapshot time from
   *  R2_PUBLIC_URL + the object key. Null when R2_PUBLIC_URL was not set at
   *  publish time. The viewer uses this; the admin falls back to the API route. */
  evidenceUrl: text("evidence_url"),
  missionType: missionTypeEnum("mission_type").notNull(),
  offerType: offerTypeEnum("offer_type").notNull(),
  vehicleMake: text("vehicle_make"),
  vehicleModel: text("vehicle_model"),
  vehicleTrim: text("vehicle_trim"),
  monthlyPayment: real("monthly_payment"),
  apr: real("apr"),
  cashIncentive: real("cash_incentive"),
  salePrice: real("sale_price"),
  termMonths: integer("term_months"),
  dueAtSigning: real("due_at_signing"),
  rawText: text("raw_text"),
  normalizedJson: jsonb("normalized_json"),
  disclaimerText: text("disclaimer_text"),
  confidence: real("confidence"),
  /** Frozen compliance grade for this ad (null if ungraded at snapshot time). */
  complianceGrade: text("compliance_grade"),
  complianceDetailsJson: jsonb("compliance_details_json"),
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
export type ComplianceGrade = typeof complianceGrades.$inferSelect;
export type NewComplianceGrade = typeof complianceGrades.$inferInsert;
export type ReportSnapshot = typeof reportSnapshots.$inferSelect;
export type NewReportSnapshot = typeof reportSnapshots.$inferInsert;
export type SnapshotOffer = typeof snapshotOffers.$inferSelect;
export type NewSnapshotOffer = typeof snapshotOffers.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRunGroup = typeof userRunGroups.$inferSelect;
export type NewUserRunGroup = typeof userRunGroups.$inferInsert;

// ---------------------------------------------------------------------------
// Inventory results
// ---------------------------------------------------------------------------

/** One inventory API result per dealer per batch run. */
export const inventoryResults = pgTable(
  "inventory_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** Groups all results from a single "Run Inventory" action. */
    batchId: uuid("batch_id").notNull(),
    /** ISO week key, e.g. "2026-W26". */
    weekKey: text("week_key").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** "ok" = API returned 200; "failed" = API returned an error. */
    status: text("status").notNull(),
    detectedPlatform: text("detected_platform"),
    accessRoute: text("access_route"),
    attempts: integer("attempts"),
    sourceUrl: text("source_url"),
    /** { inStock, inTransit, displayValue } */
    totals: jsonb("totals"),
    /** Array of { make, inStock, inTransit } */
    makeSubtotals: jsonb("make_subtotals"),
    /** Array of { make, model, inStock, inTransit, status } */
    models: jsonb("models"),
    warnings: text("warnings").array(),
    /** Populated on failure: { message, code, statusCode, isRateLimited } */
    error: jsonb("error"),
  },
  (table) => [
    index("inventory_results_site_idx").on(table.siteId),
    index("inventory_results_batch_idx").on(table.batchId),
    index("inventory_results_week_idx").on(table.weekKey),
  ]
);
export type InventoryResult = typeof inventoryResults.$inferSelect;
export type NewInventoryResult = typeof inventoryResults.$inferInsert;

/** Locally cached news items pulled once per week from the news service.
 *  Reports read from this table; the home page Refresh button triggers the pull. */
export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** ISO week key matching the pull, e.g. "2026-W25". */
    weekKey: text("week_key").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    sourceUrl: text("source_url").notNull(),
    /** Date string as returned by the news service, e.g. "2026-06-18". */
    publishedAt: text("published_at").notNull(),
    /** Category slug: recall, new_model, sales, regulatory, workforce, incentives, industry. */
    category: text("category").notNull(),
    /** Lowercase brand slug (e.g. "nissan"). Null = industry-wide item. */
    brand: text("brand"),
    /** When dealer-intel fetched and stored this item. */
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("news_items_source_url_week_idx").on(table.sourceUrl, table.weekKey),
    index("news_items_week_brand_idx").on(table.weekKey, table.brand),
  ]
);
export type NewsItemRow = typeof newsItems.$inferSelect;
export type NewNewsItem = typeof newsItems.$inferInsert;
