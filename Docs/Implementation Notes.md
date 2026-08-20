# Implementation Notes

_Last updated: August 4, 2026_

This is the compact map of how the system works. The open work list lives in
`Docs/Implementation Roadmap.md`.

## The Shape Of The System

Dealer Intel is a collect -> analyze -> report pipeline.

Collection creates raw evidence. Analysis reads evidence and creates structured
offers/compliance grades. Reporting reads published snapshots.

Captured disclaimer text is analyzed as one bounded promotion. Lease-payment
and APR alternatives are split inside that disclosure and each term is resolved
against its own anchor, preventing a finance term from leaking into a lease row.

The important boundary: analysis never scrapes, and core offer/compliance
reporting never reads live run data or visits dealer sites.

Reports may show latest inventory as an operational side section. That
inventory context does not create offers, compliance grades, or offer rankings.

## Collection

Collection is dealer/site-scoped.

A run selects:

- sites: all, group, or ad-hoc checkbox selection,
- missions: all active missions or selected missions.

The server seeds the run's whole scope, then hands the extension a job list
grouped by dealer. The extension works through it sequentially in the operator's
own Chrome, reusing one visible window per dealer, and uploads each labeled
capture state as it goes.

Run progress is persisted to `mission_results` and exposed through
`src/app/api/runs/[id]/status/route.ts`. The run page polls that narrow status
endpoint through `src/components/run-live-data.tsx`.

Each run records which collector produced it. Every run since 3.9.0 is
`chrome_extension`; the `current` value is retained only so pre-3.9.0 runs
still read correctly. The
extension is preflighted (present, enabled, new enough) before the run's state
is touched, so a missing extension leaves the run exactly as it was.
The server seeds the whole selected scope; the extension processes work
sequentially, reusing one visible Chrome window for all selected missions on a
dealer. Progress is database-backed. Because the collection loop lives in the
operator's browser, the server cannot observe it directly at all —
`collection_runs.chrome_heartbeat_at`, stamped on every result POST, is the only
signal it has. A heartbeat newer than `CHROME_HEARTBEAT_STALE_MS` means the run is
live, which is what the run page's status polling keys off; an older one means
the driving tab died. Reopening an interrupted run offers a Resume button rather
than resuming on mount, and re-queues only its unfinished items. A browser lock
prevents two Dealer Intel tabs from driving the same run.

Chrome protocol 4 is stateful. The extension prepares the visible page, expands
mission-selected accordions, captures a true full-page base image through the
Chrome DevTools protocol, then opens and captures selected tabs, carousel
slides, and ad disclaimers. Each state carries a stable id, kind, order, label,
resulting URL, rendered HTML, screenshot, and optional extracted disclaimer
text. The extension sends one state to the authenticated app page and waits for
its upload acknowledgement before changing the UI again. Stable capture keys
make interrupted uploads safe to retry. A partial interaction failure becomes
`needs_review` when any evidence was already stored.

The app currently requires extension 1.2.0 or newer. Collection windows open
maximized for deterministic desktop layouts. Primary-carousel discovery polls
for late widget injection, and traversal retries transient/no-op Next clicks so
an animation-time disabled control does not silently truncate the manifest.
Numbered carousels are selected by ordinal and paused through their page-level
widget API so a disclosure upload cannot let autoplay skip the next slide.

Carousel exploration is state-driven, not count-driven. The extension pauses
autoplay, reads the platform's active slide identity and any ordinal/total (for
example `slide 4 of 12`), captures that state, advances, and stops when the
identity repeats or the advertised final ordinal is reached. A safety ceiling
only prevents a broken widget from looping forever. Disclaimers are opened
while their exact slide remains active and are retained only when the opened
text contains price, APR, monthly-payment, or due-at-signing terms.

Inventory uses the same visible Chrome extension transport while preserving the
existing inventory result and reporting models. Platform behavior is isolated:
`extension/inventory.js` dispatches only to a registered adapter. Every dealer
platform in the database now has one — Dealer.com (`ddc`), Dealer Inspire
(`dealer_inspire`), DealerOn (`dealer_on`), Apollo/Team Velocity (`apollo`),
Dealer Alchemist (`dealer_alchemist`), Dealer Masters (`dealer_masters`), and
Sokal (`sokal`). Anything else still fails closed, and `extension/inventory.js`
sniffs the live page when `sites.platform` (free text) matches no adapter.

`src/lib/inventory-platforms.ts` is the app's single copy of that list. It gates
both the server refusing to seed a batch and the client disabling the run
button; those were two independent sets before and could disagree.

