import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  EVIDENCE_TYPE_LABELS,
  MISSION_TYPE_LABELS,
  evidenceTypeEnum,
  getDb,
  missionTypeEnum,
  sites,
} from "@/lib/db";
import {
  getCollectionRun,
  listEvidenceForRunSite,
} from "@/lib/db/repository";
import {
  deleteRunEvidence,
  uploadRunEvidence,
} from "../../../actions";

export const dynamic = "force-dynamic";

export default async function SiteEvidencePage({
  params,
}: {
  params: Promise<{ id: string; siteId: string }>;
}) {
  const { id: runId, siteId } = await params;

  const [run, [site], evidence] = await Promise.all([
    getCollectionRun(runId),
    getDb().select().from(sites).where(eq(sites.id, siteId)),
    listEvidenceForRunSite(runId, siteId),
  ]);

  if (!run || !site) notFound();

  const canUpload = run.status !== "complete";

  return (
    <div>
      <div className="mb-6 flex items-center gap-2 text-sm text-zinc-500">
        <Link href="/runs" className="hover:underline">
          Runs
        </Link>
        <span>›</span>
        <Link href={`/runs/${runId}`} className="hover:underline">
          Run {runId.slice(0, 8)}
        </Link>
        <span>›</span>
        <span className="text-zinc-900">{site.name}</span>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">{site.name}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Evidence — {evidence.length} item{evidence.length !== 1 ? "s" : ""}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        {evidence.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No evidence captured for this site in this run.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Detail</th>
                <th className="px-4 py-2 font-medium">Mission</th>
                <th className="px-4 py-2 font-medium">Captured</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {evidence.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 text-zinc-900">
                    {EVIDENCE_TYPE_LABELS[row.evidenceType]}
                  </td>
                  <td className="max-w-xs px-4 py-3 text-zinc-700">
                    {row.label ? (
                      <span className="block truncate" title={row.label}>
                        {row.label}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                    {row.textContent && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-600">
                          Disclaimer text
                        </summary>
                        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-zinc-600">
                          {row.textContent}
                        </p>
                      </details>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {MISSION_TYPE_LABELS[row.missionType]}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {new Date(row.createdAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <a
                        href={`/api/evidence/${row.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-900 underline hover:text-zinc-600"
                      >
                        View
                      </a>
                      {canUpload && (
                        <form action={deleteRunEvidence.bind(null, runId, row.id)}>
                          <button
                            type="submit"
                            className="text-red-700 hover:underline"
                          >
                            Delete
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canUpload && (
          <form
            action={uploadRunEvidence.bind(null, runId)}
            className="flex flex-wrap items-end gap-3 border-t border-zinc-100 bg-zinc-50 px-4 py-3"
          >
            {/* siteId is pre-filled for this page */}
            <input type="hidden" name="siteId" value={siteId} />
            <label className="block text-xs font-medium text-zinc-600">
              Mission
              <select
                name="missionType"
                required
                defaultValue=""
                className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Select…
                </option>
                {missionTypeEnum.enumValues.map((value) => (
                  <option key={value} value={value}>
                    {MISSION_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-zinc-600">
              Evidence Type
              <select
                name="evidenceType"
                required
                defaultValue=""
                className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Select…
                </option>
                {evidenceTypeEnum.enumValues.map((value) => (
                  <option key={value} value={value}>
                    {EVIDENCE_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-zinc-600">
              File
              <input
                type="file"
                name="file"
                required
                accept=".png,.jpg,.jpeg,.webp,.html"
                className="mt-1 block text-sm text-zinc-600 file:mr-2 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-2 file:py-1 file:text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Upload Evidence
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
