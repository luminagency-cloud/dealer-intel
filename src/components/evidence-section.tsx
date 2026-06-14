"use client";

import { useState } from "react";
import {
  EVIDENCE_TYPE_LABELS,
  MISSION_TYPE_LABELS,
  evidenceTypeEnum,
  missionTypeEnum,
  type Evidence,
  type Site,
} from "@/lib/db";

export function EvidenceSection({
  evidence,
  siteOptions,
  siteNames,
  uploadAction,
  deleteAction,
  canUpload,
}: {
  evidence: Evidence[];
  siteOptions: Pick<Site, "id" | "name">[];
  siteNames: Record<string, string>;
  uploadAction: (formData: FormData) => Promise<void>;
  deleteAction: (evidenceId: string) => Promise<void>;
  canUpload: boolean;
}) {
  const [siteFilter, setSiteFilter] = useState<string>("all");

  const visible =
    siteFilter === "all"
      ? evidence
      : evidence.filter((e) => e.siteId === siteFilter);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">
          Evidence{" "}
          <span className="font-normal text-zinc-400">
            ({visible.length}{siteFilter !== "all" ? ` of ${evidence.length}` : ""})
          </span>
        </h2>
        {evidence.length > 0 && (
          <select
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 focus:outline-none"
          >
            <option value="all">All sites</option>
            {siteOptions
              .filter((s) => evidence.some((e) => e.siteId === s.id))
              .map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
          </select>
        )}
      </div>

      {evidence.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">
          No evidence captured for this run yet.
        </p>
      ) : visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">
          No evidence for the selected site.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Detail</th>
              {siteFilter === "all" && (
                <th className="px-4 py-2 font-medium">Site</th>
              )}
              <th className="px-4 py-2 font-medium">Mission</th>
              <th className="px-4 py-2 font-medium">Captured</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {visible.map((row) => (
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
                {siteFilter === "all" && (
                  <td className="px-4 py-3 text-zinc-900">
                    {siteNames[row.siteId] ?? row.siteId.slice(0, 8)}
                  </td>
                )}
                <td className="px-4 py-3 text-zinc-600">
                  {MISSION_TYPE_LABELS[row.missionType]}
                </td>
                <td className="px-4 py-3 text-zinc-600">
                  {row.createdAt.toLocaleString()}
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
                    <form action={deleteAction.bind(null, row.id)}>
                      <button
                        type="submit"
                        className="text-red-700 hover:underline"
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canUpload && (
        <form
          action={uploadAction}
          className="flex flex-wrap items-end gap-3 border-t border-zinc-100 bg-zinc-50 px-4 py-3"
        >
          <label className="block text-xs font-medium text-zinc-600">
            Site
            <select
              name="siteId"
              required
              defaultValue=""
              className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="" disabled>
                Select…
              </option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
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
  );
}