Adapters fall into two families, and which family a platform lands in is a
property of the platform, not a style choice:

- **Facet readers** (Dealer.com, Dealer Inspire, Dealer Alchemist) navigate to
  a filtered SRP URL per make and per status and read the rendered model facet.
- **Source readers** (DealerOn, Apollo, Dealer Masters) read the data the page
  itself is built from. Each row already carries its own make, so these do no
  per-make navigation at all and the whole dealer costs a couple of requests.

Source readers are preferred wherever a source exists, because they sidestep
both the model-facet trap below and incremental rendering. DealerOn in
particular renders one vehicle card on a page advertising 356.

That claim is about the results GRID, not about facets. DealerOn does publish a
usable model facet — a "Select Model" dialog listing each nameplate with an
"N available" count, and those counts reconcile exactly to the button's own
"View N Matches". It is not read, for two reasons, and neither is that it
cannot be:

- Cost. The vehicles API returns 96 cards per request, so a store costs
  `ceil(vehicles / 96)` same-origin JSON calls — one for Balise Nissan's 67,
  four for Paul Masse's 356. Reading the dialog instead costs a full page load
  per make plus a dialog render poll, which is more work, not less.
- Attribution. On a multi-brand store the dialog has to be read with one make
  already applied, and DealerOn is the one platform with no known filter-URL
  contract (see the filter list at the end of this section — it has no entry).
  Guessing one re-creates the whole-store-under-one-make bug the scope guard
  below exists to prevent, on dealers that are correct today.

If DealerOn's make-filter URL is ever established, revisit the first point;
until then the API is both cheaper and safer.

The source readers and what they read:

- DealerOn: `dealeron_tagging_data` on the SRP gives `dealerId`/`pageId`, then
  `/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/<dealerId>/<pageId>` with
  `baseFilter=dHlwZT0nbic=` (base64 `type='n'`) and `pn=96`. Each card carries
  make, model, and in-stock/in-transit flags.
- Apollo: the SRP embeds `selectedFilters`, `accountId`, and `campaignId` as
  page script variables; `/api/Inventory/getinventorymultiselectionfilters/v2`
  returns every model with its make attached. On-lot and in-transit are two
  calls because availability is a request flag, not a facet value.
- Dealer Masters: these are Gatsby sites that ship the whole inventory to the
  browser once and filter it client-side, so no filter URL round-trips.
  `/page-data/<route>/page-data.json` holds `allInventoryJson.nodes`, one node
  per vehicle. Statuses beginning `_` are vehicles the build marks as not for
  display; the store's own result count excludes them, so we do too.

Every fetch is issued from inside the dealer's own page, so it is same-origin
and carries whatever session the visible browser already established.

Two further platform traps are worth keeping in mind:

- Dealer Alchemist's model facet is hierarchical, and the same model can appear
  under more than one parent — "Corolla Cross" is both its own family and a
  child of "Corolla". Summing parents overstated a live Toyota store by 16
  against its advertised 270; the child rows deduped by name reconciled to 270
  exactly. Read children, never parents.
- Sokal sits behind DataDome. Visible Chrome is the right place for it: the
  window is on the operator's screen, so the adapter waits for an interstitial
  to clear rather than failing on sight, and tells the operator to clear it in
  that window if it does not.

`extension/inventory/tally.js` holds the counting all adapters share: fold rows
into make/model buckets, hold them against the dealer's configured make
allow-list (mapping the site's spelling onto the operator's — "RAM" becomes
"Ram"), and reconcile subtotals. It knows nothing about selectors, URLs, or
navigation. The Dealer.com and Dealer Inspire adapters predate it and still
build their own row merge and subtotals; they are verified against 52 live
dealers and that part was left alone. Their name rules (`canonicalModel`,
`plausibleModelName`) and the make-scope guard below now come from tally.js
rather than from local copies, because divergent copies were how a dealer
address became a model row.

`sites.brand` is the per-dealer make allow-list every adapter filters on, and
it is authoritative. When a live store disagrees with it, suspect `sites.url`
before the brand: a dealer that consolidates two franchise sites into one keeps
its record and changes its URL.

A configured make can still legitimately come back empty — a brand that is
simply sold out this week. What that means depends on how the store was read,
which is the line the tally's `enumerated` flag draws:

- Enumerated sources (DealerOn, Apollo, Dealer Masters) read the whole lot in
  one pass, so an absent make is confirmed absent. The make is dropped from the
  subtotals with no warning.
