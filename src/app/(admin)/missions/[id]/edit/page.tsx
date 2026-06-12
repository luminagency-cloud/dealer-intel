import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, missions } from "@/lib/db";
import { MissionForm } from "@/components/mission-form";
import { updateMission } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditMissionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);

  const [mission] = await getDb()
    .select()
    .from(missions)
    .where(eq(missions.id, id));
  if (!mission) notFound();

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">
        Edit Mission
      </h1>
      <MissionForm
        action={updateMission.bind(null, mission.id)}
        mission={mission}
        error={error}
        submitLabel="Save Changes"
      />
    </div>
  );
}
