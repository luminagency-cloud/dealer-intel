import { randomBytes } from "node:crypto";

/**
 * Mint a URL-safe, unguessable share token for a published snapshot.
 * 24 random bytes → 32-char base64url string (no padding, no `+//`), safe to
 * drop straight into a `/r/<token>` path. Regenerating a snapshot's token
 * invalidates any link built from the old one.
 */
export function mintShareToken(): string {
  return randomBytes(24).toString("base64url");
}
