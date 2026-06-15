export { auth as proxy } from "@/auth";

export const config = {
  // Protect everything except login and the public /r/ route
  matcher: ["/((?!login|r/|_next/static|_next/image|favicon.ico).*)"],
};
