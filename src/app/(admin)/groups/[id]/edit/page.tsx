import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb, runGroupMembers, runGroups, sites } from "@/lib/db";
import { RunGroupForm } from "@/components/run-group-form";
import { updateRunGroup } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditRunGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);

  const db = getDb();
  const [[group], members, siteOptions] = await Promise.all([
    db.select().from(runGroups).where(eq(runGroups.id, id)),
    db
      .select({
        siteId: runGroupMembers.siteId,
        isPrimary: runGroupMembers.isPrimary,
      })
      .from(runGroupMembers)
      .where(eq(runGroupMembers.runGroupId, id)),
    db
      .select({ id: sites.id, name: sites.name, url: sites.url })
      .from(sites)
      .where(eq(sites.active, true))
      .orderBy(asc(sites.name)),
  ]);
  if (!group) notFound();

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">
        Edit Run Group
      </h1>
      <RunGroupForm
        action={updateRunGroup.bind(null, group.id)}
        siteOptions={siteOptions}
        group={group}
        members={members}
        error={error}
        submitLabel="Save Changes"
      />
    </div>
  );
}
