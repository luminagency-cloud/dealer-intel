"use client";

import { useActionState } from "react";
import { changeEmail, changePassword } from "./actions";

type Result = { error?: string; success?: string } | undefined;

function Alert({ result }: { result: Result }) {
  if (!result) return null;
  if (result.error)
    return <p className="mt-2 text-sm text-red-600">{result.error}</p>;
  return <p className="mt-2 text-sm text-green-700">{result.success}</p>;
}

export function AccountForms({ currentEmail }: { currentEmail: string }) {
  const [emailResult, emailAction, emailPending] = useActionState<Result, FormData>(
    changeEmail,
    undefined
  );
  const [pwResult, pwAction, pwPending] = useActionState<Result, FormData>(
    changePassword,
    undefined
  );

  return (
    <div className="space-y-6">
      {/* Change email */}
      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Change Email</h2>
        </div>
        <form action={emailAction} className="space-y-3 px-4 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700">
              New Email
            </label>
            <input
              type="email"
              name="email"
              required
              defaultValue={currentEmail}
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <Alert result={emailResult} />
            <button
              type="submit"
              disabled={emailPending}
              className="ml-auto rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {emailPending ? "Saving…" : "Save Email"}
            </button>
          </div>
        </form>
      </div>

      {/* Change password */}
      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">Change Password</h2>
        </div>
        <form action={pwAction} className="space-y-3 px-4 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700">
              Current Password
            </label>
            <input
              type="password"
              name="current"
              required
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700">
              New Password
            </label>
            <input
              type="password"
              name="password"
              required
              minLength={8}
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700">
              Confirm New Password
            </label>
            <input
              type="password"
              name="confirm"
              required
              minLength={8}
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <Alert result={pwResult} />
            <button
              type="submit"
              disabled={pwPending}
              className="ml-auto rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {pwPending ? "Saving…" : "Save Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
