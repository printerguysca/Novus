# Novus — Project Context (Paste this into a new Cowork chat)

You are continuing development on **Novus**, a Warehouse + Office Management System for **Soho Blinds**, a window-blinds manufacturer in Winnipeg, Manitoba. The codebase is in my connected folder at `soho-wms/`. Read the files before making changes — everything described here is already built and deployed.

---

## What Novus Does

End-to-end blind manufacturing workflow: Clients → Quotes (with auto-pricing + PDF generation) → Jobs → Production (cut → assemble → QC → pack) → Installation. Plus inventory management (fabrics, hardware, shipments, transfers), tasks, calendar, and reporting.

---

## Stack & Architecture

- **Backend:** Single `server.js` (~1048 lines) — Node.js + Express, all API endpoints, PDF generation (pdfkit), seed data
- **Frontend:** Vanilla JS SPA — `public/index.html` (~1600+ lines, all UI), `public/login.html`
- **Database:** Supabase (PostgreSQL) — project ID `tntmgwukdzzeknlfmotz`
- **Auth:** Custom JWT (bcryptjs + jsonwebtoken) — NOT Supabase Auth
- **Deployment:** Vercel serverless (`@vercel/node`), auto-deploys on push to main
- **No build step.** No frontend framework. No frontend dependencies.

**Production URL:** https://novus-coral.vercel.app
**GitHub:** https://github.com/printerguysca/Novus.git

---

## Critical Technical Details

### Supabase Client — MUST use this exact config:
```javascript
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
```
The key is a **service_role** key. Without `{ auth: { autoRefreshToken: false, persistSession: false } }`, RLS blocks all operations even with the service_role key. This was a hard-won fix — do not change it.

### Auth Flow:
1. `POST /api/auth/login` → bcrypt compare → returns JWT (12h, payload: `{id, name, email, role}`)
2. Frontend stores token as `localStorage.wms_token`, user as `localStorage.wms_user`
3. All API calls send `Authorization: Bearer <token>` header
4. `requireAuth` middleware verifies JWT; role middlewares: `ownerAdmin`, `ownerAdminSales`, `warehouseRoles`

### Login Query (important pattern):
```javascript
const { data: users } = await supabase.from('users').select('*').eq('email', email.toLowerCase().trim()).eq('active', true).limit(1);
const user = users?.[0];
```
Uses `.limit(1)` + `users?.[0]` instead of `.single()` — because `.single()` throws if duplicate rows exist.

### Vercel Deployment:
- `vercel.json` routes everything to `server.js` via `@vercel/node`
- On Vercel: `module.exports = app` (no `app.listen`)
- Locally: `app.listen(PORT)` on port 3000
- Env vars on Vercel: `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET`
- All three have hardcoded fallbacks in server.js for local dev
- Deploy: `git add . && git commit -m "msg" && git push origin main`

---

## Files

| File | What it is |
|------|-----------|
| `server.js` | All backend: auth, CRUD for every entity, cut calculations, quote math, PDF generation (pdfkit, 2-page layout), production workflow, reports, seed function |
| `public/index.html` | Entire SPA: CSS variables, sidebar nav, all 14+ page views (dashboard, jobs, clients, quotes, production, fabrics, hardware, shipments, transfers, movements, tasks, calendar, users, reports), quote builder with FABRIC_CAT array (63 entries) and price lookup table (13×15 brackets), mobile responsive cards |
| `public/login.html` | Login page with 6 demo account quick-fill buttons |
| `public/favicon.svg` | N blind-slat logo SVG |
| `schema.sql` | Base PostgreSQL schema (16 tables, 12 views) — run in Supabase SQL Editor |
| `migration-quotes.sql` | ALTERs adding enhanced quote columns (markup, upgrades, amount_paid, fabric_code, hc_custom, etc.) — run AFTER schema.sql |
| `vercel.json` | Vercel serverless config |
| `generate-pdf.py` | DEPRECATED — old Python PDF gen, can be deleted |

---

## Database

**16 tables:** users, profiles, fabrics, hardware_items, clients, jobs, job_windows, quotes, quote_items, tasks, calendar_events, shipments, shipment_items, transfers, transfer_items, movements

**12 views:** fabrics_view, hardware_view, jobs_list, job_detail, windows_detail, tasks_detail, calendar_detail, quotes_view, quote_items_view, transfers_view, shipment_items_view, production_queue

**IMPORTANT gaps in schema.sql:**
- `production_queue` view exists in Supabase but is NOT in schema.sql
- Production columns on `job_windows` (`production_status`, `cut_at`, `cut_by`, `assembled_at`, `assembled_by`, `qc_status`, `qc_at`, `qc_by`, `qc_notes`, `packed_at`, `packed_by`) are NOT in schema.sql — they were added directly in Supabase
- `migration-quotes.sql` must be run separately after schema.sql

