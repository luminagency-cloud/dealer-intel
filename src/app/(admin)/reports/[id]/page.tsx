import Link from "next/link";
import { notFound } from "next/navigation";
import {
  OFFER_TYPE_LABELS,
  type SnapshotOffer,
} from "@/lib/db";
import {
  getPrimarySiteIds,
  getReportSnapshot,
  listSnapshotOffers,
  listSnapshotsForGroup,
} from "@/lib/db/repository";

export const dynamic = "force-dynamic";

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toLocaleString()}`;
}

function formatDate(date: Date | null) {
  return date ? date.toLocaleString() : "—";
}

function gradeStyle(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "pass") return "bg-green-100 text-green-800";
  if (g === "fail") return "bg-red-100 text-red-800";
  return "bg-amber-100 text-amber-800";
}

function vehicleKey(o: SnapshotOffer): string {
  return [o.vehicleMake, o.vehicleModel].filter(Boolean).join(" ");
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();

  const [offers, primaryIds, groupSnapshots] = await Promise.all([
    listSnapshotOffers(snapshot.id),
    snapshot.runGroupId
      ? getPrimarySiteIds(snapshot.runGroupId)
      : Promise.resolve(new Set<string>()),
    snapshot.runGroupId
      ? listSnapshotsForGroup(snapshot.runGroupId)
      : Promise.resolve([snapshot]),
  ]);

  const primaryNames = [
    ...new Set(
      offers
        .filter((o) => o.siteId && primaryIds.has(o.siteId))
        .map((o) => o.siteName)
    ),
  ];

  // Compliance roll-up across the frozen offers.
  const gradeCounts = offers.reduce<Record<string, number>>((acc, o) => {
    if (o.complianceGrade)
      acc[o.complianceGrade] = (acc[o.complianceGrade] ?? 0) + 1;
    return acc;
  }, {});

  // Competitive view: offers grouped by vehicle, primary dealer first, and the
  // lowest monthly payment in each vehicle group flagged.
  const byVehicle = new Map<string, SnapshotOffer[]>();
  for (const o of offers) {
    const key = vehicleKey(o) || "Other / unspecified";
    const list = byVehicle.get(key) ?? [];
    list.push(o);
    byVehicle.set(key, list);
  }
  const vehicleGroups = [...byVehicle.entries()].sort((a, b) => {
    // Real vehicles first (alpha), the catch-all bucket last.
    const aOther = a[0].startsWith("Other");
    const bOther = b[0].startsWith("Other");
    if (aOther !== bOther) return aOther ? 1 : -1;
    return a[0].localeCompare(b[0]);
  });
  const isPrimary = (o: SnapshotOffer) =>
    Boolean(o.siteId && primaryIds.has(o.siteId));

  return (
    <div>
      <div className="mb-6">
        <Link href="/reports" className="text-sm text-zinc-500 hover:underline">
          ← Reports
        </Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-zinc-900">
              {snapshot.label || `Report ${snapshot.id.slice(0, 8)}`}
            </h1>
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
              {snapshot.runGroupName || "All sites"}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {primaryNames.length > 0 && (
              <>
                Anchored on{" "}
                <span className="font-medium text-zinc-700">
                  {primaryNames.join(", ")}
                </span>
                {" · "}
              </>
            )}
            {snapshot.offerCount} offers across {snapshot.siteCount} sites ·
            Published {formatDate(snapshot.approvedAt)}
          </p>
        </div>
        <a
          href={`/reports/${snapshot.id}/export`}
          className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
        >
          Export CSV
        </a>
      </div>

      {/* Compliance summary */}
      {Object.keys(gradeCounts).length > 0 && (
        <div className="mb-8 flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm">
          <span className="text-zinc-500">Compliance:</span>
          {Object.entries(gradeCounts).map(([grade, count]) => (
            <span
              key={grade}
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${gradeStyle(grade)}`}
            >
              {count} {grade}
            </span>
          ))}
        </div>
      )}

      {/* Competitive view by vehicle */}
      <div className="mb-8 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">By Vehicle</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Offers side by side across the group. Primary dealer highlighted;
            lowest monthly payment per vehicle flagged.
          </p>
        </div>
        {offers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            This snapshot has no offers.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2 font-medium">Site</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Payment</th>
                <th className="px-4 py-2 font-medium">APR</th>
                <th className="px-4 py-2 font-medium">Term</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">Cash</th>
                <th className="px-4 py-2 font-medium">Compliance</th>
                <th className="px-4 py-2 font-medium">Evidence</th>
              </tr>
            </thead>
            {vehicleGroups.map(([vehicle, group]) => {
                const payments = group
                  .map((o) => o.monthlyPayment)
                  .filter((p): p is number => p !== null);
                const lowest = payments.length ? Math.min(...payments) : null;
                const ordered = [...group].sort((a, b) => {
                  const ap = isPrimary(a) ? 0 : 1;
                  const bp = isPrimary(b) ? 0 : 1;
                  if (ap !== bp) return ap - bp;
                  return a.siteName.localeCompare(b.siteName);
                });
                return (
                  <tbody key={vehicle} className="divide-y divide-zinc-100">
                    <tr className="bg-zinc-50">
                      <td
                        colSpan={9}
                        className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600"
                      >
                        {vehicle}
                      </td>
                    </tr>
                    {ordered.map((o) => (
                      <tr
                        key={o.id}
                        className={isPrimary(o) ? "bg-blue-50/50" : ""}
                      >
                        <td className="px-4 py-3 text-zinc-900">
                          {o.siteName}
                          {isPrimary(o) && (
                            <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-blue-700">
                              Primary
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {OFFER_TYPE_LABELS[o.offerType]}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {o.monthlyPayment === null ? (
                            "—"
                          ) : (
                            <span
                              className={
                                lowest !== null && o.monthlyPayment === lowest
                                  ? "font-semibold text-green-700"
                                  : ""
                              }
                            >
                              {money(o.monthlyPayment)}/mo
                              {lowest !== null &&
                                o.monthlyPayment === lowest &&
                                payments.length > 1 && (
                                  <span className="ml-1 text-[10px] uppercase">
                                    low
                                  </span>
                                )}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {o.apr === null ? "—" : `${o.apr}%`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {o.termMonths === null ? "—" : `${o.termMonths} mo`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {money(o.dueAtSigning)}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {money(o.cashIncentive)}
                        </td>
                        <td className="px-4 py-3">
                          {o.complianceGrade ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${gradeStyle(o.complianceGrade)}`}
                            >
                              {o.complianceGrade}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {o.sourceEvidenceId ? (
                            <a
                              href={`/api/evidence/${o.sourceEvidenceId}/file`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-blue-600 hover:underline"
                            >
                              View
                            </a>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                );
              })}
          </table>
        )}
      </div>

      {/* Snapshot history / trend for the group */}
      {snapshot.runGroupName && groupSnapshots.length > 1 && (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-zinc-900">
              Snapshot History
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {snapshot.runGroupName} over time — open an earlier report to
              compare.
            </p>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2 font-medium">Published</th>
                <th className="px-4 py-2 font-medium">Report</th>
                <th className="px-4 py-2 font-medium text-right">Offers</th>
                <th className="px-4 py-2 font-medium text-right">Sites</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {groupSnapshots.map((s) => (
                <tr
                  key={s.id}
                  className={s.id === snapshot.id ? "bg-blue-50/50" : ""}
                >
                  <td className="px-4 py-2.5 text-zinc-600">
                    {formatDate(s.approvedAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    {s.id === snapshot.id ? (
                      <span className="font-medium text-zinc-900">
                        {s.label || "This report"} (current)
                      </span>
                    ) : (
                      <Link
                        href={`/reports/${s.id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {s.label || `Snapshot ${s.id.slice(0, 8)}`}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-700">
                    {s.offerCount}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-700">
                    {s.siteCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
