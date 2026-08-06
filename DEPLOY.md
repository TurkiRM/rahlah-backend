# Deploying the Rahlah backend — GitHub → Render

This repo is the **backend API only**. The customer, captain, and supervisor apps are
separate repos, each deployed as its own Render Static Site — see their READMEs for that
half. Deploy this one first, since the others need its URL.

## 1. Push the code to GitHub

```bash
cd rahlah-backend
git init
git add .
git commit -m "Rahlah backend"
```

Create a new (empty) repository on github.com — don't let GitHub add a README, since you
already have one — then:

```bash
git remote add origin https://github.com/<your-username>/rahlah-backend.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules/` and everything under `data/` except the
placeholder file, so no generated secrets or local state get committed.

## 2. Create the Render service

Go to [render.com](https://render.com), sign up/log in, then:

1. **New +** → **Blueprint**
2. Connect your GitHub account and pick the `rahlah-backend` repo
3. Render reads `render.yaml` automatically and proposes a free web service — confirm it

(If you'd rather not use the blueprint: **New +** → **Web Service** → pick the repo →
Build Command `npm install` → Start Command `npm start` → Free plan. Same result.)

## 3. Set the environment variables

Render will prompt for the variables listed in `render.yaml` since they're marked
`sync: false` (meaning: don't commit a value, ask for it). Use these:

- **SUPERVISOR_USERNAME** / **SUPERVISOR_PASSWORD** — pick your own. This is the one
  supervisor account, bootstrapped on first boot. If you leave `SUPERVISOR_PASSWORD`
  blank, one gets generated and printed to the Render logs instead — set it explicitly so
  it doesn't change on every restart.
- **VAPID_PUBLIC_KEY** / **VAPID_PRIVATE_KEY** — a keypair was already generated for you:

  ```
  VAPID_PUBLIC_KEY=BKX6BVeZMXu4hABNlaydQXnCrmXUu2g9UvgFPXCCP2nH4cguZ_AuG_THniIWYCeR95X7Dof4vWVF_opB3RfG0Y4
  VAPID_PRIVATE_KEY=lzDD8R96U5oM-YAMX50djMJGcx2qcl98uwiuN2gaxNI
  ```

  Setting these (instead of leaving them blank) matters — see below. Keep the private key
  secret; treat it like a password.

- **ALLOWED_ORIGINS** — optional. Once your three frontend URLs are live, set this to a
  comma-separated list of them (e.g.
  `https://rahlah-customer.onrender.com,https://rahlah-captain.onrender.com,https://rahlah-supervisor.onrender.com`)
  to restrict which sites can call this API. Leave unset while you're still testing —
  CORS defaults to allowing any origin.

Deploy. Render gives you a URL like `https://rahlah-backend.onrender.com` — that's the
value to paste into `CONFIGURED_API_BASE` in each of the three frontend repos before
deploying them.

## Why the VAPID/supervisor env vars matter (free-tier filesystem is ephemeral)

Render's free web services don't keep disk changes between restarts — and a free service
also spins down after 15 minutes of no traffic, then cold-starts again on the next
request. Every one of those restarts wipes anything the app wrote to disk.

If `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are **not** set, the app falls back to
generating a fresh keypair into `data/vapid.json` on boot — which then gets silently
wiped and regenerated on the next restart, invalidating every captain's push
subscription without any error message. Setting the env vars avoids that entirely.

**`data/db.json`** (accounts, active cars, trip history) doesn't have an env-var escape
hatch — it's operational data, not a secret. On the free tier this resets on every
restart/spin-down: everyone would need to re-register. Fine for testing; before this runs
a real operation, move to Render's **Starter** plan (no spin-down) with a **persistent
disk**, or migrate `db.js` to a real database (Render has managed Postgres).

## Adding a domain later

Once you've bought a domain: in the Render dashboard, open the service → **Settings** →
**Custom Domains** → add it. Do this for all four services (backend + three frontends) as
you get to them — each gets its own subdomain, e.g. `api.yourapp.com`,
`ride.yourapp.com`, `drive.yourapp.com`, `ops.yourapp.com`.
