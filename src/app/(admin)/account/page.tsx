import { requireSession } from "@/lib/session";
import { AccountForms } from "./account-forms";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await requireSession();
  return (
    <div className="max-w-lg">
      <h1 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Account Settings</h1>
      <AccountForms currentEmail={session.user.email} />
    </div>
  );
}
