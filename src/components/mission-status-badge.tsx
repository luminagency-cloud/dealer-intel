import {
  MISSION_RESULT_STATUS_LABELS,
  type MissionResultStatus,
} from "@/lib/db";

const STYLES: Record<MissionResultStatus, string> = {
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-200",
  running: "bg-blue-100 text-blue-800 animate-pulse dark:bg-blue-900 dark:text-blue-200",
  success: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  needs_review: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  failure: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  not_found: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  content_removed: "bg-zinc-100 text-zinc-700 line-through dark:bg-zinc-800 dark:text-zinc-200",
};

export function MissionStatusBadge({
  status,
}: {
  status: MissionResultStatus;
}) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {MISSION_RESULT_STATUS_LABELS[status]}
    </span>
  );
}
