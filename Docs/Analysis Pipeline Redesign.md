# Analysis Pipeline Redesign

_Created: August 13, 2026 · Design settled, not yet implemented._

Grew out of an architecture review (see the "Top recommendation" below) and a
grilling session that widened it into a full redesign of `src/lib/analysis/runner.ts`.
This doc is the working reference so implementation doesn't need to
re-derive the reasoning from chat history.

## Why

`runner.ts` (2060 lines) has two independent entry points that each reimplement
the same three-pass offer pipeline (DOM extraction -> disclaimer-modal
extraction -> image/OCR extraction):

- `processAnalysis()` — full-run entry, called by the job queue.
- `startAnalysisForSiteMission()` — single site+mission entry, called from a
  per-row "re-analyze" action and from the auto-analyze catch-up after a
  partial re-collect.

The duplication already caused a live bug: the module-level `offerSignature()`
(includes `vehicleTrim`) is only used by the image-pass helper
(`insertImageExtractedOffer`). The DOM pass and disclaimer pass — each
duplicated across both entry points, four inline copies total — all build
their own signature array that omits `vehicleTrim`. Two real offers that
differ only by trim (e.g. "Civic LX $199/mo" and "Civic EX $199/mo") collide
on the inline key and the second is silently dropped. This directly
undercounts the offer set a client is shown compared against their tracked
competitor set — the core product output, not a cosmetic bug.

## Product framing (do not lose this)

Dealer Intel is a **competitive intelligence platform** (`Executive Summary.md`,
`architecture-decision.md`), not a compliance tool. Compliance grading
(AdScore) is one column on an offer row, added later — not the product.
The product is: collect promotional offers (including competitors, via
`site_relationships`), capture evidence, normalize into structured offers,
keep historical snapshots, generate competitor comparison reports. Offer
correctness (dedup, extraction) matters because it feeds that comparison and
its history, not primarily because of compliance.

Mainline product UX is a single "Run" button per dealer group: collect, then
analyze, then (later) report — no operator hands-on. Every manual control
discussed below (pause/resume, per-row re-analyze, Verify borderline, manual
offer delete) is recovery/debug tooling that exists because the pipeline
isn't trustworthy enough to leave alone yet, not the intended primary
workflow. Fixing the pipeline is what should eventually shrink the need for
that tooling.

## Target shape

### 1. `runner.ts` becomes a pure job queue

No extraction logic. Owns: enqueueing scope units, `activeAnalyses` tracking,
progress counting, the pause signal. Nothing else.

### 2. One atomic pipeline function, scoped to one site+mission

Replaces both `processAnalysis()` and `startAnalysisForSiteMission()`. Given
`(runId, siteId, missionType)`:

1. Delete this scope's existing offers/compliance grades (its own evidence
   ids only — never the whole run).
2. Extract: DOM pass -> disclaimer pass -> image/OCR pass, same as today.
3. Dedup: one `offerSignature()` (must include `vehicleTrim`), checked
   against **persisted** offers for this site+run — a DB read, not an
   in-memory `Set` scoped to this one call. Required because atomic calls for
   different missions on the same site can run at different times (e.g. home
   page analyzed today, specials page re-analyzed tomorrow) and a duplicate
   offer appearing on both pages must still collapse to one row regardless of
   call order. An in-memory Set can't do that across separate calls; a DB
   check (or a unique constraint on a stored signature column with
   `ON CONFLICT DO NOTHING`) can.
4. Insert + grade, same as today.

**The job queue is the only thing that decides scope**, and every existing
caller becomes the same loop over this one function with a different scope
list:

- Full run: scope = every site+mission in the run.
- Manual per-row re-analyze: scope = one pair.
- Re-collect catch-up (`run-executor.ts`): scope = the freshly re-collected
  pairs.
- Resume after pause: scope = pairs with no offers yet since the pause.

No separate code paths. This was the core finding: a "run" was never
mission-locked, so "analyze one site+mission" was never a fundamentally
different operation from "analyze a run" — just a narrower scope handed to
the same pipeline. The two implementations existed only because
`startAnalysisForSiteMission` was bolted on later as a copy-paste instead of
generalizing the original function to take a scope parameter.

### 3. Platform-specific extraction moves out, one file per platform

Mirrors the existing, working pattern in `extension/inventory/adapters/`
(`dealer-com.js`, `dealer-inspire.js`, `dealer-alchemist.js`,
`dealer-masters.js`, `dealer-on.js`, `apollo.js`, `sokal.js`), dispatched off
`sites.platform`. Analysis never got this treatment — platform-specific logic
sits loose in `extract.ts` and `runner.ts` today.

New: `src/lib/analysis/platforms/<platform>.ts`, dispatched the same way.

### 4. Widget-specific extraction is a separate family, not platform-keyed

Some offer-rendering mechanisms aren't tied to one `sites.platform` value:

- **Dealer Teamwork / MPOP** (`stripDealerTeamworkDump`, `isPerVehicleListing`
  in `extract.ts` today) — a third-party specials widget that can ride on top
  of any CMS platform.
