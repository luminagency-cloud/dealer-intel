import {
  MISSION_RESULT_STATUS_LABELS,
  type MissionResultStatus,
} from "@/lib/db";

const STYLES: Record<MissionResultStatus, string> = {
  pending: "bg-zinc-100 text-zinc-600",
  running: "bg-blue-100 text-blue-800 animate-pulse",
  success: "bg-green-100 text-green-800",
  needs_review: "bg-amber-100 text-amber-800",
  failure: "bg-red-100 text-red-800",
  not_found: "bg-orange-100 text-orange-800",
  content_removed: "bg-zinc-100 text-zinc-700 line-through",
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
