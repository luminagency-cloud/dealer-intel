/**
 * One-time script: insert the operator admin account into the users table.
 * Uses ADMIN_EMAIL + ADMIN_PASSWORD from .env.
 * Safe to re-run — skips if the email already exists.
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import * as schema from "../src/lib/db/schema.ts";
import bcrypt from "bcryptjs";

const { users } = schema;

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!email || !password) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  process.exit(1);
}

const db = drizzle(neon(process.env.DATABASE_URL), { schema });

const [existing] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
if (existing) {
  console.log(`Admin user already exists: ${existing.email} (role: ${existing.role})`);
  process.exit(0);
}

const passwordHash = await bcrypt.hash(password, 12);
const [user] = await db
  .insert(users)
  .values({ email: email.toLowerCase(), passwordHash, name: "Operator", role: "admin" })
  .returning();

console.log(`Created admin user: ${user.email} (id: ${user.id})`);
