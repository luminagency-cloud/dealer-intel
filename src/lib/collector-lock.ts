/**
 * One Chrome Collector drive at a time.
 *
 * Inventory collection and offer collection both drive the same extension, and
 * the extension keeps a single browser session: `ensureSiteSession` closes the
 * live window as soon as the next request names a different dealer. Two drives
 * running side by side therefore steal the tab from each other — the observed
 * symptom was an inventory run failing nearly every dealer after an offer run
 * was started next to it.
 *
 * Web Locks are per-origin and released when a tab closes or crashes, so this
 * one name serializes every admin tab in the browser without a heartbeat or a
 * stored flag. First drive in wins; the second is told to wait.
 *
 * ponytail: app-side only. The extension itself still has no interlock, so a
 * drive started outside these two call sites can still collide.
 */
const COLLECTOR_LOCK = "dealer-intel-chrome-collector";

export async function withCollectorLock(
  run: () => Promise<void>,
  onBusy: () => void
): Promise<void> {
  await navigator.locks.request(
    COLLECTOR_LOCK,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        onBusy();
        return;
      }
      await run();
    }
  );
}
