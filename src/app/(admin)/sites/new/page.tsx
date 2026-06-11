import { SiteForm } from "@/components/site-form";
import { createSite } from "../actions";

export default async function NewSitePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">Add Site</h1>
      <SiteForm action={createSite} error={error} submitLabel="Create Site" />
    </div>
  );
}
