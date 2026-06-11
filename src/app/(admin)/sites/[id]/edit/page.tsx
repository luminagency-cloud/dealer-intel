import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, sites } from "@/lib/db";
import { SiteForm } from "@/components/site-form";
import { updateSite } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);

  const [site] = await getDb().select().from(sites).where(eq(sites.id, id));
  if (!site) notFound();

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">
        Edit Site
      </h1>
      <SiteForm
        action={updateSite.bind(null, site.id)}
        site={site}
        error={error}
        submitLabel="Save Changes"
      />
    </div>
  );
}
