/**
 * Self-check for the Chrome run liveness rule. This one predicate decides
 * whether the run page polls for updates, whether the "interrupted" banner
 * shows, and whether Resume is offered — getting the staleness comparison
 * backwards would break all three silently. Touches no database.
 *
 * Usage:
 *   npx tsx scripts/check-chrome-heartbeat.ts
 */
import assert from "node:assert/strict";
import {
  CHROME_HEARTBEAT_STALE_MS,
  isChromeRunLive,
} from "../src/lib/chrome-collector";

const fresh = new Date(Date.now() - 1_000);
const stale = new Date(Date.now() - CHROME_HEARTBEAT_STALE_MS - 1_000);

const chromeRunning = {
  collectorMode: "chrome_extension",
  status: "running",
  chromeHeartbeatAt: fresh,
};

assert.equal(isChromeRunLive(chromeRunning), true, "fresh heartbeat = live");

assert.equal(
  isChromeRunLive({ ...chromeRunning, chromeHeartbeatAt: stale }),
  false,
  "stale heartbeat = tab is gone"
);

assert.equal(
  isChromeRunLive({ ...chromeRunning, chromeHeartbeatAt: null }),
  false,
  "never reported = not live"
);

// A completed run keeps its last heartbeat forever; status has to gate it or
// finished runs would poll and render as "collecting" indefinitely.
assert.equal(
  isChromeRunLive({ ...chromeRunning, status: "completed" }),
  false,
  "completed run is not live"
);

// The Current collector has its own in-process registry; a stray heartbeat on
// such a run must never make it look live.
assert.equal(
  isChromeRunLive({ ...chromeRunning, collectorMode: "current" }),
  false,
  "current-collector run is never judged by heartbeat"
);

console.log("chrome heartbeat liveness: all checks passed");
