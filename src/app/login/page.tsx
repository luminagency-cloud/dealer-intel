import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn } from "@/auth";
import { isAuthConfigured } from "@/lib/env";

async function login(formData: FormData) {
  "use server";
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/sites",
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
  const session = await auth();
  if (session?.user) redirect("/sites");

  const { error } = await searchParams;
  const authConfigured = isAuthConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Dealer Intel
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Dealer Offer Intelligence Platform
          </p>
        </div>

        {!authConfigured ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Authentication not configured</p>
            <p className="mt-1">
              Set <code className="font-mono">AUTH_SECRET</code>,{" "}
              <code className="font-mono">ADMIN_EMAIL</code> and{" "}
              <code className="font-mono">ADMIN_PASSWORD</code> in{" "}
              <code className="font-mono">.env.local</code>, then restart the
              server.
            </p>
          </div>
        ) : (
          <form
            action={login}
            className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm"
          >
            {error && (
              <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                Invalid email or password.
              </p>
            )}
            <label className="block text-sm font-medium text-zinc-700">
              Email
              <input
                type="email"
                name="email"
                required
                autoComplete="username"
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
              />
            </label>
            <label className="mt-4 block text-sm font-medium text-zinc-700">
              Password
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
                className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
              />
            </label>
            <button
              type="submit"
              className="mt-6 w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
