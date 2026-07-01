# Deployment Plan — Dealer Intel Platform

_Created: June 2026_

---

## Goal

Get a live public URL so a dealer client can view a report without logging in.
The URL pattern is `/r/<snapshot-id>` — no nav, no auth, just the report.

---

## Architecture Decision

**Deploy the full monolith to Railway (free Hobby tier).**

- Collections continue to run **locally** on your machine — Playwright/Chromium never fires on the cloud server
- Neon (Postgres) and Cloudflare R2 are already remote/cloud — the deployed app reads the same data
- Once you publish a snapshot locally (via the run page or the `scripts/publish-snapshot.mjs` script), it's immediately visible on the deployed URL
- Free tier RAM is enough for serving reports; Playwright needs 512MB–1GB which would OOM the free tier, so keep collection local

If you later need cloud collection (running unattended overnight), upgrade Railway to a paid instance or move to a $12/mo DigitalOcean 2GB droplet.

---

## Pre-flight Checklist

Before deploying, confirm locally:

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm run lint` passes clean
- [ ] `npm run build` completes successfully
- [ ] `http://localhost:3000/r/8911c65d-c921-4250-8035-ca2b85dddd27` renders the Elmwood Suite report correctly

---

## Step 1 — Push to GitHub

The repo must be on GitHub for Railway to connect to it.

```powershell
# If not already on GitHub:
gh repo create dealer-intel --private --source=. --push

# If already on GitHub, just confirm main is pushed:
git push origin main
```

---

## Step 2 — Create Railway Project

1. Go to [railway.app](https://railway.app) and sign in (GitHub login is easiest)
2. Click **New Project → Deploy from GitHub repo**
3. Select the `dealer-intel` repo
4. Railway will detect Next.js automatically — accept the defaults
5. Do NOT click Deploy yet — set env vars first (Step 3)

---

## Step 3 — Set Environment Variables

In the Railway project dashboard → **Variables** tab, add each of these.
Copy the values from your local `.env` file.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Your Neon connection string |
| `AUTH_SECRET` | Same value as local — keeps admin sessions working |
| `NEXTAUTH_URL` | Set to your Railway domain AFTER it's assigned, e.g. `https://dealer-intel-production.up.railway.app` |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 API token key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET_NAME` | e.g. `dealer-intel-evidence` |
| `R2_PUBLIC_URL` | Public R2 domain for evidence file links |
| `ANTHROPIC_API_KEY` | Optional — omit and AI enrichment is a no-op |

**Note on `NEXTAUTH_URL`:** Railway assigns a domain after first deploy. Set it, then redeploy once (Settings → Redeploy).

---

## Step 4 — Configure Start Command

Railway should auto-detect this from `package.json`, but confirm in Railway's **Settings → Deploy** tab:

- **Build command:** `npm run build`
- **Start command:** `npm run start`

---

## Step 5 — Deploy

Click **Deploy** (or push a commit — Railway auto-deploys on push to main).

Watch the build log. First build takes 3–5 minutes. Common issues:

| Error | Fix |
|---|---|
| `Cannot find module` build error | Check that all imports use `@/` path aliases correctly |
| `DATABASE_URL` connection error | Confirm the Neon connection string is set in Variables |
| Auth redirect loop | Confirm `NEXTAUTH_URL` matches the Railway domain exactly |

---

## Step 6 — Verify

Once deployed:

1. Open `https://<your-railway-domain>/r/8911c65d-c921-4250-8035-ca2b85dddd27`
2. Confirm the Elmwood Suite report loads with no login prompt
3. Open `https://<your-railway-domain>/` — should redirect to login (admin is protected)
4. Log in with your operator credentials → confirm admin UI loads

---

## Step 7 — Share with Dealer

Send the dealer the full URL:
```
https://<your-railway-domain>/r/8911c65d-c921-4250-8035-ca2b85dddd27
```

No account needed on their end. The UUID (122 bits) is the access control — treat it like a private link.

---

## Publishing Future Snapshots

After each local collection + analysis run, publish a snapshot with the script:

```powershell
node --experimental-strip-types scripts/publish-snapshot.mjs
```

The script prints the snapshot ID. Swap the ID in the `/r/<id>` URL and send the new link.

Or use the **Publish Snapshot** button on the run page at `localhost:3000/runs/<id>` — same result.

---

## Upgrade Path

When you need cloud collection (Playwright/Chromium running on the server):

- **Railway paid:** upgrade to Pro plan, set instance to 2GB RAM (~$20/mo)
- **DigitalOcean:** $12/mo 2GB droplet + PM2 + nginx (more setup, cheapest at scale)
  - You already have a DO account — ask Claude to walk through the DO setup when ready

---

## Files Referenced

- `scripts/publish-snapshot.mjs` — bypasses auth to publish a snapshot directly
- `src/app/r/[id]/page.tsx` — public report route (no auth)
- `src/app/r/layout.tsx` — standalone layout (no nav)
- `src/components/report/ReportContent.tsx` — shared report component
- `.env` — source of all secrets (never commit this)
