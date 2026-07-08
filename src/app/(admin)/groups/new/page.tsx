import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb, sites } from "@/lib/db";
import { RunGroupForm } from "@/components/run-group-form";
import { createRunGroup } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewRunGroupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const siteOptions = await getDb()
    .select({ id: sites.id, name: sites.name, url: sites.url })
    .from(sites)
    .where(eq(sites.active, true))
    .orderBy(asc(sites.name));

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        Add Run Group
      </h1>
      {siteOptions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          Create some{" "}
          <Link href="/dealers/new" className="underline">
            dealers
          </Link>{" "}
          first — run groups are built from dealers.
        </p>
      ) : (
        <RunGroupForm
          action={createRunGroup}
          siteOptions={siteOptions}
          error={error}
          submitLabel="Create Run Group"
        />
      )}
    </div>
  );
}
