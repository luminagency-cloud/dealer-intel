"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-fetches server data on an interval while `active` — used to stream
 *  background collection progress without a websocket. */
export function AutoRefresh({
  active,
  intervalMs = 4000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
