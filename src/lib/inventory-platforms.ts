/**
 * Which dealer platforms visible-Chrome inventory collection can drive.
 *
 * This is the app's mirror of the adapter registry in
 * `extension/inventory/adapters/`. It gates two things — the server refusing
 * to seed a batch, and the client disabling the run button — which used to
 * hold two independent copies of the same list and could disagree after a
 * platform was added.
 *
 * Keep in step with the `platforms` array each adapter registers. The
 * extension still fails closed on its own if a platform reaches it without an
 * adapter; this list only decides what the operator is allowed to start.
 */
export const CHROME_INVENTORY_PLATFORMS = [
  "ddc",
  "dealer_inspire",
  "dealer_on",
  "apollo",
  "dealer_alchemist",
  "dealer_masters",
  "sokal",
] as const;

const supported = new Set<string>(CHROME_INVENTORY_PLATFORMS);

export function supportsChromeInventory(platform: string | null | undefined): boolean {
  return supported.has((platform ?? "").trim().toLowerCase());
}
