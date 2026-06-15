import Link from "next/link";
import { getDb, isDatabaseConfigured, collectionRuns, sites, reportSnapshots } from "@/lib/db";
import { count } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let stats = { dealers: 0, runs: 0, snapshots: 0 };

  if (isDatabaseConfigured()) {
    const [dealerCount, runCount, snapshotCount] = await Promise.all([
      getDb().select({ n: count() }).from(sites),
      getDb().select({ n: count() }).from(collectionRuns),
      getDb().select({ n: count() }).from(reportSnapshots),
    ]);
    stats = {
      dealers: dealerCount[0]?.n ?? 0,
      runs: runCount[0]?.n ?? 0,
      snapshots: snapshotCount[0]?.n ?? 0,
    };
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-10 text-center">
        <h1 className="text-2xl font-semibold text-zinc-900">
          What would you like to do?
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          Dealer Intel monitors competitor offers and flags compliance issues across your dealer group.
        </p>
      </div>

      {/* Two main CTAs */}
      <div className="mb-12 grid grid-cols-2 gap-4">
        <Link
          href="/runs"
          className="group flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-zinc-300 hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path fillRule="evenodd" d="M10 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 1ZM5.05 3.05a.75.75 0 0 1 1.06 0l1.062 1.06A.75.75 0 1 1 6.11 5.173L5.05 4.11a.75.75 0 0 1 0-1.06Zm9.9 0a.75.75 0 0 1 0 1.06l-1.06 1.062a.75.75 0 0 1-1.062-1.061l1.061-1.06a.75.75 0 0 1 1.06 0ZM3 8a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 3 8Zm11 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 14 8Zm-6.828 2.828a.75.75 0 0 1 0 1.061L6.11 12.95a.75.75 0 0 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.061 0Zm3.656 0a.75.75 0 0 1 1.06 0l1.062 1.06a.75.75 0 0 1-1.061 1.061l-1.06-1.06a.75.75 0 0 1 0-1.061ZM10 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 13Z" clipRule="evenodd" />
              <path d="M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-zinc-900 group-hover:text-zinc-700">Collect Data</p>
            <p className="mt-0.5 text-sm text-zinc-500">
              Start a new run to capture offers and evidence from dealer websites.
            </p>
          </div>
          <p className="mt-auto text-xs text-zinc-400">
            {stats.runs} run{stats.runs !== 1 ? "s" : ""} so far
          </p>
        </Link>

        <Link
          href="/reports"
          className="group flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-zinc-300 hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50 text-green-600">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path fillRule="evenodd" d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Zm10.857 5.691-4.204 4.204a.75.75 0 0 1-1.06 0L6.47 11.262a.75.75 0 1 1 1.06-1.06l1.604 1.603 3.673-3.674a.75.75 0 0 1 1.05 1.061Z" clipRule="evenodd" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-zinc-900 group-hover:text-zinc-700">Run Reports</p>
            <p className="mt-0.5 text-sm text-zinc-500">
              View competitive offer reports built from published snapshots.
            </p>
          </div>
          <p className="mt-auto text-xs text-zinc-400">
            {stats.snapshots} snapshot{stats.snapshots !== 1 ? "s" : ""} available
          </p>
        </Link>
      </div>

      {/* Pipeline flow */}
      <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="mb-5 text-xs font-semibold uppercase tracking-wide text-zinc-400">How it works</p>
        <div className="flex items-start gap-3">
          {/* Step 1 */}
          <div className="flex flex-1 flex-col items-center text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">1</div>
            <p className="mt-2 text-sm font-medium text-zinc-800">Collection</p>
            <p className="mt-1 text-xs text-zinc-500">Browser visits each dealer site and captures offer pages, screenshots, and disclaimer text.</p>
            <Link href="/runs" className="mt-2 text-xs text-blue-600 hover:underline">Runs →</Link>
          </div>

          <div className="mt-4 text-zinc-300">→</div>

          {/* Step 2 */}
          <div className="flex flex-1 flex-col items-center text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-700">2</div>
            <p className="mt-2 text-sm font-medium text-zinc-800">Analysis</p>
            <p className="mt-1 text-xs text-zinc-500">Rule-based extraction pulls structured offers from captured HTML. AI enriches low-confidence cases.</p>
            <Link href="/review" className="mt-2 text-xs text-blue-600 hover:underline">Review →</Link>
          </div>

          <div className="mt-4 text-zinc-300">→</div>

          {/* Step 3 */}
          <div className="flex flex-1 flex-col items-center text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100 text-sm font-semibold text-green-700">3</div>
            <p className="mt-2 text-sm font-medium text-zinc-800">Reporting</p>
            <p className="mt-1 text-xs text-zinc-500">Snapshots freeze the analysis output. Reports compare offers across the dealer group with compliance grades.</p>
            <Link href="/reports" className="mt-2 text-xs text-blue-600 hover:underline">Reports →</Link>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="mt-4 flex items-center justify-center gap-6 text-xs text-zinc-400">
        <span>{stats.dealers} dealer{stats.dealers !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>{stats.runs} run{stats.runs !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>{stats.snapshots} snapshot{stats.snapshots !== 1 ? "s" : ""}</span>
      </div>
    </div>
  );
}
