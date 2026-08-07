/** True for connection-level errors worth retrying once — not for 4xx/5xx
 *  HTTP responses, which callers handle separately. */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EPIPE") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return isTransientNetworkError(cause);
  return false;
}
