"use client";

import { useEffect, useRef, useState } from "react";
import type { MissionResult, ReportSnapshot, Offer, ComplianceGrade, Site } from "@/lib/db";
import { fmtDateTime } from "@/lib/fmt-date";
import { usePolling } from "@/hooks/use-polling";
import { MissionRunPanel, type PanelWorkItem } from "@/components/mission-run-panel";
import { RunWorkflowStrip } from "@/components/run-workflow-strip";
import { AnalysisSection } from "@/components/analysis-section";
import { RunOfferBreakdown } from "@/components/run-offer-breakdown";

interface LiveStatus {
  executing: boolean;
  analyzing: boolean;
  /** Pause requested — the loop finishes its current site+mission and exits. */
  analysisStopping: boolean;
  progress: { processed: number; total: number } | null;
  partialAnalysisKeys: string[];
  results: Pick<
    MissionResult,
    "id" | "siteId" | "missionId" | "status" | "pagesCaptured" | "successfulUrl" | "error"
  >[];
  offers: Offer[];
  grades: ComplianceGrade[];
  collectionStartedAt?: Date | null;
  collectionCompletedAt?: Date | null;
  analysisStartedAt?: Date | null;
  analysisCompletedAt?: Date | null;
}

/** Shape of `/api/runs/[id]/status`'s JSON — dates still strings, rehydrated
 *  in `onData` below. */
type RunStatusPayload = Omit<
  LiveStatus,
  "collectionStartedAt" | "collectionCompletedAt" | "analysisStartedAt" | "analysisCompletedAt"
> & {
  collectionStartedAt?: string | null;
  collectionCompletedAt?: string | null;
  analysisStartedAt?: string | null;
  analysisCompletedAt?: string | null;
};