- Facet readers cannot tell "none in stock" from "the refinement silently
  failed", so they keep the zero subtotal row and warn.

That difference is not cosmetic. `scripts/compare-inventory-batches.mjs` treats
a make present on one side and absent on the other as a hard failure, with none
of the ±2 tolerance it allows model rows, so an enumerated adapter that
published a zero row would fail its own matched-batch check.

`missingMakes` is reported either way for diagnostics; only the warning and the
subtotal row differ.

**Hard rule: a model row is only ever stored against a make we actually
observed for it.** An unfiltered model facet yields a whole-dealership model
dump, which is wrong for any multi-brand store and silently corrupts reporting.

For facet readers that means reading models with exactly one make selected. On
Dealer.com the site enforces it too — the `model` facet group does not exist in
the DOM until a make is applied. Those adapters loop one make at a time, apply
it, and only then read models. Verified live on a CDJR store:
`?make=Chrysler&status=1-1` returns Pacifica 3 + Voyager 4 = 7, matching its
"7 Vehicles Matching" exactly.

Source readers satisfy the same rule without filtering, because every row they
read names its own make. Apollo's model rows carry a `make` field; DealerOn and
Dealer Masters enumerate vehicles. A row whose make is absent or unreadable is
dropped, never attributed to a default.

The rule is enforced by `inventoryTally.checkMakeScope`, which every
facet-walking adapter routes through. It exists because the adapters used to
answer "did the filter apply?" by re-reading the query param they had just
written into the URL themselves — a question that can only be answered yes. A
store that served unfiltered results while echoing the param back passed, and
the whole store's model facet was banked under whichever make was being
requested. Stored rows showed a Buick row holding Golf GTI and IONIQ 5, and
every CDJR make holding every other make's trucks.

The guard asks the page instead, and takes either kind of evidence:

- the make facet reports the target make as selected **in the markup** — never
  from the URL, which only repeats what we sent; or
- the model counts total no more than the store's own facet count for that
  make, since an unfiltered read totals the whole store.

Either alone proves the page narrowed; requiring both would fail honest stores,
because some themes never render the control as checked and some publish no
per-make counts. On a store whose make facet offers one make the guard stands
down — there the unfiltered read IS that make's read. A make that fails records
zero with a warning naming the numbers, rather than banking the store.

The make facet is only re-read when the counts already look wrong, so the happy
path pays nothing. Checked by `scripts/verify-inventory-make-scope.mjs`, which
also asserts that each facet-walking adapter still calls the guard.

Navigation and filtering are URL-driven, not click-driven.
`extension/inventory/navigate.js` resolves the SRP in tiers — page already
loaded, stored `sites.inventory_path`, platform default, then href-ranked link
discovery — and every failure records what each tier saw. Platform defaults are
`/new-inventory/index.htm` (Dealer.com), `/new-vehicles/` (Dealer Inspire,
Dealer Alchemist, Sokal), `/searchnew.aspx` (DealerOn), `/inventory/new`
(Apollo), and `/new-inventory/` (Dealer Masters).

Filters are applied by navigating: Dealer.com uses `?make=<Make>&status=1-1`
(on the lot) and `status=7-7` (in transit); Dealer Inspire uses LightningVRP's
`_dFR[...]` refinements; Dealer Alchemist uses `?make=<Make>&status=In Stock`
/ `In Transit`. These are public URL contracts the dealer's own site links to,
so they outlast the DOM churn that broke the previous menu/facet click paths.
Each adapter checks the store did not drop the param on load, and then holds
the counts to the make through `checkMakeScope` above; a make that fails is
recorded as zero with a warning rather than as unfiltered counts.

There is deliberately no DealerOn entry. Its filter-URL contract has never been
established, and it has never needed one — see the DealerOn note near the top
of this section for why guessing one would be worse than the API it reads
today.

Dealer Alchemist needs a different proof than the others. Its status checkbox
does not reliably render as checked after a cold load, but its status facet is
disjunctive — the counts ignore the status refinement itself — so the result
total landing exactly on the requested status's own count is what proves the
refinement applied, and proves the unfiltered set was not what got read.

Two DDC DOM traps the reader must keep handling: facet panels render collapsed
and populate `.panel-collapse` only on expand (so a container holding zero
controls is normal, not absent), and the inner `.panel-collapse` div carries an
id containing the facet name — facet containers must be matched by
`data-facet-group` before falling back to `id`, or the reader latches onto the
inner div, which has no expand control and always reads empty.

