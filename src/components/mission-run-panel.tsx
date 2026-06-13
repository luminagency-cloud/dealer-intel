import Link from "next/link";
import type { Mission, MissionResult, Site, SiteMission } from "@/lib/db";
import { MissionStatusBadge } from "@/components/mission-status-badge";

export interface PanelWorkItem {
  site: Site;
  mission: Mission;
  siteMission: SiteMission | null;
}

/** Mission-driven collection with live background progress: start the whole
 *  run (or one site+mission pair) and watch statuses update. */
export function MissionRunPanel({
  items,
  results,
  executing,
  stalled,
  executeItemAction,
  executeAllAction,
  retryAction,
  resumeAction,
  error,
}: {
  items: PanelWorkItem[];
  results: Map<string, MissionResult>;
  executing: boolean;
  /** Pending/running rows with no live executor — interrupted run, recoverable. */
  stalled?: boolean;
  executeItemAction: (siteId: string, missionId: string) => Promise<void>;
  executeAllAction: () => Promise<void>;
  retryAction: (resultId: string) => Promise<void>;
  resumeAction?: () => Promise<void>;
  error?: string;
}) {
  const all = [...results.values()];
  const done = all.filter(
    (r) => r.status !== "pending" && r.status !== "running"
  ).length;
  const showProgress = executing && all.length > 0;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            Collection{" "}
            {showProgress && (
              <span className="font-normal text-zinc-500">
                — collecting {done}/{all.length}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Runs in the background; this page refreshes itself while work is
            in flight. Roughly a minute per page.
          </p>
        </div>
        {items.length > 0 &&
          (executing ? (
            <button
              type="button"
              disabled
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Collecting…
            </button>
          ) : stalled && resumeAction ? (
            // A stalled run must Resume (re-queue only the orphaned rows), not
            // Start Run — Start Run would re-seed the whole scope and re-collect
            // the sites that already succeeded.
            <form action={resumeAction}>
              <button
                type="submit"
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
              >
                Resume
              </button>
            </form>
          ) : (
            <form action={executeAllAction}>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Start Run
              </button>
            </form>
          ))}
      </div>

      {stalled && (
        <p className="mx-4 mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This run was interrupted — items left mid-collection are stalled with
          no active collector. Click <span className="font-medium">Resume</span>{" "}
          to re-queue and finish them.
        </p>
      )}

      {error && (
        <p className="mx-4 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">
          Nothing to collect in this run&apos;s scope.{" "}
          <Link href="/missions" className="underline">
            Check missions
          </Link>{" "}
          and site status.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-2 font-medium">Site</th>
              <th className="px-4 py-2 font-medium">Mission</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Pages</th>
              <th className="px-4 py-2 font-medium">Detail</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {items.map(({ mission, site }) => {
              const result = results.get(`${site.id}:${mission.id}`);
              const busy =
                result?.status === "pending" || result?.status === "running";
              const retryable =
                result &&
                ["needs_review", "failure", "not_found"].includes(
                  result.status
                );
              return (
                <tr key={`${site.id}:${mission.id}`}>
                  <td className="px-4 py-3 text-zinc-900">{site.name}</td>
                  <td className="px-4 py-3 text-zinc-900">{mission.name}</td>
                  <td className="px-4 py-3">
                    {result ? (
                      <MissionStatusBadge status={result.status} />
                    ) : (
                      <span className="text-xs text-zinc-400">
                        not collected
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {result ? result.pagesCaptured : "—"}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-xs text-zinc-500">
                    {result?.error ?? result?.successfulUrl ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {busy ? (
                      // Queued or in-flight — no action; it'll settle on its own.
                      <span className="text-xs text-zinc-400">—</span>
                    ) : retryable ? (
                      // Enabled even mid-run: Retry queues the item (the drainer
                      // picks it up), so you can re-collect failures without
                      // waiting for the run to finish.
                      <form action={retryAction.bind(null, result.id)}>
                        <button
                          type="submit"
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                        >
                          Retry
                        </button>
                      </form>
                    ) : (
                      <form
                        action={executeItemAction.bind(
                          null,
                          site.id,
                          mission.id
                        )}
                      >
                        <button
                          type="submit"
                          disabled={executing}
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          Collect
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
