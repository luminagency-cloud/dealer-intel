/** ISO 8601 week label, e.g. "2026-W33".
 *
 *  Must stay byte-identical to the admin app's `getISOWeekLabel`
 *  (`src/lib/cycle.ts`): that one writes `news_items.week_key`, this one reads
 *  it. A local-time approximation used to live inline in `repository.ts` and
 *  was one week behind on Mon-Fri, so reports rendered an empty news section
 *  on those days. `scripts/verify-iso-week.ts` asserts the two agree. */
export function isoWeekLabel(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
