import { notFound } from "next/navigation";
import {
  getSnapshotByShareToken,
  getPrimarySiteIds,
  listSnapshotOffers,
  listSnapshotsForGroup,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";

export const dynamic = "force-dynamic";

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The `[id]` path segment is a revocable share token, not the snapshot UUID.
  // Unknown, revoked, or unpublished tokens resolve to null → 404.
  const { id } = await params;
  const snapshot = await getSnapshotByShareToken(id);
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
    <ReportContent
      snapshot={snapshot}
      offers={offers}
      primarySiteIds={primarySiteIds}
      groupSnapshots={groupSnapshots}
      adminControls={false}
    />
  );
}
