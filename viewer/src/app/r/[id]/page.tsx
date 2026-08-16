import { notFound } from "next/navigation";
import { getSnapshotByShareToken, getReportData } from "@/lib/db/repository";
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

  const { offers, primarySiteIds, news, inventoryData } = await getReportData(snapshot);

  return (
    <ReportContent
      snapshot={snapshot}
      offers={offers}
      primarySiteIds={primarySiteIds}
      news={news}
      inventoryData={inventoryData}
    />
  );
}
