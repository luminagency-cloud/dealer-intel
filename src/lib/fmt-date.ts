const TZ = "America/New_York";

/** Short date + time in Eastern time, e.g. "Jun 15, 2:42 PM" */
export function fmtDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Month + year only, e.g. "Jun 2026" */
export function fmtMonthYear(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    year: "numeric",
  });
}

/** Elapsed time between two timestamps, e.g. "12 min" or "< 1 min". */
export function totalMin(
  start: Date | null | undefined,
  end: Date | null | undefined
): string {
  if (!start || !end) return "";
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  return mins < 1 ? "< 1 min" : `${mins} min`;
}

/** Compact snapshot label, e.g. "20Jun-3grps-53pgs" */
export function fmtSnapshotLabel(
  date: Date,
  groupCount: number,
  pageCount: number
): string {
  const raw = date.toLocaleString("en-US", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
  });
  // en-US returns "Jun 20" — reorder to "20Jun"
  const [mon, day] = raw.split(" ");
  return `${day}${mon}-${groupCount}grps-${pageCount}pgs`;
}
