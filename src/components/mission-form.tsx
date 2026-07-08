import {
  MISSION_TYPE_LABELS,
  missionTypeEnum,
  type Mission,
} from "@/lib/db";

/** Global mission definition: what to collect, independent of any dealer.
 *  Per-dealer URLs are configured on each site's edit page. */
export function MissionForm({
  action,
  mission,
  error,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  mission?: Mission;
  error?: string;
  submitLabel: string;
}) {
  return (
    <form
      action={action}
      className="max-w-lg rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Name
        <input
          type="text"
          name="name"
          required
          defaultValue={mission?.name ?? ""}
          placeholder="Service Specials"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
        />
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Collection Behavior
        <select
          name="missionType"
          required
          defaultValue={mission?.missionType ?? ""}
          className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:focus:border-zinc-400"
        >
          <option value="" disabled>
            Select a behavior…
          </option>
          {missionTypeEnum.enumValues.map((value) => (
            <option key={value} value={value}>
              {MISSION_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs font-normal text-zinc-700">
          Determines URL discovery paths and page exploration (carousels,
          tabs, accordions, disclaimers).
        </span>
      </label>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {submitLabel}
        </button>
        <a href="/missions" className="text-sm text-zinc-600 hover:underline dark:text-zinc-200">
          Cancel
        </a>
      </div>
    </form>
  );
}
