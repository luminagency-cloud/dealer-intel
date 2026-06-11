import {
  MISSION_TYPE_LABELS,
  missionTypeEnum,
  type Mission,
  type Site,
} from "@/lib/db";

export function MissionForm({
  action,
  siteOptions,
  mission,
  error,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  siteOptions: Pick<Site, "id" | "name">[];
  mission?: Mission;
  error?: string;
  submitLabel: string;
}) {
  return (
    <form
      action={action}
      className="max-w-lg rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
    >
      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <label className="block text-sm font-medium text-zinc-700">
        Site
        <select
          name="siteId"
          required
          defaultValue={mission?.siteId ?? ""}
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
        >
          <option value="" disabled>
            Select a site…
          </option>
          {siteOptions.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700">
        Mission Type
        <select
          name="missionType"
          required
          defaultValue={mission?.missionType ?? ""}
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
        >
          <option value="" disabled>
            Select a mission type…
          </option>
          {missionTypeEnum.enumValues.map((value) => (
            <option key={value} value={value}>
              {MISSION_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700">
        Last Known URL{" "}
        <span className="font-normal text-zinc-400">(optional)</span>
        <input
          type="url"
          name="lastKnownUrl"
          defaultValue={mission?.lastKnownUrl ?? ""}
          placeholder="https://www.smithhonda.com/specials"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
        />
        <span className="mt-1 block text-xs font-normal text-zinc-400">
          Left blank, the collector tries common platform paths and the
          site&apos;s navigation, then remembers what worked.
        </span>
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700">
        Additional URLs{" "}
        <span className="font-normal text-zinc-400">
          (optional, one per line)
        </span>
        <textarea
          name="alternateUrls"
          rows={3}
          defaultValue={(mission?.alternateUrls ?? []).join("\n")}
          placeholder={
            "https://www.smithhonda.com/service-coupons\nhttps://www.smithhonda.com/parts-specials"
          }
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
        />
        <span className="mt-1 block text-xs font-normal text-zinc-400">
          Every URL listed is captured on each collection — use this when the
          full picture spans several pages.
        </span>
      </label>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          {submitLabel}
        </button>
        <a href="/missions" className="text-sm text-zinc-600 hover:underline">
          Cancel
        </a>
      </div>
    </form>
  );
}
