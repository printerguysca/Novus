# Novus — Code Remediation Spec
*For the chat / developer with repo access (`printerguysca/Novus`, branch `main`, base commit `5bbb5cf`). Line numbers are from that commit; re-locate by symbol if they've drifted. Implement in priority order. The database-side hardening (RLS + view fix) is already done — do not re-do it.*

---

## DONE ALREADY (Supabase side — do not repeat)
- RLS enabled on all 16 public tables. App unaffected (server uses service_role, which bypasses RLS).
- 11 views switched to `security_invoker = on` so they no longer bypass table RLS.
- Verification: all RLS/SECURITY-DEFINER **errors** cleared; only benign `rls_enabled_no_policy` INFO notices remain.

---

## P0 — Delete the unauthenticated DB-wipe endpoint
**File:** `server.js` ~line 101. **Risk:** anyone who hits `GET /api/reset-all` wipes 9 tables incl. `users`.

Delete the entire `app.get('/api/reset-all', ...)` handler. It is a dev seeding tool and must not exist in a deployed app. If you want to keep a seeding path for local dev, gate it so it cannot run in production AND requires auth, e.g.:

```js
app.get('/api/reset-all', requireAuth, ownerAdmin, async (req, res) => {
  if (process.env.ALLOW_RESET !== 'true') return res.status(403).json({ error: 'Disabled' });
  // ...existing body...
});
```
But deleting it outright is the safer default.

## P0 — Rotate and de-hardcode the service-role key
**Files:** `server.js:13` (global), `~106` (inside reset-all — removed by step above), `~1092` (`seed()`).

The key is in git history in plaintext and valid until 2036, so **rotation is mandatory — moving it to an env var is not enough.**

1. Supabase → Settings → API → roll the `service_role` key.
2. Set the new value as `SUPABASE_KEY` in Vercel (Production + Preview).
3. Remove every hardcoded fallback. Fail fast instead of silently running on a baked-in key:

```js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_KEY');
```
4. Delete the duplicate hardcoded client in `seed()` — have it reuse the global `supabase` client.

## P0 — Strong JWT secret
**File:** `server.js:10`. Current default `'soho-blinds-secret-2026'` lets anyone forge an owner token.

```js
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('Missing JWT_SECRET');
```
Generate a random 256-bit value (`openssl rand -base64 32`) and set it as `JWT_SECRET` in Vercel. Note: rotating this invalidates all existing sessions (users re-login) — expected.

## P1 — Add role checks to 4 write endpoints
These have `requireAuth` but no role gate, so installer/factory accounts can mutate anything. Add the existing `requireRole` middleware.

| File:line | Endpoint | Add |
|---|---|---|
| `server.js:289` | `PATCH /api/jobs/:id` | suggest `ownerAdminSales` (or `ownerAdmin` if reps shouldn't edit jobs) |
| `server.js:305` | `POST /api/jobs/:id/windows` | `ownerAdminSales` |
| `server.js:326` | `DELETE /api/windows/:id` | `ownerAdmin` |
| `server.js:977` | `PATCH /api/windows/:id/production` | `requireRole('owner','admin','factory')` — factory needs this one |

Example:
```js
app.patch('/api/jobs/:id', requireAuth, ownerAdminSales, async (req, res) => { /* ... */ });
app.patch('/api/windows/:id/production', requireAuth, requireRole('owner','admin','factory'), async (req, res) => { /* ... */ });
```
Confirm the production-status transition (cut/assemble/QC/pack) is still allowed for the `factory` role after gating — that's the one role that legitimately needs `:id/production`.

## P2 — Fix the blind-type source inconsistency in `calcCuts`
**File:** `server.js:36–78`. **Bug:** `cut_fabric_drop` follows `blind_type`, but `cut_bottom_core` and `fabric_meters` follow the fabric-code prefix. If they disagree (e.g. `blind_type='Roller'` + a `Z`/`S` fabric) you get a roller drop with a zebra bottom-core and doubled meters. *Currently fires on 0 real rows — latent, fix before scaling.*

Pick ONE source of truth and use it for drop, meters, AND bottom core. Recommended: derive type once, then branch consistently:

```js
// One canonical type for the whole calc:
const blindTypeRaw = (w.blind_type || '').toLowerCase();
const prefixIsZS = (prefix === 'Z' || prefix === 'S');
const isZebra = blindTypeRaw === 'double roller' ? prefixIsZS
              : blindTypeRaw ? (blindTypeRaw === 'zebra' || blindTypeRaw === 'sheer')
              : prefixIsZS;

const cut_bottom_core = (p.bc && isZebra) ? round4(tw + p.bc) : 0;
const cut_fabric_drop = isZebra ? round4(tl + (fabric?.slat_size || 3)/2 - 0.625)
                                : round4(tl + 6);
const fabric_meters   = round4(isZebra ? cut_fabric_drop*0.0254*2 : cut_fabric_drop*0.0254);
```
Better still: add UI validation so a user can't pick `blind_type='Roller'` with a `Z`/`S` fabric (or vice versa) in the first place. Mirror the same single-source logic in `lc()` and `csvCalcRow()` in `index.html`.

## P2 — Resolve profile-H bottom core (NEEDS A HUMAN DECISION, then data fix)
History: H bottom-core offset was `-0.875` at launch, changed to `-1.0625` on June 24 (commit `05fa2d5`). **18 existing windows still hold values computed with the old `-0.875`.** Code now says `-1.0625`.

**Do not blanket-run "Recalculate Cuts" until someone on the shop floor confirms which deduction is physically correct** for the 2026 Combi Flat Case cassette. If you recalc with the wrong offset, you bake a wrong value into all 18 windows. Once confirmed:
- If `-1.0625` is correct → run `POST /api/jobs/:id/recalculate` on affected jobs.
- If `-0.875` is correct → fix the `H` entry in the `P` table back to `-0.875` first, then recalc.

---

## Suggested commit sequence
1. `security: remove reset-all endpoint`
2. `security: require env-provided Supabase + JWT secrets, drop hardcoded fallbacks` (deploy only after rotating keys + setting Vercel env vars)
3. `security: add role checks to job/window write endpoints`
4. `fix: single source of truth for blind type in calcCuts`
5. (after shop-floor confirmation) `fix: profile H bottom-core offset` / recalc

## Caller-side TODO (cannot be done in code, you must do these)
- Rotate the Supabase service_role key in the dashboard.
- Set `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET` in Vercel env vars before deploying step 2.
- Get the correct profile-H bottom-core deduction from the shop floor.
