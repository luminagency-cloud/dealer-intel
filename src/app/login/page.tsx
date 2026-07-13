import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";
import { isAuthConfigured } from "@/lib/env";
import { AUTH_DISABLED } from "@/lib/session";

async function login(formData: FormData) {
  "use server";
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect("/login?error=1");
    }
    throw error;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (AUTH_DISABLED) redirect("/");

  const session = await auth();
  if (session?.user) redirect("/");

  const { error } = await searchParams;
  const authConfigured = isAuthConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Dealer Intel
          </h1>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">
            Dealer Offer Intelligence Platform
          </p>
        </div>

        {!authConfigured ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">Authentication not configured</p>
            <p className="mt-1">
              Set <code className="font-mono">AUTH_SECRET</code>,{" "}
              <code className="font-mono">ADMIN_EMAIL</code> and{" "}
              <code className="font-mono">ADMIN_PASSWORD</code> in{" "}
              <code className="font-mono">.env</code>, then restart the
              server.
            </p>
          </div>
        ) : (
          <form
            action={login}
            className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {error && (
              <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                Invalid email or password.
              </p>
            )}
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Email
              <input
                type="email"
                name="email"
                required
                autoComplete="username"
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
              />
            </label>
            <label className="mt-4 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Password
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
              />
            </label>
            <button
              type="submit"
              className="mt-6 w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
