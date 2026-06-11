import { RUN_STATUS_LABELS, type RunStatus } from "@/lib/db";

const STATUS_STYLES: Record<RunStatus, string> = {
  pending: "bg-zinc-100 text-zinc-600",
  running: "bg-blue-100 text-blue-800",
  review: "bg-amber-100 text-amber-800",
  published: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}
