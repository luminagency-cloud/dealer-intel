import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

/**
 * Auto-launches the sibling `dealer-inventory-api` repo as a local child
 * process when RUN_INVENTORY_LOCALLY=true, so the operator only has to
 * start one app. Some dealer sites block the deployed Fly instance's IP but
 * pass fine from the operator's own machine — this is how they run the
 * collector locally instead. See src/lib/inventory.ts for the URL/key
 * switch this supports.
 */

const HEALTHZ_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 20;

type LocalInventoryStatus = "stopped" | "starting" | "running" | "error";

// Survives dev-server HMR module reloads — avoids double-spawning the child.
const globalState = globalThis as unknown as {
  __localInventoryProcess?: {
    child: ChildProcess | null;
    status: LocalInventoryStatus;
    ensured: boolean;
  };
};
if (!globalState.__localInventoryProcess) {
  globalState.__localInventoryProcess = { child: null, status: "stopped", ensured: false };
}
const state = globalState.__localInventoryProcess;

/** Live check (not the cached spawn-attempt status) — for the Inventory page
 *  to warn the operator up front if the local API isn't actually reachable,
 *  rather than letting them find out via a confusing collection failure. */
export async function checkLocalInventoryHealth(baseUrl: string): Promise<boolean> {
  return isHealthy(baseUrl);
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/healthz`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Spawns the sibling inventory-api repo locally if it isn't already
 *  reachable. Safe to call repeatedly (e.g. once per request) — only
 *  spawns once per server process, and detects (rather than replaces) an
 *  instance already running from a prior session. No-op outside local dev. */
export async function ensureLocalInventoryApi(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.RUN_INVENTORY_LOCALLY !== "true") return;
  if (state.ensured) return;
  state.ensured = true;

  const baseUrl = process.env.INVENTORY_API_URL_LOCAL;
  if (!baseUrl) {
    console.error("[local-inventory-api] RUN_INVENTORY_LOCALLY=true but INVENTORY_API_URL_LOCAL is not set");
    state.status = "error";
    return;
  }

  if (await isHealthy(baseUrl)) {
    console.log(`[local-inventory-api] already running at ${baseUrl}, reusing it`);
    state.status = "running";
    return;
  }

  const dir = resolve(process.cwd(), process.env.LOCAL_INVENTORY_API_DIR ?? "../dealer-inventory-api");
  console.log(`[local-inventory-api] starting via "npm run start:local" in ${dir}`);
  state.status = "starting";

  const child = spawn("npm", ["run", "start:local"], {
    cwd: dir,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[local-inventory-api] ${chunk}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[local-inventory-api] ${chunk}`);
  });
  child.on("exit", (code) => {
    console.log(`[local-inventory-api] process exited (code ${code})`);
    if (state.child === child) {
      state.child = null;
      state.status = "stopped";
    }
  });

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    if (await isHealthy(baseUrl)) {
      console.log(`[local-inventory-api] up at ${baseUrl}`);
      state.status = "running";
      return;
    }
  }

  console.error(`[local-inventory-api] never became healthy at ${baseUrl} after ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`);
  state.status = "error";
}

function killOwnedChild(): void {
  // Only kill a process we spawned ourselves — never one we merely detected
  // as already running from a prior session.
  if (state.child) state.child.kill();
}

process.once("SIGINT", killOwnedChild);
process.once("SIGTERM", killOwnedChild);
process.once("exit", killOwnedChild);
