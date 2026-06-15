import { signIn } from "@/auth";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function login(formData: FormData) {
    "use server";
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    try {
      await signIn("credentials", { email, password, redirectTo: "/dashboard" });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect("/login?error=1");
      }
      throw err;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-zinc-900">Dealer Intel</h1>
          <p className="mt-1 text-sm text-zinc-500">Sign in to view your reports</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <form action={login} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Email
              </label>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">
                Password
              </label>
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none"
              />
            </div>
            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                Invalid email or password.
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-md bg-zinc-900 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Sign in
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
