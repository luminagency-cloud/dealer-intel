import { z } from "zod";

/**
 * All variables are optional at parse time so the app can build and boot
 * before credentials exist. Subsystems that need a variable call
 * `requireEnv` at request time and fail with a descriptive error.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  ADGRADER_BASE_URL: z.string().min(1).optional(),
  ADGRADER_CLIENT_ID: z.string().min(1).optional(),
  ADGRADER_CLIENT_SECRET: z.string().min(1).optional(),
  NEWS_API_URL: z.string().url().optional(),
  NEWS_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

function readEnv(): Env {
  // Treat empty strings as unset so placeholder lines in .env
  // (e.g. `R2_BUCKET=`) don't fail validation for unrelated subsystems.
  const source = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== "")
  );
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  return readEnv();
}

export function requireEnv(key: keyof Env): string {
  const value = readEnv()[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

export const isDatabaseConfigured = () => Boolean(process.env.DATABASE_URL);
export const isAuthConfigured = () => Boolean(process.env.AUTH_SECRET);
export const isR2Configured = () =>
  Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET
  );

export const isAdScoreConfigured = () =>
  Boolean(
    process.env.ADGRADER_BASE_URL &&
      process.env.ADGRADER_CLIENT_ID &&
      process.env.ADGRADER_CLIENT_SECRET
  );
