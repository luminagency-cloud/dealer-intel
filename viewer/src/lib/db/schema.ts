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

// Enums must match the main app's Postgres enum definitions exactly.
export const missionTypeEnum = pgEnum("mission_type", [
  "homepage_offers",
  "finance_offers",
  "service_specials",
  "promotional_banners",
]);

export const offerTypeEnum = pgEnum("offer_type", [
  "lease",
  "finance",
  "cash",
  "service",
  "promotional",
]);

export type OfferType = (typeof offerTypeEnum.enumValues)[number];

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  role: text("role", { enum: ["admin", "dealer"] })
    .notNull()
    .default("dealer"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

export const reportSnapshots = pgTable("report_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionRunId: uuid("collection_run_id").notNull(),
  runGroupId: uuid("run_group_id"),
  runGroupName: text("run_group_name"),
  label: text("label"),
  offerCount: integer("offer_count").notNull().default(0),
  siteCount: integer("site_count").notNull().default(0),
  clientVisible: boolean("client_visible").notNull().default(false),
  shareToken: text("share_token").unique(),
  approvedAt: timestamp("approved_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  approvedBy: text("approved_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const snapshotOffers = pgTable("snapshot_offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: uuid("snapshot_id").notNull(),
  siteId: uuid("site_id"),
  siteName: text("site_name").notNull(),
  siteBrand: text("site_brand"),
  siteState: text("site_state"),
  sourceEvidenceId: uuid("source_evidence_id"),
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
  complianceGrade: text("compliance_grade"),
  complianceDetailsJson: jsonb("compliance_details_json"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Run group members — needed to identify the primary (anchor) dealer.
export const runGroupMembers = pgTable(
  "run_group_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runGroupId: uuid("run_group_id").notNull(),
    siteId: uuid("site_id").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => [
    uniqueIndex("run_group_members_unique").on(table.runGroupId, table.siteId),
  ]
);

export const inventoryResults = pgTable(
  "inventory_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    weekKey: text("week_key").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(),
    detectedPlatform: text("detected_platform"),
    accessRoute: text("access_route"),
    attempts: integer("attempts"),
    sourceUrl: text("source_url"),
    totals: jsonb("totals"),
    makeSubtotals: jsonb("make_subtotals"),
    models: jsonb("models"),
    warnings: text("warnings").array(),
    error: jsonb("error"),
  }
);

export const newsItems = pgTable(
  "news_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    weekKey: text("week_key").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    sourceUrl: text("source_url").notNull(),
    publishedAt: text("published_at").notNull(),
    category: text("category").notNull(),
    brand: text("brand"),
    pulledAt: timestamp("pulled_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

export type User = typeof users.$inferSelect;
export type RunGroup = typeof runGroups.$inferSelect;
export type ReportSnapshot = typeof reportSnapshots.$inferSelect;
export type SnapshotOffer = typeof snapshotOffers.$inferSelect;
export type InventoryResult = typeof inventoryResults.$inferSelect;