---

## 6 Roles

| Role | Sees in sidebar |
|------|----------------|
| **owner** | Everything: dashboard, jobs, production, clients, quotes, calendar, tasks, fabrics, hardware, shipments, transfers, movements, reports, users |
| **admin** | Same minus reports. Has user management |
| **sales** | Dashboard, clients, quotes, my jobs, fabric library, calendar, tasks |
| **warehouse** | Dashboard, jobs, production, fabrics, hardware, shipments, transfers, movements, tasks |
| **installer** | Dashboard, my jobs, tasks, calendar |
| **factory** | Dashboard, production queue, production jobs, tasks |

**Demo logins:** owner@soho.ca/owner123, admin@soho.ca/admin123, sales@soho.ca/sales123, warehouse@soho.ca/warehouse123, installer@soho.ca/installer123, factory@soho.ca/factory123

---

## Domain-Specific Logic

### Cut Profiles (A-J):
10 profiles define deduction formulas for blind types. Each has 4 deduction values (cassette, roller, bottom rail, bottom core). `calcCuts()` in server.js computes all cut dimensions, fabric meters, cord/wand size, bracket count from a window's width/height/profile.

### Quote Pricing:
- Price lookup: 13 width brackets × 15 height brackets, hardcoded in frontend `PRICES` array
- Same prices for all blind types (Zebra, Roller, Double Roller, Honeycomb)
- Calculation: `MSRP + markup → apply discount% → add upgrades (motor $200/unit, cordless $50/unit) → apply tax% → TOTAL`
- Double Roller: auto-pairs two rows (front + back fabric)
- Honeycomb: uses `hc_custom` text input instead of fabric dropdown

### Fabric Catalog:
63 coded entries in `FABRIC_CAT` array in index.html (codes like Z1A, R2B-L, S1A). Each has code, label, series.

### Fractions:
Displayed as plain text: 1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8. Both frontend and PDF use this format.

### Number Formats:
- Jobs: `SB-YYYY-NNNN` (e.g., SB-2026-0001)
- Quotes: `QT-YYYY-NNNN`
- Transfers: `TRF-YYYY-NNNN`
- Generated by `genNumber(table, col, prefix)` — reads last row, increments

### Production Workflow:
`pending → cutting → cut → assembling → assembled → qc_pass/qc_fail → packing → packed`
When all windows in a job are `packed`, job status auto-updates to `ready`.

---

## Color Theme

```css
--brand: #0f172a     /* deep navy — sidebar bg, headers */
--accent: #e8580c    /* orange — buttons, active nav, table headers, highlights */
--accent-h: #c2410c  /* orange hover */
--accent-bg: #fff7ed /* light orange tint */
```

Logo: "N" letterform with blind slat motif. Orange slats at varying opacity, N cut out as negative space. Dark rounded rect background (#1e293b).

---

## Known Issues / Security Debt

1. **`/api/reset-all` has NO authentication** — anyone can wipe the DB. Contains hardcoded service_role key. MUST be removed or protected.
2. **Hardcoded credentials in server.js** — Supabase URL, service_role key, and JWT secret are visible in source. Env vars override on Vercel, but they're in the Git history.
3. **RLS is enabled on Supabase** — works with current config but fragile. If env vars are wrong, operations fail silently.
4. **No pagination** on list endpoints — will slow down with scale.
5. **No rate limiting** on login.
6. **No refresh tokens** — JWT is 12h, then you're logged out.
7. **`generate-pdf.py` still in repo** — dead code, can delete.
8. **`production_queue` view and production columns** not captured in schema.sql.

---

## Pending Features (Not Built Yet)

1. **Sales rep data isolation** — Sales currently can see all clients/quotes, should only see their own
2. **Sales commission system** — Track commissions per rep
3. **Installer job assignment** — Assign installers to specific jobs, restrict their view
4. **End-to-end role access testing** — Verify every endpoint respects role boundaries
5. **Remove or protect `/api/reset-all`**
6. **Sync schema.sql** — Add production columns and production_queue view

---

## How to Work on This

1. **Read the actual files first** — `server.js`, `public/index.html`, `public/login.html` contain everything
2. **The folder is `soho-wms/`** in my connected directory
3. **To deploy:** edit files → `git add . && git commit -m "msg" && git push origin main` → Vercel auto-deploys
4. **To test locally:** `cd soho-wms && npm install && npm run dev` → http://localhost:3000 (connects to production Supabase)
5. **All UI is in one HTML file** — index.html. Navigation is `nav('page-name')` which calls render functions like `rDash()`, `rJobs()`, `rQuotes()`, etc.
6. **All backend is in one JS file** — server.js. Sections are clearly marked with comment headers.
