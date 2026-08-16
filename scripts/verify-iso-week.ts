/** The viewer reads `news_items.week_key`; the admin app writes it. If the two
 *  week-label functions disagree, every report renders an empty news section
 *  on the days they differ. Run: npx tsx scripts/verify-iso-week.ts */
import assert from "node:assert";
import { getISOWeekLabel } from "@/lib/cycle";
import { isoWeekLabel } from "../viewer/src/lib/iso-week";

// Known ISO week boundaries (2026-01-01 is a Thursday, so it is in W01).
assert.equal(getISOWeekLabel(new Date(2026, 0, 1)), "2026-W01");
assert.equal(getISOWeekLabel(new Date(2026, 7, 16)), "2026-W33");

// Every day over three years, at a late local hour (the old local-time
// approximation drifted most there).
let checked = 0;
for (let i = 0; i < 1100; i++) {
  const d = new Date(2025, 0, 1 + i, 20, 33);
  assert.equal(
    isoWeekLabel(d),
    getISOWeekLabel(d),
    `week label mismatch on ${d.toDateString()}`
  );
  checked++;
}

console.log(`ok — viewer and admin week labels agree on ${checked} days`);