- **Scene7** (`extractDealerInspireScene7Offers` and helpers, `runner.ts:91-241`
  today) — Adobe's image-serving CDN, currently seen only on Dealer Inspire
  sites, but the concept ("offer rendered as an image with terms encoded in
  the URL") isn't inherently platform-bound. Detected by URL/markup pattern,
  not by looking up `sites.platform`.

New: a `widgets/` family alongside `platforms/`, detected by markup/URL
pattern rather than dispatched off `sites.platform`.

### 5. Stop -> Pause rename, both collection and analysis

Terminology fix, not a new state machine. "Pause" pairs sensibly with
"Resume" — suspend in place, run stays around, come back to it later. Delete
Run remains the separate, already-existing "I want this gone" action.

- Analysis already has this behavior today (`Stop Analysis` /
  `Resume Analysis`); it just needs the label fixed and the pause point moved
  (see below).
- **Collection has no pause mechanism at all today** — grepped
  `chrome-collector-control.tsx`, confirmed no stop/pause control exists. A
  runaway collection can't be interrupted short of killing the process. New
  feature, same terminology, follow-up work (not part of the runner.ts
  refactor itself).

**Pause granularity**: between atomic site+mission units, not mid-page.
Today's cooperative stop checks between evidence rows *inside* the pipeline
loop; under the atomic-per-scope-unit model the natural pause point is
between queue-dispatched units. A single site+mission's evidence set is small,
so the wait is short. Confirmed acceptable — simplifies the pipeline function
to have zero pause-awareness; pausing is purely "the queue stops handing out
new units."

While a pause is taking effect (current unit still running), the status
message should say something like **"Pausing — waiting for mission to
finish"** rather than a bare "Stopping…", so it's clear the pause hasn't
landed yet.

### 6. `analysisCompletedAt` stays a pure top-level timer

Measures one thing only: how long a genuine full-run analysis pass took, for
the operator's own walk-away-mode visibility (paired with collection's own
`started_at`/`completed_at`). Never touched by single-mission re-analyze,
re-collect catch-up, or resume-after-pause. No schema change needed — the
field already exists and today's code already only sets it from the full-run
path; this just needs to stay true under the new shape.

## Explicitly decided, no special-casing needed

- **Manual offer delete** (`deleteOffer`, a review-time action distinct from
  the pipeline's own delete-before-insert) has no interaction with
  re-analysis. If the evidence gets re-analyzed later, the deleted offer can
  legitimately reappear — confirmed, no "dismissed" flag or sticky-delete
  logic needed.
- **Re-analysis correctness intentionally changes past output.** Routing all
  three passes through one `offerSignature()` means re-analyzing an old run
  can surface offers that were previously silently deduped away by the buggy
  inline signatures. This is correct behavior, not a regression — `offers`
  are explicitly re-runnable/replaceable, and published `report_snapshots`
  are immutable regardless.

## Done when

- [ ] `runner.ts` contains only job-queue logic (enqueue, `activeAnalyses`,
      progress, pause signal) — no extraction code.
- [ ] One atomic pipeline function replaces `processAnalysis()` and
      `startAnalysisForSiteMission()`.
- [ ] `offerSignature()` is called from exactly one place in the extraction
      path (DOM, disclaimer, and image passes all route through it), always
      including `vehicleTrim`.
- [ ] Dedup checks persisted offers for the site+run, not an in-memory Set
      scoped to one call.
- [ ] `extractDealerInspireScene7Offers` and helpers move out of `runner.ts`
      into the new `widgets/` family.
- [ ] `stripDealerTeamworkDump` / `isPerVehicleListing` move out of
      `extract.ts` into the same `widgets/` family.
- [ ] Full run, per-row re-analyze, re-collect catch-up, and resume-after-pause
      all call the same atomic function with different scope lists.
- [ ] "Stop Analysis" relabeled "Pause Analysis"; status string during the
      wait reads "Pausing — waiting for mission to finish" or similar.
- [ ] Collection gets an equivalent Pause/Resume control (separate follow-up
      item, not blocking this refactor).
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm run build` pass.
- [ ] Verified against a real run in the running app: full analysis, one
      manual per-row re-analyze, and a pause/resume cycle all produce correct,
      non-duplicated offers.

## Other architecture-review candidates (not started)

From the same review, ranked but not yet designed in detail:

- **B — shared report module.** `src/components/report/ReportContent.tsx`
  is copy-pasted into `viewer/`, already behaviorally drifted (different Cash
  ranking, evidence-access scoping, missing-field handling). Per this session:
  viewer is the intended source of truth for presentation (it's what
  customers actually read); the admin app's local view should consume the
  same shared module as a convenience render, not fork it. Two sets of
  presentation code is a named violation of the collect / analyze / present
  three-program shape (see below).
- **C — shared async job-polling module.** `run-live-data.tsx` and
  `inventory-table.tsx` each reinvent the same "seed snapshot, poll, merge by
  key" state machine inline, untestable without mounting the component.
- **D — make `repository.ts` the actual data-access seam.** Mixes real
  pass-through wrappers with genuinely deep functions, and `runner.ts` /
  `actions.ts` bypass it and call `getDb()` directly anyway.

## The three-program shape (confirmed this session)

Collect, analyze, and present are meant to be three genuinely independent
programs, communicating only through Postgres + R2:

- **Collection** knows nothing about analysis. Confirmed clean by grep — zero
  imports of `@/lib/analysis` anywhere under `src/lib/collector/`.
- **Analysis** should know nothing about collection — only reads the
  database. Currently **violated once**: `runner.ts:22` imports
  `extractAdImageUrls`, `isAdSizedImage`, `MAX_AD_IMAGES`, `redactUrl` from
  `@/lib/collector/ad-images`, used to (a) re-derive which stored `ad_image`
  rows belong to a page, and (b) the legacy live-fetch fallback for
  pre-3.9.0 runs (which also separately breaks "analysis never visits dealer
  sites"). Worth fixing when touching this area — likely means collection
  should tag the page/image association at store time instead of analysis
  re-deriving it.
- **Presentation** (the viewer) reads the database directly, same as
  analysis — that's fine. What's not fine is having two independent copies of
  the rendering code (see candidate B).
