import { OFFER_TYPE_LABELS, type ComplianceGrade, type Offer } from "@/lib/db";

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toLocaleString()}`;
}

function gradeStyle(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "pass") return "bg-green-100 text-green-800";
  if (g === "fail") return "bg-red-100 text-red-800";
  return "bg-amber-100 text-amber-800";
}

function confidenceStyle(confidence: number | null): string {
  if (confidence === null) return "text-zinc-400";
  if (confidence >= 0.6) return "text-green-700";
  if (confidence >= 0.4) return "text-amber-700";
  return "text-red-700";
}

/** Phase 9 analysis: trigger the passes and show the structured offers +
 *  compliance grades extracted from the run's evidence. */
export function AnalysisSection({
  offers,
  grades,
  siteNames,
  analyzing,
  runAnalysisAction,
  canAnalyze,
}: {
  offers: Offer[];
  grades: ComplianceGrade[];
  siteNames: Record<string, string>;
  analyzing: boolean;
  runAnalysisAction: () => Promise<void>;
  canAnalyze: boolean;
}) {
  const gradeByEvidence = new Map(grades.map((g) => [g.evidenceId, g.grade]));
  const gradeCounts = grades.reduce<Record<string, number>>((acc, g) => {
    acc[g.grade] = (acc[g.grade] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">
            Analysis{" "}
            {offers.length > 0 && (
              <span className="font-normal text-zinc-500">
                — {offers.length} offer{offers.length === 1 ? "" : "s"}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Rule-based classification, normalization, and compliance grading
            over this run&apos;s evidence. Re-runnable — re-analysis replaces
            these results.
          </p>
        </div>
        {canAnalyze && (
          <form action={runAnalysisAction}>
            <button
              type="submit"
              disabled={analyzing}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzing
                ? "Analyzing…"
                : offers.length > 0
                  ? "Re-run Analysis"
                  : "Run Analysis"}
            </button>
          </form>
        )}
      </div>

      {grades.length > 0 && (
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2 text-xs">
          <span className="text-zinc-500">Compliance:</span>
          {Object.entries(gradeCounts).map(([grade, count]) => (
            <span
              key={grade}
              className={`inline-flex rounded-full px-2 py-0.5 font-medium ${gradeStyle(grade)}`}
            >
              {count} {grade}
            </span>
          ))}
        </div>
      )}

      {offers.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">
          No offers extracted yet. Run analysis once the run has captured
          evidence.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2 font-medium">Site</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Vehicle</th>
                <th className="px-4 py-2 font-medium">Payment</th>
                <th className="px-4 py-2 font-medium">APR</th>
                <th className="px-4 py-2 font-medium">Term</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">Cash</th>
                <th className="px-4 py-2 font-medium">Conf.</th>
                <th className="px-4 py-2 font-medium">Compliance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {offers.map((offer) => {
                const grade = offer.sourceEvidenceId
                  ? gradeByEvidence.get(offer.sourceEvidenceId)
                  : undefined;
                const vehicle = [
                  offer.vehicleMake,
                  offer.vehicleModel,
                  offer.vehicleTrim,
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={offer.id}>
                    <td className="px-4 py-3 text-zinc-900">
                      {siteNames[offer.siteId] ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {OFFER_TYPE_LABELS[offer.offerType]}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {vehicle || "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {offer.monthlyPayment === null
                        ? "—"
                        : `${money(offer.monthlyPayment)}/mo`}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {offer.apr === null ? "—" : `${offer.apr}%`}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {offer.termMonths === null
                        ? "—"
                        : `${offer.termMonths} mo`}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {money(offer.dueAtSigning)}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {money(offer.cashIncentive)}
                    </td>
                    <td
                      className={`px-4 py-3 font-medium ${confidenceStyle(offer.confidence)}`}
                    >
                      {offer.confidence === null
                        ? "—"
                        : `${Math.round(offer.confidence * 100)}%`}
                      {(offer.normalizedJson as { aiAssisted?: boolean } | null)
                        ?.aiAssisted && (
                        <span
                          className="ml-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-700"
                          title="Corrected by the AI analysis pass (Phase 12)"
                        >
                          AI
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {grade ? (
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${gradeStyle(grade)}`}
                        >
                          {grade}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
