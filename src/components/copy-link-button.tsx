"use client";

export function CopyLinkButton({
  shareUrl,
  unavailableLabel = "Public link unavailable",
}: {
  shareUrl?: string;
  unavailableLabel?: string;
}) {
  const canCopy = Boolean(shareUrl);
  return (
    <button
      disabled={!canCopy}
      title={canCopy ? "Copy public report link" : unavailableLabel}
      onClick={() => {
        if (!shareUrl) return;
        void navigator.clipboard.writeText(shareUrl);
        const btn = document.getElementById("copy-link-btn");
        if (btn) {
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = "Copy shareable link";
          }, 2000);
        }
      }}
      id="copy-link-btn"
      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
    >
      {canCopy ? "Copy shareable link" : unavailableLabel}
    </button>
  );
}
