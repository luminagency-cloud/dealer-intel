import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import {
  getSnapshot,
  getPrimarySiteIds,
  getUserRunGroups,
  listSnapshotOffers,
  listSnapshotsForGroup,
  listLatestInventoryForSites,
  getStoredNewsForReport,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const snapshot = await getSnapshot(id);
  if (!snapshot) notFound();

  // Dealers can only view snapshots from their assigned groups.
  if (session.user.role !== "admin" && snapshot.runGroupId) {
    const userGroups = await getUserRunGroups(session.user.id);
    const allowed = userGroups.some((g) => g.id === snapshot.runGroupId);
    if (!allowed) notFound();
  }

  const [offers, primarySiteIds, groupSnapshots] = await Promise.all([
    listSnapshotOffers(snapshot.id),
    snapshot.runGroupId
      ? getPrimarySiteIds(snapshot.runGroupId)
      : Promise.resolve(new Set<string>()),
    snapshot.runGroupId
      ? listSnapshotsForGroup(snapshot.runGroupId)
      : Promise.resolve([snapshot]),
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
    <div>
      <div className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-12 max-w-5xl items-center gap-4 px-4 text-sm">
          <Link href="/dashboard" className="text-zinc-500 hover:text-zinc-900">
            ← Reports
          </Link>
        </div>
      </div>
      <ReportContent
        snapshot={snapshot}
        offers={offers}
        primarySiteIds={primarySiteIds}
        groupSnapshots={groupSnapshots}
        news={news}
        inventoryData={inventoryData}
        adminControls={false}
      />
    </div>
  );
}
