"use client";

import { useEffect, useState } from "react";
import type { MissionResult, ReportSnapshot, Offer, ComplianceGrade, Site } from "@/lib/db";
import { MissionRunPanel, type PanelWorkItem } from "@/components/mission-run-panel";
import { RunWorkflowStrip } from "@/components/run-workflow-strip";
import { AnalysisSection } from "@/components/analysis-section";

interface LiveStatus {
  executing: boolean;
  analyzing: boolean;
  paused: boolean;
  stalled: boolean;
  progress: { processed: number; total: number } | null;
  partialAnalysisKeys: string[];
  results: Pick<
    MissionResult,
    "id" | "siteId" | "missionId" | "status" | "pagesCaptured" | "successfulUrl" | "error"
  >[];
}

export function RunLiveData({
  runId,
  initialExecuting,
  initialAnalyzing,
  initialPaused,
  initialStalled,
  initialProgress,
  initialPartialAnalysisKeys,
  items,
  initialResults,
  snapshots,
  offers,
  grades,
  siteNames,
  siteOptions,
  canCollect,
  canAnalyze,
  canPublish,
  analysisStartedAt,
  analysisCompletedAt,
  evidencePageCount,
  executeItemAction,
  executeAllAction,
  retryAction,
  forceReCollectAction,
  reAnalyzeSiteMissionAction,
  pauseAction,
  resumePausedRunAction,
  resumeAction,
  runAnalysisAction,
  resumeAnalysisAction,
  publishSnapshotAction,
  defaultSnapshotLabel,
  collectionStartedAt,
  collectionCompletedAt,
  // Static metadata bar content — pre-formatted by the server page
  runIdShort,
  createdLabel,
  startedLabel,
  completedLabel,
  error,
}: {
  runId: string;
  initialExecuting: boolean;
  initialAnalyzing: boolean;
  initialPaused: boolean;
  initialStalled: boolean;
  initialProgress: { processed: number; total: number } | null;
  initialPartialAnalysisKeys: string[];
  items: PanelWorkItem[];
  initialResults: MissionResult[];
  snapshots: ReportSnapshot[];
  offers: Offer[];
  grades: ComplianceGrade[];
  siteNames: Record<string, string>;
  siteOptions: Pick<Site, "id" | "name">[];
  canCollect: boolean;
  canAnalyze: boolean;
  canPublish: boolean;
  analysisStartedAt?: Date | null;
  analysisCompletedAt?: Date | null;
  evidencePageCount: number;
  executeItemAction: (siteId: string, missionId: string) => Promise<void>;
  executeAllAction: () => Promise<void>;
  retryAction: (resultId: string) => Promise<void>;
  forceReCollectAction?: (siteId: string, missionId: string) => Promise<void>;
  reAnalyzeSiteMissionAction?: (siteId: string, missionType: string) => Promise<void>;
  pauseAction?: () => Promise<void>;
  resumePausedRunAction?: () => Promise<void>;
  resumeAction?: () => Promise<void>;
  runAnalysisAction: () => Promise<void>;
  resumeAnalysisAction?: () => Promise<void>;
  publishSnapshotAction: (formData: FormData) => Promise<void>;
  defaultSnapshotLabel?: string;
  collectionStartedAt?: Date | null;
  collectionCompletedAt?: Date | null;
  runIdShort: string;
  createdLabel: string;
  startedLabel: string | null;
  completedLabel: string | null;
  error?: string;
}) {
  const [live, setLive] = useState<LiveStatus>({
    executing: initialExecuting,
    analyzing: initialAnalyzing,
    paused: initialPaused,
    stalled: initialStalled,
    progress: initialProgress,
    partialAnalysisKeys: initialPartialAnalysisKeys,
    results: initialResults,
  });

  const active = live.executing || live.analyzing || live.partialAnalysisKeys.length > 0;

  useEffect(() => {
    if (!active) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/status`);
        if (res.ok) setLive(await res.json());
      } catch {
        // ignore transient errors
      }
    };
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [active, runId]);

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
        offerCount={offers.length}
        snapshots={snapshots}
        executing={live.executing}
        paused={live.paused}
        stalled={live.stalled}
        canCollect={canCollect}
        analyzing={live.analyzing}
        canAnalyze={canAnalyze}
        canPublish={canPublish}
        runAnalysisAction={runAnalysisAction}
        publishSnapshotAction={publishSnapshotAction}
        executeAllAction={executeAllAction}
        pauseAction={pauseAction}
        resumePausedRunAction={resumePausedRunAction}
        resumeAction={resumeAction ?? (async () => {})}
        defaultSnapshotLabel={defaultSnapshotLabel}
      />

      {/* Static metadata bar */}
      <div className="mb-6 flex items-center gap-4 border-b border-zinc-100 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
        <span className="font-mono">{runIdShort}</span>
        <span>Created {createdLabel}</span>
        {startedLabel && <span>Started {startedLabel}</span>}
        {completedLabel && <span>Completed {completedLabel}</span>}
      </div>

      <div id="collection" className="mb-8">
        <MissionRunPanel
          runId={runId}
          items={items}
          results={mergedResults}
          executing={live.executing}
          canCollect={canCollect}
          stalled={live.stalled}
          collectionStartedAt={collectionStartedAt}
          collectionCompletedAt={collectionCompletedAt}
          executeItemAction={executeItemAction}
          executeAllAction={executeAllAction}
          retryAction={retryAction}
          forceReCollectAction={forceReCollectAction}
          reAnalyzeSiteMissionAction={reAnalyzeSiteMissionAction}
          partialAnalysisKeys={new Set(live.partialAnalysisKeys)}
          resumeAction={resumeAction}
          error={error}
        />
      </div>

      <div id="analysis" className="mb-8">
        <AnalysisSection
          offers={offers}
          grades={grades}
          siteNames={siteNames}
          siteOptions={siteOptions}
          analyzing={live.analyzing}
          analysisStartedAt={analysisStartedAt}
          analysisCompletedAt={analysisCompletedAt}
          evidencePageCount={live.progress?.total ?? evidencePageCount}
          pagesProcessed={live.progress?.processed ?? null}
          runAnalysisAction={runAnalysisAction}
          resumeAnalysisAction={resumeAnalysisAction}
          canAnalyze={canAnalyze}
        />
      </div>
    </>
  );
}
