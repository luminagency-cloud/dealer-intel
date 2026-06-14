import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPrimarySiteIds,
  getReportSnapshot,
  listSnapshotOffers,
  listSnapshotsForGroup,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";

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
        adminControls={true}
      />
    </div>
  );
}
