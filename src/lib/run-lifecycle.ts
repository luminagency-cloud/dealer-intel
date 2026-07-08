import type { RunStatus } from "@/lib/db";

/** Valid run lifecycle transitions. The collector (Phase 5) will drive
 *  pending→running→review/failed automatically; until then the operator
 *  can walk a run through its lifecycle manually. */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "failed"],
  running: ["review", "failed"],
  paused: [],
  review: ["complete", "failed"],
  complete: [],
  failed: [],
};
