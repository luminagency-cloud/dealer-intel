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