`extension/inventory/shared.js` is intentionally limited to popup suppression,
timeouts, cancellation, and guaranteed cleanup. It has no
navigation, selector, apply, or count-reading knowledge. Dealer
Inspire normalizes both visible status variants (`On Lot` or `In-Stock`, plus
`In-Transit`) without leaking either implementation into shared code. Each
make/status model sum must reconcile exactly to its subtotal, and an adapter's
visible total may differ from its model sum by at most two vehicles.
The Inventory toolbar exposes a shared Cancel Run control for Chrome and API
batches. Cancellation aborts the page driver, closes the visible collection
window, and persists queued/running rows as cancelled without replacing the
dealer's latest completed inventory snapshot.
The normal Chrome batch budgets 25 seconds of setup plus 25 seconds per
configured make, since URL-driven collection costs about two page loads per
make rather than a chain of click-and-settle waits. Anything that cannot finish
inside that make-scaled ceiling fails fast into a guided exception rerun. Every inventory
request closes its dealer window after success or failure, and the extension
uses the same make-scaled ceiling plus a five-second safety cleanup grace for a
lost app/bridge response. The active window id is also persisted in extension
storage so service-worker restart recovery closes it before another dealer opens.
After a dealer timeout, the app confirms that the extension session was reset
before opening the next dealer. A lost or invalidated extension message channel
stops the driver immediately, cancels unfinished rows, and releases the run
controls instead of cascading the transport error across the remaining sites.
Completed dealer results remain intact and unfinished dealers can be rerun
individually.
Menu links that open a new tab are adopted into the tracked collection tab and
the untracked child is closed before collection continues.
Visible Chrome is the only inventory collector. The sibling
`dealer-inventory-api` fallback, its `INVENTORY_API_*` configuration, and the
local auto-spawn helper were removed in 3.7.1 once every dealer platform passed
in Chrome; `scripts/compare-inventory-batches.mjs` only applies to batch pairs
collected before that.

The Playwright collector was retired in 3.9.0. Its in-process Chromium engine,
explorers, overlay handling, mission runner, and background run drainer are
deleted, along with the `playwright` dependency and its Chromium postinstall.
`collection_runs.collector_mode` survives so pre-3.9.0 runs still read as
`current`; every new run is `chrome_extension`.

Key files:

- `src/lib/chrome-collector.ts`
- `src/lib/collector/mission-knowledge.ts`
- `src/lib/collector/ad-images.ts`
- `src/lib/run-executor.ts` (run settling only)

## Missions

Missions are collection targets, not business goals.

They answer:

- where should we look on this dealer site?
- how should we explore that page?

The global mission row defines the mission type. The per-dealer
`site_missions` row stores learned/configured URLs.

Homepage offers and promotional banners can remain separate mission types
without double-fetching because the capture cache dedupes shared pages.

A mission with no memorized URL discovers one: nav links the dealer's own menu
offers, then the platform default paths. `mission-knowledge.ts` owns that logic
so every collector agrees on where a mission goes.

**Discovery happens in the extension's browser, never in the app.** The app
does not request dealer pages at all — it hands the extension the saved URLs,
the discovery rules (as regex sources), and the dealer's homepage, and the
extension does every load in the operator's real Chrome. This is not a
preference: measured Aug 8 2026, 16 of 62 active dealers answer a request from
the app with a Cloudflare 403 — Speedcraft, all five Tasca stores, all three
Nucar stores, Mastria, Grieco, Crowley, Executive, Ira Volvo, Kia of Old
Saybrook — while loading normally in a browser. Anti-bot blocking is the whole
reason collection moved to desktop Chrome, so anything reading a dealer site
from Node is blind on exactly the stores that need discovery most.

The extension tries the saved URLs in order, then walks the dealer's menu read
off the rendered DOM — which is what reaches submenu entries, the only handle
on pages the platform renames between months (Speedcraft's service coupons live
at `/providence-nissan-service-parts-coupons/`). Each candidate is verified
where it landed: not the homepage, not a 404, not an OEM program. If nothing
verifies, the mission fails and asks for a URL.

`PLATFORM_DEFAULT_PATHS` leads with Dealer.com's canonical
`/promotions/new/index.htm` and `/promotions/service/index.htm`. Measured
against the live list, 35 of 38 Dealer.com stores answer both with 200 — and
Dealer.com is more than half the dealers. Those two paths were missing, which is
what made the guess paths look like they "404 on nearly every site" and left
discovery leaning on nav crawling for stores that never needed it.

