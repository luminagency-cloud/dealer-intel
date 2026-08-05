/**
 * Self-check for the analysis stop signal. The dangerous failure here is a
 * stop flag that outlives the analysis it was meant for — it would silently
 * abort the NEXT analysis after one page. Touches no database.
 *
 * Usage:
 *   npx tsx scripts/check-analysis-stop.ts
 */
import assert from "node:assert/strict";
import { isAnalysisStopping, stopAnalysis } from "../src/lib/analysis/runner";

// The runner tracks active analyses on globalThis so the set survives HMR;
// that's also the only way to simulate "a run is in flight" without a DB.
const active = (globalThis as unknown as { __activeAnalysisRuns: Set<string> })
  .__activeAnalysisRuns;

const RUN = "11111111-1111-1111-1111-111111111111";

// Stopping a run that isn't analyzing must be a no-op. Otherwise the flag sits
// there and kills the next real analysis one page in.
stopAnalysis(RUN);
assert.equal(
  isAnalysisStopping(RUN),
  false,
  "stop on an idle run must not leave a flag behind"
);

// With an analysis in flight, the signal takes.
active.add(RUN);
stopAnalysis(RUN);
assert.equal(isAnalysisStopping(RUN), true, "stop on an active run signals it");

// Signals are per-run — stopping one must not touch another.
const OTHER = "22222222-2222-2222-2222-222222222222";
active.add(OTHER);
assert.equal(
  isAnalysisStopping(OTHER),
  false,
  "stop signal must not leak across runs"
);

console.log("analysis stop signal: all checks passed");
