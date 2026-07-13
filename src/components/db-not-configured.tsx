export function DbNotConfigured() {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <p className="font-medium">Database not configured</p>
      <p className="mt-1">
        Set <code className="font-mono">DATABASE_URL</code> in{" "}
        <code className="font-mono">.env</code> (Neon Postgres connection
        string), run <code className="font-mono">npm run db:migrate</code>, then
        restart the server.
      </p>
    </div>
  );
}
