"use client";

import { useEffect, useRef } from "react";

/**
 * Shared "fetch on an interval, clean up on unmount" skeleton behind the two
 * hand-rolled polling loops that used to live in `run-live-data.tsx` and
 * `inventory-table.tsx`. Owns only the mechanics — interval, optional
 * tab-visibility gating, cleanup, swallowing transient fetch errors. Callers
 * keep their own merge-into-state logic in `onData`: that differs per caller
 * (patch fields onto a richer object vs. full-variant replace, composite key
 * vs. single id, different termination conditions), so forcing one shared
 * merge algorithm onto both would be the wrong abstraction — only the polling
 * mechanics were actually duplicated.
 */
export function usePolling<T>(
  url: string,
  opts: {
    /** Effect is a no-op while false — lets a caller poll only while some
     *  condition holds (e.g. inventory-table's `!!activeBatchId`). */
    enabled: boolean;
    intervalMs: number;
    /** Skip polling while the tab is hidden, and poll immediately on return.
     *  A poll gated on its own polled state is a one-way latch — visibility
     *  is the one signal that can safely wake it back up regardless of what
     *  the last poll reported. */
    visibilityGated?: boolean;
    fetchInit?: RequestInit;
    onData: (data: T) => void;
  }
): void {
  const { enabled, intervalMs, visibilityGated = false, fetchInit, onData } = opts;
  // Ref so a caller's inline onData doesn't force the effect to tear down and
  // rebuild (and thus re-poll immediately) on every render.
  const onDataRef = useRef(onData);
  useEffect(() => {
    onDataRef.current = onData;
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(url, fetchInit);
        if (!res.ok || cancelled) return;
        const data: T = await res.json();
        if (cancelled) return;
        onDataRef.current(data);
      } catch {
        // ignore transient errors — next tick retries
      }
    };

    const sync = () => {
      clearInterval(timer);
      if (visibilityGated && document.hidden) return;
      void poll();
      timer = setInterval(poll, intervalMs);
    };

    sync();
    if (visibilityGated) {
      document.addEventListener("visibilitychange", sync);
    }
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (visibilityGated) {
        document.removeEventListener("visibilitychange", sync);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchInit/onData intentionally excluded: fetchInit is caller-stable in practice, onData is read via ref.
  }, [enabled, intervalMs, url, visibilityGated]);
}
