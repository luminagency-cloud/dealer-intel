import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPrimarySiteIds,
  getRunGroupSiteIds,
  getReportSnapshot,
  listSnapshotOffers,
  listSnapshotsForGroup,
  listLatestInventoryForSites,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";
import { getStoredNewsForReport } from "@/lib/news";
import { getEnv } from "@/lib/env";

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

  // Fetch inventory for all sites in the run group (not just those with offers),
  // so newly-collected inventory is always reflected when the report is viewed.
  const inventorySiteIds = snapshot.runGroupId
    ? await getRunGroupSiteIds(snapshot.runGroupId)
    : [...new Set(offers.map((o) => o.siteId).filter(Boolean) as string[])];
  const inventoryData = await listLatestInventoryForSites(inventorySiteIds);

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

  // Build the public shareable link from the snapshot's token. Prefer the
  // viewer's configured origin; fall back to a root-relative /r/<token> that
  // the copy button resolves against the current origin. Undefined (no token
  // yet) falls back to the legacy /r/<id> link in the button.
  const viewerBase = getEnv().VIEWER_PUBLIC_URL?.replace(/\/+$/, "");
  const shareUrl = snapshot.shareToken
    ? `${viewerBase ?? ""}/r/${snapshot.shareToken}`
    : undefined;

  return (
    <div>
      <div className="mb-4">
        <Link href="/reports" className="text-sm text-zinc-700 hover:underline dark:text-zinc-200">
          ← Reports
        </Link>
      </div>
      <ReportContent
        snapshot={snapshot}
        offers={offers}
        primarySiteIds={primarySiteIds}
        groupSnapshots={groupSnapshots}
        news={news}
        inventoryData={inventoryData}
        adminControls={true}
        shareUrl={shareUrl}
        containerClassName="mx-auto max-w-6xl"
      />
    </div>
  );
}
