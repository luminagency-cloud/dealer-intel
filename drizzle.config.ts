import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Next.js convention keeps secrets in .env.local; fall back to .env.
config({ path: [".env.local", ".env"] });

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
