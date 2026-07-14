# Remote Operator Setup Plan — Dealer Intel Platform

_Created: July 14, 2026_

---

## Goal

Let a second, non-technical operator run and drive Dealer Intel collection
remotely — without installing Node, Git, or Playwright, and without editing
`.env` — while collection continues to run from a residential IP. That last
part is not optional: dealer sites and the inventory API both block
datacenter IPs, which is why collection has to run from a real home/business
connection rather than any cloud host.

---

## Architecture Decision

**Keep the whole app (admin + collector, Playwright) running as a single
persistent instance on the operator's own Windows machine, same as today.**
Do not distribute the app to the remote helper's machine. Instead, expose
that one running instance to the remote helper over **Tailscale**, so the
helper is purely a web client — the same mental model as visiting a normal
website — while every Playwright call and inventory API call still
originates from the operator's own machine and IP.

---

## Rejected Alternatives (and why)

- **Zip the app + a launcher script, send it to the helper's Mac.** Native
  modules (`sharp`, Playwright's Chromium) have to be built per-machine, so
  `npm install` and `npx playwright install chromium` must run fresh on his
  hardware — real download time and a real chance of failure. macOS
  Gatekeeper blocks an unsigned downloaded script on first run regardless.
  There's no update path (every app change means re-zipping and re-sending).
  Live credentials would sit in a plaintext `.env` on a machine we don't
  control. Any failure has to be diagnosed by reading terminal output aloud
  over the phone.
- **Host the frontend (Vercel) and have it drive local Playwright.** A
  browser tab cannot spawn Playwright or touch the filesystem of the machine
  it's running on — that's a browser sandboxing limit, not a hosting
  limit. A local companion agent could receive browser-side calls to
  `localhost`, but it still requires installing and running something
  locally, and adds CORS plus Chrome's Private Network Access permission
  prompt on top, without removing the local-install requirement at all.
- **Literal remote-desktop control** (TeamViewer/AnyDesk) of the operator's
  machine. Works, but full-desktop blast radius (helper can see/touch
  anything on the machine), and built-in Windows Remote Desktop kicks the
  operator off their own session unless using a tool's unattended-access
  mode. Still requires the machine to be on regardless.

---

## Components

### 1. Tailscale (private network)

- Install Tailscale on the operator's Windows machine and the helper's Mac;
  both join the same tailnet.
- MagicDNS gives a friendly hostname (`http://<machine-name>:<port>`)
  instead of a raw IP to remember.
- No port-forwarding, no public exposure — traffic stays inside the private
  tailnet between the two devices.

### 2. Move the app off port 3000

- Port 3000 collides with other local dev work on the operator's machine.
  Run Dealer Intel on a dedicated port instead (e.g. `6565`) via the
  standard Next.js `-p` flag.
- Confirmed: no hardcoded `localhost:3000` references anywhere in the app
  (`src/lib/report.ts` and `src/components/run-live-data.tsx` each contain a
  `3000` that is an unrelated numeric range check / poll interval, not a
  port reference) — changing the port is just a flag, not a code change.
- Run in **production mode** (`npm run build`, then `next start -p 6565`)
  rather than dev mode — steadier for something staying up continuously and
  serving two people. This also means we're not relying on the in-app
  local-inventory auto-spawn in `src/lib/local-inventory-process.ts`, which
  is a guaranteed no-op in production mode anyway (`NODE_ENV === "production"`
  short-circuits it) — NSSM starts both processes explicitly instead (below).

### 3. NSSM — run both processes as real Windows services

- Wrap `next start -p 6565` as a Windows service. Point NSSM directly at the
  `next` binary (`node_modules\.bin\next.cmd`), not through `npm`, so the
  supervised process is the actual Node process rather than an npm wrapper
  around it — cleaner start/stop/restart behavior.
- Wrap the sibling `dealer-inventory-api`'s local start command the same way
  (exact command TBD — see Open Items).
- No application code changes — this is process supervision layered on top
  of commands that already exist today.
- Chosen over PM2: PM2's "run at boot as a Windows service" story needs an
  extra add-on package (`pm2-installer` or similar); NSSM registers directly
  as a native Windows service with no extra glue.

### 4. Windows Firewall

- Add an inbound rule allowing TCP `6565`. Windows will likely block it by
  default, especially if it treats the Tailscale virtual adapter as a
  "Public" network.

### 5. Turn on auth

- Set `ENABLE_AUTH=true` with `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` so
  the helper logs into the app like a normal website, rather than an open,
  unauthenticated admin panel sitting on the tailnet.

### 6. Keep the machine awake

- Disable sleep on the operator's machine, at least during hours the helper
  might use it. There is no software fix for a sleeping or powered-off
  machine — this is the one genuinely manual, ongoing cost of this approach.

---

## Operating Model (using it together)

- The operator and the remote helper use the **same running instance** —
  same URL, different browser/computer. Do **not** run a second separate
  `npm run dev`/`start` against the same database: a second process would
  carry its own independent in-memory run-execution state
  (`src/lib/run-executor.ts`'s `activeRuns` Set is per-process, not
  per-database), and could double-drive the same run if both processes ever
  touched it — risking two Playwright sessions scraping the same dealer
  sites simultaneously, which risks triggering the very blocking this setup
  exists to avoid.
- Starting two *different* runs at the same time (different site groups) is
  safe — the run-executor's concurrency guard and all mission/evidence
  writes are scoped by `runId`.
- The real constraint is machine resources, not correctness: each run can
  open up to `COLLECTOR_CONCURRENCY` (default 5) simultaneous Chromium
  sessions. Two people collecting at once means up to double that running
  on one machine.
- Visibility: the operator has no built-in way to see the helper "in the
  app" in real time — this is normal web traffic, not screen-sharing.
  Server request logs are the cheapest signal if that's ever needed; a
  lightweight "last activity" indicator could be added later if wanted.

---

## Open / Unverified

- `dealer-inventory-api`'s actual local start requirements (its own `.env`?
  its own build step?) haven't been checked — that repo isn't in scope for
  this plan. Verify before finalizing its NSSM service definition.
- Confirm login/auth works correctly after the port change with a real test.
- Tune the Windows Firewall rule scope (Tailscale interface only vs. all
  networks) once tested live.

---

## Remote Helper Setup (hand this to him, close to verbatim)

1. Install Tailscale from tailscale.com/download (choose Mac). Sign in when
   it asks, using the invite/account the operator gives you.
2. Open your browser and go to: `http://<machine-name>:6565` — bookmark it.
3. Log in with the username and password the operator gives you.
4. Use the app like any other website. Nothing else to install — no
   terminal, no files to run, no settings to edit.
5. If the page won't load: check that Tailscale says "Connected," then just
   call or text the operator — the app runs on their machine, so it has to
   be turned on and awake for this to work.
