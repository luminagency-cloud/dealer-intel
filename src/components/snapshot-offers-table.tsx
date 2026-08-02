import {
  MISSION_TYPE_LABELS,
  OFFER_TYPE_LABELS,
  type SnapshotOffer,
} from "@/lib/db";
import { ComplianceGradeBadge } from "@/components/compliance-grade-badge";
import { fmtMileage } from "@/lib/report";

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toLocaleString()}`;
}

function confidenceStyle(confidence: number | null): string {
  if (confidence === null) return "text-zinc-700";
  if (confidence >= 0.6) return "text-green-700";
  if (confidence >= 0.4) return "text-amber-700";
  return "text-red-700";
}

/** Renders a snapshot's FROZEN offers (Phase 10). Pure read of the
 *  `snapshot_offers` copy — no live analysis tables, no computation. */
export function SnapshotOffersTable({ offers }: { offers: SnapshotOffer[] }) {
  if (offers.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-zinc-700 dark:text-zinc-200">
        This snapshot contains no offers.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
            <th className="px-4 py-2 font-medium">Site</th>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Vehicle</th>
            <th className="px-4 py-2 font-medium">Payment</th>
            <th className="px-4 py-2 font-medium">APR</th>
            <th className="px-4 py-2 font-medium">Term</th>
            <th className="px-4 py-2 font-medium">Due</th>
            <th className="px-4 py-2 font-medium">Mi/Yr</th>
            <th className="px-4 py-2 font-medium">Purchase Price</th>
            <th className="px-4 py-2 font-medium">Conf.</th>
            <th className="px-4 py-2 font-medium">Compliance</th>
            <th className="px-4 py-2 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {offers.map((offer) => {
            const vehicle = [
              offer.vehicleMake,
              offer.vehicleModel,
              offer.vehicleTrim,
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <tr key={offer.id}>
                <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                  {offer.siteName}
                  {offer.siteBrand && (
                    <span className="block text-xs text-zinc-700 dark:text-zinc-200">
                      {offer.siteBrand}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-200">
                  {MISSION_TYPE_LABELS[offer.missionType]}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {OFFER_TYPE_LABELS[offer.offerType]}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{vehicle || "—"}</td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {offer.monthlyPayment === null
                    ? "—"
                    : `${money(offer.monthlyPayment)}/mo`}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {offer.apr === null ? "—" : `${offer.apr}%`}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {offer.termMonths === null ? "—" : `${offer.termMonths} mo`}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {money(offer.dueAtSigning)}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {offer.mileageAllowance === null
                    ? "—"
                    : fmtMileage(offer.mileageAllowance)}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {money(offer.salePrice)}
                </td>
                <td
                  className={`px-4 py-3 font-medium ${confidenceStyle(offer.confidence)}`}
                >
                  {offer.confidence === null
                    ? "—"
                    : `${Math.round(offer.confidence * 100)}%`}
                </td>
                <td className="px-4 py-3">
                  {offer.complianceGrade ? (
                    <ComplianceGradeBadge
                      grade={offer.complianceGrade}
                      details={offer.complianceDetailsJson}
                    />
                  ) : (
                    <span className="text-xs text-zinc-700">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {(offer.evidenceUrl ?? offer.sourceEvidenceId) ? (
                    <a
                      href={offer.evidenceUrl ?? `/api/evidence/${offer.sourceEvidenceId}/file`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-600 hover:underline"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-xs text-zinc-700">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
