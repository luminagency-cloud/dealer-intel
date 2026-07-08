import type { Site } from "@/lib/db";

export function SiteForm({
  action,
  site,
  error,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  site?: Site;
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
          defaultValue={site?.name}
          placeholder="Smith Honda"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
        />
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        URL
        <input
          type="url"
          name="url"
          required
          defaultValue={site?.url}
          placeholder="https://www.smithhonda.com"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
        />
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Platform{" "}
        <span className="font-normal text-zinc-700 dark:text-zinc-200">(optional)</span>
        <input
          type="text"
          name="platform"
          defaultValue={site?.platform ?? ""}
          placeholder="Dealer.com, DealerInspire, DealerOn…"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
        />
      </label>
      <div className="mt-4 grid grid-cols-[1fr_8rem] gap-3">
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Brand{" "}
          <span className="font-normal text-zinc-700 dark:text-zinc-200">(optional)</span>
          <input
            type="text"
            name="brand"
            defaultValue={site?.brand ?? ""}
            placeholder="Kia"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
          />
        </label>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          State{" "}
          <span className="font-normal text-zinc-700 dark:text-zinc-200">(optional)</span>
          <input
            type="text"
            name="state"
            maxLength={2}
            defaultValue={site?.state ?? ""}
            placeholder="RI"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase shadow-sm focus:border-zinc-500 focus:outline-none"
          />
        </label>
      </div>
      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Inventory path{" "}
        <span className="font-normal text-zinc-700 dark:text-zinc-200">(optional)</span>
        <input
          type="text"
          name="inventoryPath"
          defaultValue={site?.inventoryPath ?? ""}
          placeholder="/new-inventory"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
        />
      </label>
      <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Additional states{" "}
        <span className="font-normal text-zinc-700 dark:text-zinc-200">
          (optional — for multi-jurisdiction compliance)
        </span>
        <input
          type="text"
          name="otherStates"
          defaultValue={(site?.otherStates ?? []).join(", ")}
          placeholder="MA, CT"
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase shadow-sm focus:border-zinc-500 focus:outline-none"
        />
      </label>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {submitLabel}
        </button>
        <a href="/dealers" className="text-sm text-zinc-600 hover:underline dark:text-zinc-200">
          Cancel
        </a>
      </div>
    </form>
  );
}
