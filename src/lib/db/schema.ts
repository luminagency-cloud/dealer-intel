import {
  boolean,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
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

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
export type Mission = typeof missions.$inferSelect;
export type NewMission = typeof missions.$inferInsert;
