import { notFound } from "next/navigation";
import {
  getPrimarySiteIds,
  getReportSnapshot,
  listSnapshotOffers,
} from "@/lib/db/repository";
import { ReportContent } from "@/components/report/ReportContent";

export const dynamic = "force-dynamic";

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();

  const [offers, primarySiteIds] = await Promise.all([
    listSnapshotOffers(snapshot.id),
    snapshot.runGroupId
      ? getPrimarySiteIds(snapshot.runGroupId)
      : Promise.resolve(new Set<string>()),
  ]);

  return (
    <ReportContent
      snapshot={snapshot}
      offers={offers}
      primarySiteIds={primarySiteIds}
      adminControls={false}
    />
  );
}
