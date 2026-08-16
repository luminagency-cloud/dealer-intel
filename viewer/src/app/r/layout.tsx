import Link from "next/link";

/** Public, no-login report view — reached via a share-token link with no
 *  session. The dealer sign-in button is the only path from here back to
 *  /dashboard, where a logged-in dealer sees every snapshot they have
 *  access to, not just the one this link points at. */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="flex justify-end px-4 pt-4">
        <Link
          href="/login"
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
        >
          Dealer Sign-in
        </Link>
      </div>
      {children}
    </div>
  );
}
