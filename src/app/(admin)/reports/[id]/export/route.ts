import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { OFFER_TYPE_LABELS, MISSION_TYPE_LABELS } from "@/lib/db";
import {
  getReportSnapshot,
  listSnapshotOffers,
} from "@/lib/db/repository";

/** Phase 11 export: the snapshot's frozen offers as CSV. Pure read of the
 *  report data — no computation, no site access. */
function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote and escape anything that could break the row (commas, quotes, newlines).
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();

  const offers = await listSnapshotOffers(id);

  const header = [
    "site",
    "brand",
    "state",
    "mission",
    "offer_type",
    "vehicle_make",
    "vehicle_model",
    "vehicle_trim",
    "monthly_payment",
    "apr_percent",
    "term_months",
    "due_at_signing",
    "cash_incentive",
    "sale_price",
    "confidence",
    "compliance_grade",
    "disclaimer",
  ];
  const lines = [header.join(",")];
  for (const o of offers) {
    lines.push(
      [
        o.siteName,
        o.siteBrand,
        o.siteState,
        MISSION_TYPE_LABELS[o.missionType],
        OFFER_TYPE_LABELS[o.offerType],
        o.vehicleMake,
        o.vehicleModel,
        o.vehicleTrim,
        o.monthlyPayment,
        o.apr,
        o.termMonths,
        o.dueAtSigning,
        o.cashIncentive,
        o.salePrice,
        o.confidence,
        o.complianceGrade,
        o.disclaimerText,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const csv = lines.join("\r\n");

  const slug = (snapshot.label || snapshot.id.slice(0, 8))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${slug || "snapshot"}.csv"`,
    },
  });
}
