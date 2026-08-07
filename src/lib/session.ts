import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Master switch for login. Auth is currently DISABLED so the app can be used
 * without signing in. To bring authentication back, either set `ENABLE_AUTH=1`
 * in the environment, or delete this flag and restore the original guards.
 *
 * While disabled, every guard returns the stub operator session below and the
 * login UI (login page, sign-out button, account link) is hidden.
 */
export const AUTH_DISABLED = process.env.ENABLE_AUTH !== "1";

/** Fake operator session used when AUTH_DISABLED is set. Has role "admin" so
 *  admin-only pages and actions remain reachable. */
const STUB_SESSION = {
  user: {
    id: "local-operator",
    email: "operator@localhost",
    name: "Operator",
    role: "admin",
  },
  expires: "9999-12-31T23:59:59.000Z",
};

/** Current session, or the stub operator session when auth is disabled.
 *  Use in API routes that only need "is there a user" gating. */
export async function getSession() {
  if (AUTH_DISABLED) return STUB_SESSION;
  return auth();
}

/** Guard for any authenticated page (admin or dealer). */
export async function requireSession() {
  if (AUTH_DISABLED) return STUB_SESSION;
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session;
}

/** Guard for operator-only pages and server actions. */
export async function requireAdminSession() {
  if (AUTH_DISABLED) return STUB_SESSION;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "admin") redirect("/");
  return session;
}

/** Guard for JSON API routes: returns the session, or a 401 response to
 *  return immediately. `if (response) return response;` */
export async function requireApiSession(): Promise<
  | { session: NonNullable<Awaited<ReturnType<typeof getSession>>>; response: null }
  | { session: null; response: NextResponse }
> {
  const session = await getSession();
  if (!session?.user) {
    return { session: null, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { session, response: null };
}
