import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { requireEnv } from "@/lib/env";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let _db: Db | null = null;

/** Lazily creates the Drizzle client so the app can build and boot
 *  without DATABASE_URL; callers fail at request time with a clear error. */
export function getDb(): Db {
  if (!_db) {
    _db = drizzle(neon(requireEnv("DATABASE_URL")), { schema });
  }
  return _db;
}

export { isDatabaseConfigured } from "@/lib/env";
export * from "./schema";
