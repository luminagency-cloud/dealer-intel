/** Returns the ISO 8601 week label for the given date, e.g. "2026-W31". */
export function getISOWeekLabel(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Returns { start, end } UTC dates bracketing the given ISO week (Mon 00:00 – Sun 23:59:59). */
export function getISOWeekBounds(weekLabel: string): { start: Date; end: Date } {
  const match = weekLabel.match(/^(\d{4})-W(\d{2})$/);
  const now = new Date();
  if (!match) return { start: new Date(now.getTime() - 7 * 86400000), end: now };
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() + (1 - jan4Day) * 86400000 + (week - 1) * 7 * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000 + 23 * 3600000 + 59 * 60000 + 59999);
  return { start: monday, end: sunday };
}

/** Returns the ISO week label for the week before the given label. */
export function getPriorISOWeekLabel(cycleLabel: string): string {
  const match = cycleLabel.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return cycleLabel;
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  // Find Monday of the given ISO week, then subtract 7 days
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const weekMonday = new Date(
    jan4.getTime() + (1 - jan4Day) * 86400000 + (week - 1) * 7 * 86400000
  );
  return getISOWeekLabel(new Date(weekMonday.getTime() - 7 * 86400000));
}
