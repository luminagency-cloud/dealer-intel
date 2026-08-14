import type { MissionType } from "@/lib/db";
import { parseMileage } from "@/lib/report";
import { findKnownModel, type ExtractedOffer } from "../extract";

/** Adobe's image-serving CDN. Offer terms are encoded in the image URL's query
 *  params rather than in page DOM — currently seen only on Dealer Inspire sites,
 *  but the concept ("offer rendered as an image with terms in the URL") isn't
 *  inherently platform-bound, so this is detected by URL pattern rather than by
 *  looking up `sites.platform`. */

function cleanParam(value: string | null): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned || null;
}

function scene7Param(params: URLSearchParams, name: string): string | null {
  return cleanParam(params.get(`$${name}`) ?? params.get(name));
}

function parseMoneyParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercentParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function vehicleModelFromScene7(params: URLSearchParams): string | null {
  const model = scene7Param(params, "model");
  if (model) return model;
  const vehicle = scene7Param(params, "VEHICLE")?.replace(/_/g, " ");
  return vehicle ? findKnownModel(vehicle) : null;
}

function vehicleMakeFromScene7(params: URLSearchParams, brand: string | null): string | null {
  return scene7Param(params, "make") ?? brand?.split(/[,/]/)[0].trim() ?? null;
}

function vehicleLabelFromScene7(params: URLSearchParams, brand: string | null): string {
  return [
    scene7Param(params, "year"),
    vehicleMakeFromScene7(params, brand),
    vehicleModelFromScene7(params),
    scene7Param(params, "trim"),
  ].filter(Boolean).join(" ");
}

export function extractDealerInspireScene7Offers(
  imageUrl: string,
  hints: { missionType: MissionType; brand: string | null }
): ExtractedOffer[] {
  if (!/scene7\.com\/is\/image\/streamcompanies\//i.test(imageUrl)) return [];

  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return [];
  }

  const params = url.searchParams;
  const model = vehicleModelFromScene7(params);
  const make = vehicleMakeFromScene7(params, hints.brand);
  const trim = scene7Param(params, "trim");
  const label = vehicleLabelFromScene7(params, hints.brand);
  const disclaimer = scene7Param(params, "DISCLAIMER")?.slice(0, 1000) ?? null;
  const mileage = parseMileage(disclaimer);

  const leasePayment =
    parseMoneyParam(scene7Param(params, "payment_per_month_leaseinfo")) ??
    parseMoneyParam(scene7Param(params, "payment_per_month"));
  const leaseTerm =
    parseIntegerParam(scene7Param(params, "monthly_terms_leaseinfo")) ??
    parseIntegerParam(scene7Param(params, "monthly_terms"));
  const dueAtSigning =
    parseMoneyParam(scene7Param(params, "down_payment")) ??
    parseMoneyParam(disclaimer?.match(/\$\s?[\d,]+(?:\.\d{2})?\s+due at signing/i)?.[0] ?? null);

  const apr = parsePercentParam(scene7Param(params, "apr_aproffer"));
  const financeTerm = parseIntegerParam(scene7Param(params, "monthly_terms_aproffer"));

  const common = {
    vehicleMake: make,
    vehicleModel: model,
    vehicleTrim: trim,
    cashIncentive: null,
    salePrice: null,
    disclaimerText: disclaimer,
  };

  const out: ExtractedOffer[] = [];
  if (leasePayment !== null) {
    out.push({
      ...common,
      offerType: "lease",
      monthlyPayment: leasePayment,
      apr: null,
      termMonths: leaseTerm,
      dueAtSigning,
      mileageAllowance: mileage,
      rawText: `${label || "Vehicle"} lease: $${leasePayment}/mo${leaseTerm ? ` for ${leaseTerm} months` : ""}${dueAtSigning ? ` with $${dueAtSigning} due at signing` : ""}.`,
      confidence: 0.95,
      matches: {
        monthlyPayment: `$${leasePayment}/mo`,
        ...(leaseTerm ? { termMonths: `${leaseTerm} months` } : {}),
        ...(dueAtSigning ? { dueAtSigning: `$${dueAtSigning} due at signing` } : {}),
        ...(mileage ? { mileageAllowance: `${mileage} miles/year` } : {}),
        source: "dealer_inspire_scene7",
      },
    });
  }

  if (apr !== null) {
    out.push({
      ...common,
      offerType: "finance",
      monthlyPayment: null,
      apr,
      termMonths: financeTerm,
      dueAtSigning: null,
      mileageAllowance: null,
      rawText: `${label || "Vehicle"} finance: ${apr}% APR${financeTerm ? ` for ${financeTerm} months` : ""}.`,
      confidence: 0.95,
      matches: {
        apr: `${apr}% APR`,
        ...(financeTerm ? { termMonths: `${financeTerm} months` } : {}),
        source: "dealer_inspire_scene7",
      },
    });
  }

  return out;
}
