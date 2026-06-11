import { MISSION_TYPE_LABELS, missionTypeEnum, type Site } from "@/lib/db";

/** Manually trigger the Phase 5 collector for one site. Mission-driven
 *  orchestration across many sites arrives in Phase 6. */
export function CollectEvidenceForm({
  action,
  siteOptions,
  collected,
  collectError,
}: {
  action: (formData: FormData) => Promise<void>;
  siteOptions: Pick<Site, "id" | "name">[];
  collected?: string;
  collectError?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">
          Collect Evidence
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Visits the site, dismisses overlays, and captures a full-page
          screenshot plus an HTML snapshot. Takes up to a minute.
        </p>
      </div>
      {collected && (
        <p className="mx-4 mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Collection succeeded — {collected} evidence item(s) captured.
        </p>
      )}
      {collectError && (
        <p className="mx-4 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Collection failed: {collectError}
        </p>
      )}
      <form
        action={action}
        className="flex flex-wrap items-end gap-3 px-4 py-3"
      >
        <label className="block text-xs font-medium text-zinc-600">
          Site
          <select
            name="siteId"
            required
            defaultValue=""
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="" disabled>
              Select…
            </option>
            {siteOptions.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-zinc-600">
          Mission
          <select
            name="missionType"
            required
            defaultValue=""
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="" disabled>
              Select…
            </option>
            {missionTypeEnum.enumValues.map((value) => (
              <option key={value} value={value}>
                {MISSION_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Collect
        </button>
      </form>
    </div>
  );
}