export function RunLiveData({
  runId,
  initialExecuting,
  initialAnalyzing,
  initialProgress,
  initialPartialAnalysisKeys,
  items,
  initialResults,
  snapshots,
  offers,
  grades,
  siteNames,
  siteOptions,
  siteMeta,
  publishableConfidenceFloor,
  canCollect,
  canAnalyze,
  canPublish,
  analysisStartedAt,
  analysisCompletedAt,
  evidencePageCount,
  reAnalyzeSiteMissionAction,
  runAnalysisAction,
  resumeAnalysisAction,
  stopAnalysisAction,
  passOfferAction,
  deleteOfferAction,
  verifyBorderlineAction,
  lowConfidenceThreshold,
  notice,
  publishSnapshotAction,
  defaultSnapshotLabel,
  collectionStartedAt,
  collectionCompletedAt,
  // Static metadata bar content — pre-formatted by the server page
  runIdShort,
  createdLabel,
  error,
  needsChromeRecovery,
  isPaused,
}: {
  runId: string;
  initialExecuting: boolean;
  initialAnalyzing: boolean;
  initialProgress: { processed: number; total: number } | null;
  initialPartialAnalysisKeys: string[];
  items: PanelWorkItem[];
  initialResults: MissionResult[];
  snapshots: ReportSnapshot[];
  offers: Offer[];
  grades: ComplianceGrade[];
  siteNames: Record<string, string>;
  siteOptions: Pick<Site, "id" | "name">[];
  siteMeta: Record<string, { name: string; platform: string | null }>;
  publishableConfidenceFloor: number;
  canCollect: boolean;
  canAnalyze: boolean;
  canPublish: boolean;
  analysisStartedAt?: Date | null;
  analysisCompletedAt?: Date | null;
  evidencePageCount: number;
  reAnalyzeSiteMissionAction?: (siteId: string, missionType: string) => Promise<void>;
  runAnalysisAction: () => Promise<void>;
  resumeAnalysisAction?: () => Promise<void>;
  stopAnalysisAction?: () => Promise<void>;
  passOfferAction: (offerId: string) => Promise<void>;
  deleteOfferAction: (offerId: string) => Promise<void>;
  verifyBorderlineAction?: () => Promise<void>;
  lowConfidenceThreshold: number;
  notice?: string;
  publishSnapshotAction: (formData: FormData) => Promise<void>;
  defaultSnapshotLabel?: string;
  collectionStartedAt?: Date | null;
  collectionCompletedAt?: Date | null;
  runIdShort: string;
  createdLabel: string;
  error?: string;
  needsChromeRecovery: boolean;
  isPaused: boolean;
}) {
  const [live, setLive] = useState<LiveStatus>({
    executing: initialExecuting,
    analyzing: initialAnalyzing,
    analysisStopping: false,
    progress: initialProgress,
    partialAnalysisKeys: initialPartialAnalysisKeys,
    results: initialResults,
    offers,
    grades,
    collectionStartedAt,
    collectionCompletedAt,
    analysisStartedAt,
    analysisCompletedAt,
  });

  const active = live.executing || live.analyzing || live.partialAnalysisKeys.length > 0;

  // Poll fast while something is in flight, slowly the rest of the time — never
  // not at all. `active` is derived from polled state, so gating the poll on it
  // was a one-way latch: the moment it went false the only thing that could
  // ever turn it back on was the poll it had just switched off, and the page
  // stayed frozen until a manual reload.
  //
  // Every run hits that. `executing` is an extension heartbeat that stops the
  // instant collection ends, so the page went idle exactly at the collection ->
  // analysis handoff and never saw the offers arrive. Opening a finished run, or
  // a stale heartbeat mid-collection, wedged it the same way — even Run Analysis
  // couldn't wake it, since `analyzing` is only read from props at mount.
  //
  // A hidden tab polls nothing at all — see usePolling's visibility gate. That
  // is safe against the latch described above precisely because
  // `visibilitychange` is a browser event rather than polled state: it always
  // fires on return, so nothing the poll itself reports can keep it switched off.
  //
  // ponytail: flat 15s idle poll, no backoff. Each tick is 4 Neon HTTP queries,
  // so a visible-but-idle tab keeps the endpoint awake indefinitely. Add
  // backoff only if that ever costs real money — the visibility gate already
  // covers the common case (a tab left open and forgotten).
  const pollMs = active ? 3000 : 15000;

  usePolling<RunStatusPayload>(`/api/runs/${runId}/status`, {
    enabled: true,
    intervalMs: pollMs,
    visibilityGated: true,
    onData: (data) => {
      // JSON dates arrive as strings; rehydrate the ones rendered as dates.
      setLive({
        ...data,
        collectionStartedAt: data.collectionStartedAt ? new Date(data.collectionStartedAt) : null,
        collectionCompletedAt: data.collectionCompletedAt ? new Date(data.collectionCompletedAt) : null,
        analysisStartedAt: data.analysisStartedAt ? new Date(data.analysisStartedAt) : null,
        analysisCompletedAt: data.analysisCompletedAt ? new Date(data.analysisCompletedAt) : null,
      });
    },
  });

  // Sync freshly server-rendered data (offers/grades/analysis timestamps) into
  // live state when the props actually change post-mount — i.e. a server-action
  // revalidate (e.g. a single-site re-analysis). Guarded by identity so a poll
  // updating `live` (props unchanged) can't get clobbered by stale mount props,
  // and so the final poll result survives after polling stops.
  const offersRef = useRef(offers);
  useEffect(() => {
    if (offers === offersRef.current) return;
    offersRef.current = offers;
    setLive((l) => ({ ...l, offers, grades, analysisStartedAt, analysisCompletedAt }));
  }, [offers, grades, analysisStartedAt, analysisCompletedAt]);

  // Overlay live status/pagesCaptured/successfulUrl/error onto the full
  // MissionResult objects. Keyed on (site, mission) rather than id and
  // driven off the union of both sources: a background-started run (e.g.
  // AUTO_START_RUN, which redirects before its result rows are seeded) can
  // create rows that didn't exist yet in this page's initial SSR snapshot.
  // Merging by walking only `initialResults` silently dropped those rows on
  // every poll forever, so the page looked frozen even though polling was
  // working.
  const initialByKey = new Map(
    initialResults.map((r) => [`${r.siteId}:${r.missionId}`, r])
  );
  const liveByKey = new Map(
    live.results.map((r) => [`${r.siteId}:${r.missionId}`, r])
  );
  const missionById = new Map(items.map((i) => [i.mission.id, i.mission]));
  const mergedResults = new Map<string, MissionResult>();
  for (const key of new Set([...initialByKey.keys(), ...liveByKey.keys()])) {
    const base = initialByKey.get(key);
    const up = liveByKey.get(key);
    if (base) {
      mergedResults.set(
        key,
        up
          ? {
              ...base,
              status: up.status,
              pagesCaptured: up.pagesCaptured,
              successfulUrl: up.successfulUrl,
              error: up.error,
            }
          : base
      );
    } else if (up) {
      const mission = missionById.get(up.missionId);
      if (!mission) continue;
      mergedResults.set(key, {
        id: up.id,
        collectionRunId: runId,
        missionId: up.missionId,
        siteId: up.siteId,
        missionType: mission.missionType,
        status: up.status,
        pagesCaptured: up.pagesCaptured,
        successfulUrl: up.successfulUrl,
        error: up.error,
        startedAt: null,
        completedAt: null,
        createdAt: new Date(),
      });
    }
  }
  const mergedArray = [...mergedResults.values()];

  return (
    <>
      {/* Sticky workflow strip */}
      <RunWorkflowStrip
        runResults={mergedArray}
        totalWorkItems={items.length}
        offerCount={live.offers.length}
        snapshots={snapshots}
        executing={live.executing}
        analyzing={live.analyzing}
        canAnalyze={canAnalyze}
        canPublish={canPublish}
        runAnalysisAction={runAnalysisAction}
        publishSnapshotAction={publishSnapshotAction}
        defaultSnapshotLabel={defaultSnapshotLabel}
      />

      {/* Metadata bar with live updates */}
      <div className="mb-6 flex items-center gap-4 border-b border-zinc-100 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
        <span className="font-mono">{runIdShort}</span>
        <span>Created {createdLabel}</span>
        {live.collectionStartedAt && <span>Started {fmtDateTime(live.collectionStartedAt)}</span>}
        {live.collectionCompletedAt && <span>Completed {fmtDateTime(live.collectionCompletedAt)}</span>}
      </div>

      <div id="collection" className="mb-8">
        <MissionRunPanel
          runId={runId}
          items={items}
          results={mergedResults}
          executing={live.executing}
          canCollect={canCollect}
          collectionStartedAt={collectionStartedAt}
          collectionCompletedAt={collectionCompletedAt}
          reAnalyzeSiteMissionAction={reAnalyzeSiteMissionAction}
          partialAnalysisKeys={new Set(live.partialAnalysisKeys)}
          error={error}
          needsChromeRecovery={needsChromeRecovery}
          isPaused={isPaused}
        />
      </div>

      <div id="analysis" className="mb-8">
        {notice && (
          <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            {notice}
          </div>
        )}
        <AnalysisSection
          offers={live.offers}
          grades={live.grades}
          siteNames={siteNames}
          siteOptions={siteOptions}
          analyzing={live.analyzing}
          analysisStopping={live.analysisStopping}
          analysisStartedAt={live.analysisStartedAt}
          analysisCompletedAt={live.analysisCompletedAt}
          evidencePageCount={live.progress?.total ?? evidencePageCount}
          pagesProcessed={live.progress?.processed ?? null}
          runAnalysisAction={runAnalysisAction}
          resumeAnalysisAction={resumeAnalysisAction}
          stopAnalysisAction={stopAnalysisAction}
          passOfferAction={passOfferAction}
          deleteOfferAction={deleteOfferAction}
          verifyBorderlineAction={verifyBorderlineAction}
          lowConfidenceThreshold={lowConfidenceThreshold}
          canAnalyze={canAnalyze}
        />
      </div>

      {/* Offer breakdown — pre-publish gut check, same view as verify-offers.ts.
          Lives here rather than in the server page so it reads the same polled
          offers as the analysis section; rendered from a server snapshot it
          stayed stale until a manual reload once analysis finished. */}
      {live.offers.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Offer breakdown
          </h2>
          <RunOfferBreakdown
            offers={live.offers}
            siteMeta={siteMeta}
            publishableConfidenceFloor={publishableConfidenceFloor}
          />
        </div>
      )}
    </>
  );
}
