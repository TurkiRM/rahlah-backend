# Rahlah — Backend API

The shared brain behind the Rahlah shuttle: the seat/gender matching engine, real accounts
for captains/customers/supervisors, push notifications, and the WebSocket feed that keeps
every app in sync live. This repo is **API-only** — no HTML, no UI. The three frontends
live in their own repos and talk to whatever URL you deploy this to:

- [rahlah-customer](../rahlah-customer)
- [rahlah-captain](../rahlah-captain)
- [rahlah-supervisor](../rahlah-supervisor)

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

The server prints its URL and, on first run, a bootstrapped supervisor username/password
to the console — save that, there's no other way to see it after the fact besides
resetting the account file.

## Files

```
server.js         Express + WebSocket server, all the API routes
matching.js       The seat/gender rules — the ONE place this logic lives
auth.js           Shared account/session/password-hashing kit (captain, customer, supervisor)
db.js             Persistence — Postgres if DATABASE_URL is set, else a local JSON file
push.js           Web Push (VAPID) for off-duty captain notifications
```

## Storage: set DATABASE_URL once real accounts exist

Without `DATABASE_URL`, this falls back to `data/db.json` on local disk — fine for
development, but **data doesn't survive a restart on a host with an ephemeral filesystem**
(Render's free tier, for one). Once real captains and customers are signing up, set
`DATABASE_URL` to a Postgres connection string and everything (accounts, sessions, trip
history, active cars) survives restarts and redeploys instead.

This was tested directly, not just written: a captain account was registered, the process
was fully killed (simulating a Render restart), and the same account logged in successfully
after the process came back up, loading straight from Postgres.

The whole app state is stored as a single JSON blob in one `app_state` table — not a full
relational schema. That's a deliberate tradeoff: `matching.js` and `server.js` are built
around simple in-memory object mutation, and rewriting every operation into individual SQL
queries would be a much larger, riskier change for a small operation like this one. This
gets you real durability without that rewrite. Move to a proper relational schema once you
need things a JSON blob can't do well — ad-hoc SQL reporting, multiple server instances
reading/writing concurrently, or a dataset too large to load into memory in one piece.

**Where to get a free Postgres database:** Render's own free Postgres tier expires 30 days
after creation. [Neon](https://neon.tech) and [Supabase](https://supabase.com) both offer
Postgres with an always-free tier that doesn't expire — either works fine here, just copy
the connection string they give you into `DATABASE_URL`.

## Accounts

All three roles are now real, persistent accounts — not session-only:

- **Captains** register with phone + password + name + plate (`POST /api/captain/register`),
  then log in (`POST /api/captain/login`) to get a 30-day session token. Earnings and trip
  history live on the account forever, not reset each time they go online/offline.
- **Customers** register with phone + password + name + gender
  (`POST /api/customer/register`). Booking endpoints require a valid customer token —
  bookings and trip history are tied to the account, and `GET /api/customer/me` returns
  their in-progress ride if they refresh mid-trip.
- **Supervisors** don't self-register. Exactly one account is bootstrapped on first run
  from `SUPERVISOR_USERNAME`/`SUPERVISOR_PASSWORD` env vars (or a random password,
  printed to the console, if you don't set one). There's currently no UI to add more
  supervisor accounts — that's a fair next addition if more than one person needs access.

All passwords are bcrypt-hashed (`bcryptjs`, pure JS, no native build step). Sessions are
opaque random tokens stored server-side (not JWTs) — simpler, and trivially revocable.

## CORS

Since the frontends are deployed separately from this API, CORS is open by default
(`origin: true`, which reflects the request's origin — works with any frontend URL without
needing to know it in advance). Set `ALLOWED_ORIGINS` (comma-separated) in the environment
to restrict this to your actual frontend URLs once you know them.

## Deploying

See `DEPLOY.md` for the full Render walkthrough, including why `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY` need to be set as env vars (not left to auto-generate) on any host with
an ephemeral filesystem.

## What's still needed before this is a public product

- **Real phone verification** — registration takes any phone number at face value right
  now, no SMS OTP. Fine for testing, not for launch.
- **Payments** — fares are tracked as numbers; nothing charges a card or wallet.
- **Real GPS/maps** — cars have a direction (A→B or B→A), not live location.
- **A real database** — `data/db.json` works for one process; move to Postgres before
  running more than one server instance or needing real durability.
- **TGA licensing** — passenger transport in Saudi Arabia is regulated; check requirements
  before operating.