**A configured URL is the answer, and its failure is the result.** When the
dealer record lists URLs for a mission, discovery never runs — not before, and
not after they fail. If every listed URL fails, the mission fails and the
operator fixes the record. There used to be a rediscovery fallback that re-ran
discovery whenever a memorized URL captured nothing *or* showed no pricing, and
swapped in whatever it found; that silently replaced a specials page which was
merely empty with some other page that happened to have a price on it.

**Discovery never settles.** Every candidate has to be justified — a path the
platform publishes, or a link the dealer's own nav labels as specials — and if
none of them is really there the mission fails and asks for a URL. It does not fall back to the nearest page that looks like it
might carry an offer. That is why the bare `offers` / `incentives` /
`promotions` / `specials` guess paths were removed: they land on a nav hub or a
section index, and a mission that lands on one has not found the specials page,
it has found something shaped like it.

The corollary matters just as much: **an empty specials page is a correct
result.** Early in the month a dealer may have a "New Specials" section with
nothing in it. That is the right page and the honest answer, so selection is
deliberately *not* gated on `pageHasOfferSignal` — requiring visible pricing
would reject the real page and send the mission hunting for a substitute.

Five rules here are load-bearing, each of them a bug that reached production:

- **A 200 does not mean the page exists.** Most non-Dealer.com platforms answer
  an unknown path with 200 and a silent redirect to the homepage — verified with
  a deliberately nonsensical path on Toyota of Dartmouth. So discovery compares
  where it *landed* against where it asked to go and rejects a homepage landing,
  and both the extension's landing check and `probeUrl` read the final URL to
  make that possible. Without it the collector memorized `/promotions/service/index.htm`
  for stores whose served page was the front page — the original bug, rebuilt.
- **Manufacturer programs are banned outright.** Two families: the OEM's
  national incentive search (`/global-incentives-search/`), and OEM parts and
  service coupon programs — Mopar for Stellantis stores, ACDelco for GM. All are
  nationwide content identical across every store selling the brand, so a price
  read off one is not that dealer's offer. The ban is checked three ways,
  because each was needed: the nav label, the URL landed on after redirects, and
  the page's own `<title>`/`<h1>`. Anchor Nissan's nav calls the incentive
  search "Current Offers"; Elmwood CDJR serves "Coupons for Mopar Parts And
  Service" from a perfectly neutral `/coupons.htm`. Only title and h1 are read,
  never body copy — a dealer's genuine specials page may mention Mopar parts
  without being the Mopar program.

- **A dropdown group header is not a destination.** Dealer.com marks it
  `data-toggle="dropdown"` / `class="nav-with-children"` and points its href
  somewhere plausible but wrong: Gengras Subaru's "Finance & Specials" menu
  resolves to `/financing/index.htm`, the finance department, while the actual
  specials page sits in the submenu beneath it. Both link readers skip these.

- **Nav labels are matched as ordered word sequences, not substrings.** Dealers
  name the page after themselves — "New **Subaru** Specials", "New **Volvo**
  Special Offers" — so a literal `includes()` missed the correct page on nine
  dealers. Words may be separated by at most two of the dealer's own words, must
  appear in order, and match whole (so "renew specials" is not "new specials").
  Number is ignored on both sides.
- **Some links are excluded outright** (`DISCOVERY_EXCLUSIONS`). A military
  rebate page, a pre-owned feed, and a credit-application funnel are not the
  dealer's advertised specials even though a keyword reaches them. Broad
  keywords are only safe behind this list, which is why "incentives" is written
  as "current incentives".
- **A candidate that resolves back to the homepage is rejected**, and rejected
  while picking the per-keyword match rather than afterwards — Dealer.com emits
  the same label twice, an `href="#"` dropdown toggle followed by the real link
  nested under it, so filtering later dropped both. `isSameLocation` normalizes
  `www.`: dealers are configured at the apex and redirect to `www.`, so strict
  host comparison called the homepage a different page and waved it past every
  guard built on this function.

That last one is why the homepage kept winning. A non-homepage mission that
lands on the dealer's front page must never memorize it: memorized URLs beat
discovery, so one bad capture pins the mission there on every later run.
`scripts/clear-homepage-mission-memory.mjs` repairs rows already poisoned that
way; `scripts/verify-mission-url-discovery.ts` is the regression guard.

