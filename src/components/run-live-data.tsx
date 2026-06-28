"use client";

import { useEffect, useRef, useState } from "react";
import type { MissionResult, ReportSnapshot, Offer, ComplianceGrade, Site } from "@/lib/db";
import { MissionRunPanel, type PanelWorkItem } from "@/components/mission-run-panel";
import { RunWorkflowStrip } from "@/components/run-workflow-strip";
import { AnalysisSection } from "@/components/analysis-section";

interface LiveStatus {
  executing: boolean;
  analyzing: boolean;
  stalled: boolean;
  progress: { processed: number; total: number } | null;
  partialAnalysisKeys: string[];
  results: Pick<MissionResult, "id" | "siteId" | "missionId" | "status" | "pagesCaptured">[];
}

export function RunLiveData({
  runId,
  initialExecuting,
  initialAnalyzing,
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
    stalled: initialStalled,
    progress: initialProgress,
    partialAnalysisKeys: initialPartialAnalysisKeys,
    results: initialResults,
  });

  const active = live.executing || live.analyzing || live.partialAnalysisKeys.length > 0;
  const activeRef = useRef(active);
  activeRef.current = active;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, runId]);

  // Overlay live status/pagesCaptured onto the full MissionResult objects.
  const liveById = new Map(live.results.map((r) => [r.id, r]));
  const mergedResults = new Map(
    initialResults.map((r) => {
      const up = liveById.get(r.id);
      const merged = up ? { ...r, status: up.status, pagesCaptured: up.pagesCaptured } : r;
      return [`${r.siteId}:${r.missionId}`, merged];
    })
  );
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
        stalled={live.stalled}
        canCollect={canCollect}
        analyzing={live.analyzing}
        canAnalyze={canAnalyze}
        canPublish={canPublish}
        runAnalysisAction={runAnalysisAction}
        publishSnapshotAction={publishSnapshotAction}
        executeAllAction={executeAllAction}
        resumeAction={resumeAction ?? (async () => {})}
        defaultSnapshotLabel={defaultSnapshotLabel}
      />

      {/* Static metadata bar */}
      <div className="mb-6 flex items-center gap-4 border-b border-zinc-100 py-2 text-xs text-zinc-700">
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
