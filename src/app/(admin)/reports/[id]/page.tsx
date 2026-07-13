import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ensureShareToken,
  getPrimarySiteIds,
  getRunGroupSiteIds,
  getReportSnapshot,
  listSnapshotOffers,
  listSnapshotsForGroup,
  listLatestInventoryForSites,
  setSnapshotClientVisible,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";
import { getStoredNewsForReport } from "@/lib/news";

export const dynamic = "force-dynamic";

function getPublicViewerOrigin(): {
  origin?: string;
  unavailableLabel?: string;
} {
  const raw = process.env.VIEWER_PUBLIC_URL;
  if (!raw) return { unavailableLabel: "Set public report URL" };

  const trimmed = raw.trim().replace(/\s+#.*$/, "").replace(/\/+$/, "");
  if (!trimmed) return { unavailableLabel: "Set public report URL" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { unavailableLabel: "Fix public report URL" };
  }

  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    return { unavailableLabel: "Use non-local report URL" };
  }

  return { origin: url.origin };
}

export default async function AdminReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();
  const snapshotId = snapshot.id;

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

  // Build the public shareable link from the snapshot's token. Do not fall
  // back to the admin request origin: locally that would copy localhost, which
  // is not shareable.
  const viewerOrigin = getPublicViewerOrigin();
  let shareToken = snapshot.shareToken;
  if (!snapshot.clientVisible) {
    await setSnapshotClientVisible(snapshotId, true);
  }
  if (!shareToken) {
    shareToken = await ensureShareToken(snapshotId);
  }

  const shareUrl = shareToken && viewerOrigin.origin
    ? `${viewerOrigin.origin}/r/${shareToken}`
    : undefined;
  const shareUrlUnavailableLabel = shareToken
    ? viewerOrigin.unavailableLabel
    : "Share link unavailable";

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
        shareUrlUnavailableLabel={shareUrlUnavailableLabel}
        containerClassName="mx-auto max-w-6xl"
      />
    </div>
  );
}
