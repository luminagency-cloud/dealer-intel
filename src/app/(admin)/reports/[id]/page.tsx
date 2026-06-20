import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPrimarySiteIds,
  getReportSnapshot,
  listSnapshotOffers,
  listSnapshotsForGroup,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";
import { getStoredNewsForReport } from "@/lib/news";

export const dynamic = "force-dynamic";

export default async function AdminReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();

  const [offers, primarySiteIds, groupSnapshots] = await Promise.all([
    listSnapshotOffers(snapshot.id),
    snapshot.runGroupId
      ? getPrimarySiteIds(snapshot.runGroupId)
      : Promise.resolve(new Set<string>()),
    snapshot.runGroupId
      ? listSnapshotsForGroup(snapshot.runGroupId)
      : Promise.resolve([snapshot]),
  ]);

  // Infer brand from the most common vehicleMake across offers.
  // Will be null until dealers have a brand field; news fetch gracefully
  // returns null when brand is unknown or the API is not configured.
  const makeCounts = new Map<string, number>();
  for (const o of offers) {
    if (o.vehicleMake) makeCounts.set(o.vehicleMake, (makeCounts.get(o.vehicleMake) ?? 0) + 1);
  }
  const primaryBrand = makeCounts.size > 0
    ? [...makeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  const news = await getStoredNewsForReport(primaryBrand);

  return (
    <div>
      <div className="mb-4">
        <Link href="/reports" className="text-sm text-zinc-500 hover:underline">
          ← Reports
        </Link>
      </div>
      <ReportContent
        snapshot={snapshot}
        offers={offers}
        primarySiteIds={primarySiteIds}
        groupSnapshots={groupSnapshots}
        news={news}
        adminControls={true}
        containerClassName="mx-auto max-w-6xl"
      />
    </div>
  );
}