Ad graphics are downloaded the same way, inside the dealer's page, and ride up
with the capture state as bytes. `AD_IMAGE_RULES` travels with the job so the
extension applies the same thresholds and skip patterns the app would have.
Running in the page also means the **real decoded pixel size** decides what is
ad creative — `naturalWidth`/`naturalHeight`, not a guess from the filename or
a `w=` query param — and the bytes usually come from the browser cache with the
page's own cookies and referer. The app no longer fetches ad graphics at all
during collection; `extractAdImageUrls` survives only so analysis can match
stored graphics to the page they appeared on, plus the legacy live-fetch branch
for runs captured before ad-image capture shipped.

`pageHasOfferSignal` is deliberately absent from all of this. Besides rejecting
legitimately empty specials pages, it cannot do the job it was given:
it returns **false on every Dealer.com specials page**, because DDC renders
offers as JPEGs and the markup carries no price text (the same fact the analysis
OCR path exists for). On the majority platform it never fired at all, while on
the others it happily promoted whatever page had incidental pricing. It is still
removed with the Playwright collector in 3.9.0 — the extension decides whether
a memorized URL is still the mission's page by where the browser actually lands
(`missionPageVerdict`), which is the check that survived scrutiny.

Platform paths sit behind nav, not in front of it. Leading with them was tried
and reverted: it overrode 43 correct dealer-authored pages, including Westerly's
`/westerly-service-specials.htm` and Elmwood's `/mopar-service-coupons.htm`. A
link the dealer's own menu labels as specials is stronger evidence than any path
convention.

## Evidence

Evidence is the canonical raw record.

Stored evidence includes:

- full-page screenshots,
- HTML snapshots,
- failure screenshots,
- disclaimer screenshots,
- ad graphics (`ad_image`) — the offer-card images on image-rendered platforms,
- captured disclaimer text on `evidence.text_content`.

Stateful Chrome evidence also records `capture_key`, `capture_state_id`,
`capture_state`, `source_url`, and `capture_order`. The base state's HTML uses
`html_snapshot` and remains normal analysis input. Alternate-state HTML uses
`state_html_snapshot`: it is retained for audit and manifest comparison but is
deliberately excluded from offer extraction so one rotating ad is not parsed
again merely because its surrounding page was captured in several UI states.

Evidence files live in R2. Database rows store object keys and metadata.

Key files:

- `src/lib/evidence.ts`
- `src/components/evidence-section.tsx`
- `src/app/(admin)/runs/[id]/evidence/[siteId]/page.tsx`

## Analysis

Analysis is re-runnable and does not visit dealer sites.

The runner reads stored evidence, extracts offers, grades compliance, and writes
results back to analysis tables.
Each run keeps its own analysis rows. Re-analyzing one run replaces only that
run's offers and grades; it does not erase analysis from earlier runs that cover
the same dealers.

A running analysis can be stopped. The signal is cooperative — the three
evidence loops in `processAnalysis` check it between rows, so the stop lands
after the current page rather than mid-page. A stopped analysis deliberately
leaves `analysisCompletedAt` null, which is the same state Resume Analysis
already keys off, so stop/resume needs no separate bookkeeping: resume skips
sites that already have offers, and a full re-run clears the run's offers first.

Rule-based extraction handles the normal path. Claude is a secondary,
text-only pass for low-confidence corrections when `ANTHROPIC_API_KEY` is
configured. Dealer Inspire Scene7 image ads are parsed from their structured
image URL parameters before OCR, because those URLs carry the rendered lease,
finance, vehicle, and disclaimer terms. Other image-only pages (zero DOM-text
offers) are OCR'd with Mistral (`MISTRAL_API_KEY`) and run through the same
deterministic extractor as DOM text — Mistral reads the image, the app
classifies it. OCR text is stored in `ocr_artifacts` (one row per screenshot)
for audit/debug before deterministic extraction. `MISTRAL_API_KEY` is present
locally and the `ocr_artifacts` migration has been applied.

Ad graphics are captured, not re-fetched. On image-rendered platforms the whole
offer lives inside a JPEG, so the ad graphic is primary evidence and the
collector stores it (`evidence_type = 'ad_image'`, label `Ad graphic — <url>`)
alongside the page's HTML and screenshot — both collectors, via
`src/lib/collector/ad-images.ts`. Analysis reads those rows out of R2.
Previously the analysis runner downloaded ad images from the dealer's CDN at
analysis time, which broke its own contract ("no site visits") and made
re-analysis non-reproducible: re-running a three-week-old run pulled whatever
creative the dealer was serving that day, so the offers stopped describing the
captured date. Service-coupon graphics go through the same path. The coupon scanner reads
`data-image-url` (the unresized original) while capture reads `src` (the CDN's
resized variant), so stored graphics are matched on origin+path rather than the
full URL — matching the whole string missed every one and silently fell back to
fetching the dealer.

