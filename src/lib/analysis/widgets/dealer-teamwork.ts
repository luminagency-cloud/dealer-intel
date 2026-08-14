/** Given the index just AFTER a `<div …>` open tag, returns the index just
 *  after its matching `</div>`, tracking nested divs. Returns -1 when the close
 *  can't be found (malformed/truncated HTML) so the caller leaves the node in
 *  place rather than deleting to end-of-document. */
function matchingDivEnd(html: string, from: number): number {
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].slice(-2) === "/>") continue; // self-closing
    if (m[1] === "/") {
      if (--depth === 0) return m.index + m[0].length;
    } else {
      depth++;
    }
  }
  return -1;
}

/**
 * Strips a Dealer Teamwork (MPOP) inventory dump out of raw HTML before ANY
 * text extraction. Dealer Teamwork's MPOP widget embeds on dealer sites (DDC
 * and others) and renders the dealer's ENTIRE new-car inventory as per-VIN
 * "New Car Special" cards — each a `.ncs-container` carrying a `data-vin` and a
 * `$X/mo` estimate. On a specials page that is 20–80+ cards; left in place, the
 * offer windower explodes every one into a separate junk "offer" (Colonial
 * Subaru produced ~80). These are auto-generated payment estimates, not
 * advertised specials, so none should ever become an offer row.
 *
 * Keyed on the vendor product markup (`ncs-container` + `data-vin`), which is
 * identical across every Dealer Teamwork client regardless of brand or CMS —
 * verified on both a DDC Subaru site and a non-DDC Honda site. Deliberately NOT
 * keyed on any dealer- or platform-specific token (account slug, `ddc-site`,
 * brand), so it generalizes rather than special-casing one dealer.
 *
 * Only the dump cards are removed; genuine curated offers elsewhere on the page,
 * and DT-free pages (a homepage with no `.ncs-container[data-vin]` cards), are
 * untouched.
 */
export function stripDealerTeamworkDump(html: string): string {
  // Fast path: the MPOP "New Car Special" card class isn't present at all.
  if (!/\bncs-container\b/i.test(html)) return html;

  // Opening <div> whose class list includes `ncs-container`. Quote style and
  // class ordering vary, so match either quote and any surrounding tokens.
  const openRe =
    /<div\b[^>]*\bclass\s*=\s*("|')[^"'>]*\bncs-container\b[^"'>]*\1[^>]*>/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    // The per-VIN `data-vin` on the card element is the inventory-dump tell —
    // it's what turns one card into one "$X/mo" offer. Requiring it (not the
    // class alone) keeps the strip surgical.
    if (!/\bdata-vin\s*=/i.test(m[0])) continue;
    if (m.index < cursor) continue; // inside an already-removed card
    const end = matchingDivEnd(html, openRe.lastIndex);
    if (end < 0) continue; // unbalanced — leave this card rather than over-cut
    out += html.slice(cursor, m.index);
    cursor = end;
    openRe.lastIndex = end;
  }
  out += html.slice(cursor);
  return out;
}

/**
 * True when an offer scope is priced against ONE specific unit in stock — the
 * card prints a VIN or a stock number alongside the payment.
 *
 * Inventory-driven platforms attach a lease/finance figure to every car on the
 * lot and render the result as a specials page. Toyota of Dartmouth's
 * `/specials/` is the measured case: every offer box on it carries
 * "VIN: 4T1DBADKXTU32C915 / Stock No: TU32C915", so the page is the dealer's
 * new-car inventory wearing an offers label, and the run stored 12 rows that
 * are really 12 cars. A price tied to one VIN is not the dealer's advertised
 * offer — the unit sells and it is gone — so none of these become offer rows.
 *
 * Complements `stripDealerTeamworkDump`, which removes one vendor's markup by
 * class name. This reads the text the card prints, so it holds on any platform,
 * and it is what the AI verifier was already told to reject (per-VIN inventory
 * auto-estimates) — now refused before an AI call is spent on it.
 *
 * Applied only to BOUNDED scopes (one DOM card, one anchor window, one
 * disclosure, one OCR read). Never to whole-page text: a homepage carrying one
 * genuine hero offer plus a featured-vehicle widget would otherwise lose the
 * hero offer to a VIN printed a thousand characters away.
 */
export function isPerVehicleListing(text: string): boolean {
  return /\b(?:vin|stock)\s*(?:no\.?|number)?\s*[:#]\s*[a-z0-9]/i.test(text);
}
