import Link from "next/link";
import { asc } from "drizzle-orm";
import { getDb, sites } from "@/lib/db";
import { MissionForm } from "@/components/mission-form";
import { createMission } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewMissionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const siteOptions = await getDb()
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .orderBy(asc(sites.name));

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">Add Mission</h1>
      {siteOptions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          Create a{" "}
          <Link href="/sites/new" className="underline">
            site
          </Link>{" "}
          first — missions belong to sites.
        </p>
      ) : (
        <MissionForm
          action={createMission}
          siteOptions={siteOptions}
          error={error}
          submitLabel="Create Mission"
        />
      )}
    </div>
  );
}