A run captured before this shipped has no `ad_image` rows and
falls back to the old live-fetch path, logged as `(legacy live fetch)`; the
switch is per run, not per mission, because an image is stored once per run and
a mission with none simply had its ads captured under a sibling mission.

The image pass skips map/tile hosts (`maps.googleapis.com` and friends). A
dealer's embedded "find us" map paints the page with 256x256 tiles that clear
the ad-size gate, so they were fetched and OCR'd like ad creative — always for
nothing, on the dealer's own Maps quota, with the dealer's API key (published in
their page markup) riding into our logs. Anything that still reaches a log line
or an evidence label/`source_url` goes through `redactUrl`, which strips
`key`/`token`/`signature` parameters. OCR results are cached per image URL for
the length of an analysis. Storing each graphic once per run (the capture key is
run+URL) already collapses the hero image that recurs across missions and every
captured tab/carousel state down to one row, and therefore one OCR call.

Each ad graphic the image pass reads is stored as its own evidence row
(evidence type `screenshot`, label `Ad graphic — <url>`), and the offers from it
point at that row. Offers used to point at the whole page's HTML snapshot, so
every image-extracted offer on a page shared one "View ad" link and — because
compliance grades are unique per evidence row — one shared grade, letting the
last offer graded overwrite every other offer's grade on that page.

The OCR model is pinned, not tracked to `mistral-ocr-latest`. Measured Aug 5
2026 against five Anchor Nissan hero ads with the prices read off the graphics
by eye: the ocr-4 line that "latest" resolves to read a "$389/MO" ad as
"$399/MO", while `mistral-ocr-3` read all five correctly. Images are also sent
to Mistral as-is unless they exceed the size cap; the q85 JPEG re-encode that
used to be unconditional dropped a whole "$2,999 Total Due at signing" line
from an ad that OCRs fine untouched.

Structured vehicle-special pages are analyzed card-first: fields are bounded to
the repeated DOM card before lease and APR alternatives are separated. A cash
offer means an explicitly advertised vehicle purchase price. Customer cash,
bonus cash, rebates, and discounts do not create cash rows and are not attached
to lease or finance rows.

Full-run analysis jobs are queued in-process and limited by
`ANALYSIS_CONCURRENCY` (default: 1) so auto-analysis after a large collection
does not run many OCR/compliance-heavy passes at once. The runner does not keep
raw screenshot buffers in a run-wide cache; it fetches screenshot bytes only for
the current page/ad operation.
The run page reconstructs its completed page/offer summary from persisted
evidence counts, offers, and analysis timestamps, so reopening a run does not
lose the final analysis summary when the in-memory progress counter is gone.

AdScore compliance is implemented through `AdScoreComplianceGrader` and is used
when all `ADGRADER_*` variables are configured. Otherwise the system falls back
to the deterministic stub grader.

### Offer confidence

`offers.confidence` answers one question: how much of this offer did the
deterministic extractor actually verify? It is not a probability that the offer
is real, and it is not a quality grade.

For a vehicle offer it is completeness times two penalties:

    (0.9 * completeness + 0.1 if a make was found) * provenance * missing-model

Completeness is measured against the fields that offer type can actually carry
(`EXPECTED_FIELDS` in `extract.ts`) — a lease is payment + term + due-at-signing,
a finance offer is APR + term, a cash offer is one advertised price. Measuring
instead against a fixed list of every field meant a type that structurally lacks
some of them could never score well: a fully-parsed 0%-APR finance ad landed at
0.60, exactly the publish floor, for want of a monthly payment it can never have.

`provenance` discounts weak sources (homepage tile 0.85, promo banner 0.8;
dedicated finance/specials pages 1.0) and `missing-model` (0.75) applies to a
priced offer whose vehicle the rules could not identify. Both are penalize-only,
so neither can inflate a thin extraction into a confident one.

Disclaimer presence is deliberately not scored. It is already stored
(`disclaimer_text`), already feeds mileage derivation, and is already judged by
the compliance grade; as a confidence bonus it mostly rewarded whatever text
landed in the disclaimer window, including mid-sentence OCR fragments.

Service confidence does not use completeness. A DOM-text coupon with a monetary
signal and a recognized service label is 0.8. An image coupon is scored by
whether its OCR read and its alt text agree: corroborated 0.85, `ocr_only` 0.60,
`mismatch` / `alt_only` 0.50.

