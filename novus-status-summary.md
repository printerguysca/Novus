# Novus — Status Summary
*Prepared June 24, 2026. No changes were made to the database or code. This is a read-only assessment.*

**Project:** Novus — Soho Blinds internal WMS · Supabase ref `tntmgwukdzzeknlfmotz` (us-west-2, healthy) · Vercel `novus` (team printerguysca) · Repo `printerguysca/Novus` @ `5bbb5cf`

**Architecture (verified):** Express API on Vercel + vanilla-JS SPA + Supabase Postgres. Custom JWT auth (no Supabase Auth — `auth.users` is empty). The browser never calls Supabase; the server uses the **service-role key** for every query, which bypasses RLS.

---

## Security — all confirmed live at HEAD, none fixed

| # | Issue | Evidence | Severity |
|---|---|---|---|
| 1 | `GET /api/reset-all` is unauthenticated and wipes 9 tables incl. `users` | server.js:101, no middleware | **Critical** |
| 2 | Service-role key hardcoded (3 places) and in git history in plaintext; valid until 2036 | server.js:13, 106, ~1092 | **Critical** |
| 3 | `JWT_SECRET` defaults to `'soho-blinds-secret-2026'` | server.js:10 | **High** |
| 4 | 4 write endpoints have no role check — any logged-in user (incl. installer/factory) can edit jobs, add/delete windows, change production status | PATCH /jobs/:id (289), POST /jobs/:id/windows (305), DELETE /windows/:id (326), PATCH /windows/:id/production (977) | **High** |
| 5 | RLS disabled on all 16 tables | Supabase linter | **Low** (anon key isn't distributed; defense-in-depth) |

Only `reset-all` and `login` lack auth; `login` is intentional. No other exposed routes.

## Cut-formula findings (from live data)

- **Width math (cassette / roller / bottom rail / fabric width): correct.** Re-derived against real rows for profiles A, B, H — all match to 1/16".
- **Profile-H bottom core is inconsistent.** Code now uses offset **−1.0625**; **18 windows** hold the older **−0.875** value (changed June 24 in commit `05fa2d5`, existing jobs never recalculated). Which value is *physically* correct is unknown from code.
- **Latent type bug:** in `calcCuts`, fabric drop follows `blind_type` while bottom-core and fabric-meters follow the fabric-code prefix. If they disagree, the cut is internally inconsistent. **Currently fires on 0 real rows** — latent, not active.
- **Data is mostly seed:** only 2 of 28 windows have a real fabric link. System isn't in heavy production use yet.

## Critical instruction

**Do NOT run "Recalculate Cuts" yet.** It would overwrite the 18 stale H bottom-core values with −1.0625. If that number is wrong, you turn a stale-data problem into a uniformly-wrong-data problem. **Confirm the correct profile-H (2026 Combi Flat Case) bottom-core deduction with the shop floor first.**

## Open actions you must do (neither chat can see these)

1. **Supabase → Settings → API:** has the service-role key been rotated? If not, rotate it (invalidates the copies in git history).
2. **Vercel → Settings → Environment Variables:** are `SUPABASE_KEY` and `JWT_SECRET` set? If not listed, the hardcoded fallbacks are live in production right now.
3. **Shop floor:** confirm the correct H bottom-core value (−1.0625 vs −0.875).

## Recommended remediation order (when you're ready)

1. Delete `reset-all`; rotate the service key. 2. Set a strong `JWT_SECRET` in Vercel env. 3. Add role checks to the 4 open write endpoints. 4. Resolve the H offset, then recalculate. 5. Enable RLS (safe to apply from the Supabase side — service_role bypasses it).

*Code fixes (1–4) → repo, fastest via the chat with repo access. Supabase hardening (5) and key-rotation guidance → can be done from this chat on request.*
