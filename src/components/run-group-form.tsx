import type { RunGroup, Site } from "@/lib/db";

/** Create/edit a run group: name it, pick member sites, and flag the
 *  first-order dealer(s) the group is built around. */
export function RunGroupForm({
  action,
  siteOptions,
  group,
  members,
  error,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  siteOptions: Pick<Site, "id" | "name" | "url">[];
  group?: RunGroup;
  members?: { siteId: string; isPrimary: boolean }[];
  error?: string;
  submitLabel: string;
}) {
  const memberMap = new Map(
    (members ?? []).map((m) => [m.siteId, m.isPrimary])
  );
  const formKey = group?.id ?? "new";

  return (
    <form
      key={formKey}
      action={action}
      className="max-w-2xl rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
    >
      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <label className="block text-sm font-medium text-zinc-700">
        Group Name
        <input
          type="text"
          name="name"
          required
          defaultValue={group?.name ?? ""}
          placeholder="Elmwood"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
        />
      </label>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-zinc-700">
          Member Sites
        </legend>
        <p className="mt-0.5 text-xs text-zinc-500">
          Check the sites this group collects. Mark the first-order dealer(s)
          the group is built around as Primary — reporting will anchor
          comparisons on them.
        </p>
        <div className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-200">
          <div className="grid grid-cols-[1fr_auto] gap-4 bg-zinc-50 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <span>Site</span>
            <span>Primary</span>
          </div>
          {siteOptions.map((site) => (
            <div
              key={site.id}
              className="grid grid-cols-[1fr_auto] items-center gap-4 px-3 py-2"
            >
              <label className="flex items-center gap-2 text-sm text-zinc-900">
                <input
                  type="checkbox"
                  name="memberSiteIds"
                  value={site.id}
                  defaultChecked={memberMap.has(site.id)}
                  className="h-4 w-4 rounded border-zinc-300"
                />
                <span>
                  {site.name}{" "}
                  <span className="text-xs text-zinc-400">{site.url}</span>
                </span>
              </label>
              <label className="flex justify-center">
                <input
                  type="checkbox"
                  name="primarySiteIds"
                  value={site.id}
                  defaultChecked={memberMap.get(site.id) === true}
                  className="h-4 w-4 rounded border-zinc-300"
                  title="First-order dealer"
                />
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          {submitLabel}
        </button>
        <a href="/groups" className="text-sm text-zinc-600 hover:underline">
          Cancel
        </a>
      </div>
    </form>
  );
}