The AI pass never writes this column. `applyEnrichment` in `runner.ts` takes the
model's corrected fields and drops its self-reported confidence into
`normalized_json.aiConfidence`, surfaced in the AI chip's tooltip. Letting it
overwrite the score put two incompatible scales in one column — two identical
Anchor Subaru lease ads read 68% and 90% purely because OCR turned the T in
ASCENT into `®`, which nulled the model, which routed that row alone to Claude.
The rule score now always describes what the rules could verify.

Service coupons still reach neither enricher condition, and that is intended:
the null-model condition is guarded off (a service offer's model is always null
by construction, so without the guard every coupon would hit the vehicle-shaped
enricher), and the lowest service score is 0.50 while the routing gate is
`< 0.5`. A `mismatch` coupon is adjudicated instead by its own service-shaped
verifier — `ClaudeCouponVerifier` (`ai-enrich.ts`), the sibling of the on-demand
`ClaudeOfferVerifier`. `serviceCouponOffers()` calls it at reconciliation time,
where both readings are still in hand, and shows it the OCR value, the alt
value, and the full text each came from. It answers one question — is the kept
OCR read the offer this coupon advertises — and never edits a field.
`applyCouponVerdict()` (`extract.ts`) then moves the confidence only: a confirm
takes the model's calibrated number (a lukewarm confirm still does not publish),
a drop is forced under the floor. The marker becomes `mismatch_confirmed` /
`mismatch_dropped`, which stops the run page's "check" flag and shows the
existing ✓/✕ verdict badge instead. With no `ANTHROPIC_API_KEY` the verifier is
a no-op and the coupon keeps its 0.50 and its manual flag. The on-demand
"Verify borderline" action skips rows already carrying those markers, so the
vehicle-shaped prompt cannot overturn a coupon-shaped judgment.

Key files:

- `src/lib/analysis/runner.ts`
- `src/lib/analysis/extract.ts`
- `src/lib/analysis/compliance.ts`
- `src/lib/analysis/ai-enrich.ts`
- `src/lib/analysis/ocr-mistral.ts`
- `src/components/analysis-section.tsx`

## Reporting

Publishing creates an immutable snapshot from the current run analysis.

Core report offer/compliance data reads only:

- `report_snapshots`,
- `snapshot_offers`,
- linked evidence files.

Re-running collection or analysis does not mutate an already-published
snapshot.

Report pages can also load latest inventory rows for the report's dealer group
and render them as an Inventory Snapshot section. Snapshot history is shown for
admin users when a run group has prior snapshots; true current-vs-prior report
deltas are still backlog.

The Brand News section reads `news_items` rows keyed by ISO week. The admin app
writes that key (`getISOWeekLabel`, `src/lib/cycle.ts`); the deployed viewer
reads it (`isoWeekLabel`, `viewer/src/lib/iso-week.ts`). Viewer is a separate
Vercel project and cannot import from `src/`, so the function exists twice on
purpose. `scripts/verify-iso-week.ts` fails if the two ever disagree — run it
after touching either one.

Key files:

- `src/lib/snapshot.ts`
- `src/app/(admin)/reports/` — management only: publish, share link, CSV export.
  It does not render report content.
- `viewer/` — the only report rendering path, deployed on Vercel. Both viewer
  routes (`/r/[token]` public, `/reports/[id]` signed-in) build their props
  through `getReportData()` in `viewer/src/lib/db/repository.ts`, so neither
  can drift into rendering a partial report.

## Operations

The weekly operator flow is:

1. Create or reuse a group-scoped run.
2. Start collection.
3. Review failures only.
4. Run analysis.
5. Load news and inventory if needed.
6. Publish snapshot.
7. Share report through the viewer.

The admin app needs a persistent Node process because background run execution
and analysis live in-process. Do not target serverless for the admin app.

The viewer app is separate and can run on Vercel because it only reads
published report data.

## Data And Config

Database schema changes go through Drizzle:

1. edit `src/lib/db/schema.ts`,
2. run `npm run db:generate`,
3. run `npm run db:migrate`.

Do not hand-write migrations.

Configuration convention:

- this workspace uses `.env` for local configuration,
- user-facing setup messages should refer to `.env`,
- `drizzle.config.ts` may load legacy files for compatibility, but `.env` is
  the active convention.

## Keep In Mind

- Collection should be broad and evidence-first.
- Business interpretation belongs in analysis/reporting, not collection.
- Reports should stay deterministic and snapshot-backed.
- A full ungrouped run is slow; group runs are the normal operating unit.
