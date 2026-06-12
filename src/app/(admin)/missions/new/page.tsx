import { MissionForm } from "@/components/mission-form";
import { createMission } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewMissionPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">Add Mission</h1>
      <MissionForm
        action={createMission}
        error={error}
        submitLabel="Create Mission"
      />
    </div>
  );
}
