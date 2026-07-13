import { notFound } from "next/navigation";
import {
  getPrimarySiteIds,
  getReportSnapshotByShareToken,
  listSnapshotOffers,
  listLatestInventoryForSites,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";
import { getStoredNewsForReport } from "@/lib/news";

export const dynamic = "force-dynamic";

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshotByShareToken(id);
  // Public surface: only share-token URLs for public snapshots are viewable.
  if (!snapshot || !snapshot.clientVisible) notFound();

  const [offers, primarySiteIds] = await Promise.all([
    listSnapshotOffers(snapshot.id),
    snapshot.runGroupId
      ? getPrimarySiteIds(snapshot.runGroupId)
      : Promise.resolve(new Set<string>()),
  ]);

  const snapshotSiteIds = [...new Set(offers.map((o) => o.siteId).filter(Boolean) as string[])];
  const inventoryData = await listLatestInventoryForSites(snapshotSiteIds);

  const makeCounts = new Map<string, number>();
  for (const o of offers) {
    if (o.vehicleMake) makeCounts.set(o.vehicleMake, (makeCounts.get(o.vehicleMake) ?? 0) + 1);
  }
  const primaryBrand = makeCounts.size > 0
    ? [...makeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  const news = await getStoredNewsForReport(primaryBrand);

  return (
    <ReportContent
      snapshot={snapshot}
      offers={offers}
      primarySiteIds={primarySiteIds}
      news={news}
      inventoryData={inventoryData}
      adminControls={false}
    />
  );
}
