# Novus — Complete Project Handoff

## Overview

**Novus** (formerly "SohoBlinds WMS") is a full Warehouse + Office Management System for **Soho Blinds**, a window-blinds manufacturer in Winnipeg, Manitoba. It manages the entire workflow: clients → quotes → jobs → production → installation.

**Production URL:** https://novus-coral.vercel.app
**GitHub:** https://github.com/printerguysca/Novus.git
**Supabase project ID:** `tntmgwukdzzeknlfmotz`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express (single `server.js` file, ~1048 lines) |
| Frontend | Vanilla JS SPA (`public/index.html` ~1600+ lines, `public/login.html`) |
| Database | Supabase (PostgreSQL) |
| Auth | Custom JWT — bcryptjs + jsonwebtoken (NOT Supabase Auth) |
| PDF | pdfkit (JavaScript) — replaced Python reportlab for Vercel compatibility |
| Deployment | Vercel serverless via `@vercel/node` |

---

## File Structure

```
soho-wms/
├── server.js              # Express backend — all API endpoints, PDF gen, seed
├── vercel.json            # Vercel config: builds + routes
├── package.json           # name: "novus", deps: express, supabase, bcryptjs, jwt, pdfkit
├── .gitignore             # node_modules, .env, *.pdf, .vercel, .DS_Store
├── schema.sql             # Full PostgreSQL schema for Supabase
├── migration-quotes.sql   # ALTERs for enhanced quote builder columns
├── generate-pdf.py        # DEPRECATED — old Python PDF gen, no longer used
├── public/
│   ├── index.html         # Main SPA — all UI sections
│   ├── login.html         # Login page with demo account buttons
│   └── favicon.svg        # N blind-slat logo mark
```

---

## Authentication

**Custom JWT auth** — does NOT use Supabase Auth at all.

### How it works:
1. User submits email/password to `POST /api/auth/login`
2. Server queries `users` table, compares bcrypt hash
3. Returns JWT token (12h expiry) with payload: `{ id, name, email, role }`
4. Frontend stores token in `localStorage` as `wms_token`
5. All subsequent API calls include `Authorization: Bearer <token>` header
6. `requireAuth` middleware verifies JWT on every protected route

### Supabase Client Config (CRITICAL):
The Supabase client uses the **service_role** key (not anon key) and must have these auth options to bypass RLS:
```javascript
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
```
Without `{ auth: { autoRefreshToken: false, persistSession: false } }`, the service_role key doesn't properly bypass RLS.

### Environment Variables (Vercel):
- `SUPABASE_URL` = `https://tntmgwukdzzeknlfmotz.supabase.co`
- `SUPABASE_KEY` = service_role key (starts with `eyJhbGciOi...`)
- `JWT_SECRET` = `soho-blinds-secret-2026`

All three have hardcoded fallbacks in server.js for local dev.

### Demo Accounts:
| Email | Password | Role |
|-------|----------|------|
| owner@soho.ca | owner123 | owner |
| admin@soho.ca | admin123 | admin |
| sales@soho.ca | sales123 | sales |
| warehouse@soho.ca | warehouse123 | warehouse |
| installer@soho.ca | installer123 | installer |
| factory@soho.ca | factory123 | factory |

---

## Role-Based Access Control

6 roles with middleware enforcement:

| Role | Access |
|------|--------|
| **owner** | Everything — dashboard revenue, reports, user management, all modules |
| **admin** | Everything except reports/revenue. Can manage users, calendar, jobs, tasks |
| **sales** | Clients, quotes, jobs (own only). Can create/edit quotes, generate PDFs |
| **warehouse** | Fabrics, hardware, shipments, transfers, production. Inventory management |
| **installer** | Calendar (own events), jobs with status `ready` or `installed` |
| **factory** | Production queue, jobs with status `in_production` |

### Middleware helpers:
- `requireAuth` — verifies JWT on all routes
- `ownerAdmin` — `requireRole('owner','admin')`
- `ownerAdminSales` — `requireRole('owner','admin','sales')`
- `warehouseRoles` — `requireRole('owner','admin','warehouse')`

### Pending RBAC work (NOT YET IMPLEMENTED):
- Sales commission system
- Sales rep data isolation (sales should only see their own clients/quotes)
- Installer job assignment and access restrictions
- Full end-to-end role verification

---

## Database Schema

### Tables (14 total):

1. **users** — id, name, email, password_hash, role (enum), active, created_at
2. **profiles** — id, code (A-J), blind_type, cassette_ded, roller_ded, bottom_rail_ded, bottom_core_ded, description
3. **fabrics** — id, catalogue_no (unique), series, alias, colour_hex, slat_size, roll_qty, total_meters, used_meters, wastage_factor, active
4. **hardware_items** — id, category, item_code, description, unit, total_qty, used_qty, wastage_factor, active
5. **clients** — id, name, address, contact, phone, email, notes, created_at
6. **jobs** — id, job_number (unique, format SB-YYYY-NNNN), client_id FK, rep, rep_id FK→users, status, date_in, date_due, notes
7. **job_windows** — id, job_id FK→jobs (CASCADE), window_no, location, fabric_id FK, profile_code, cassette_colour, width/length (in + frac), control_type, lr_side, mount_type, notes, all cut_* columns, fabric_meters, cord_wand_size, bracket_count, production tracking columns
8. **quotes** — id, quote_number (unique, format QT-YYYY-NNNN), client_id FK, created_by FK→users, status, subtotal, discount_pct, tax_pct, total, notes, valid_until, job_id FK, markup, upgrades, amount_paid, discount_reason, hide_prices, customer_notes, terms
9. **quote_items** — id, quote_id FK→quotes (CASCADE), location, fabric_id FK, fabric_code, hc_custom, blind_type, width/length, qty, unit_price, line_total, discount_pct, cassette_colour, control_type, lr_side, mount_type
10. **tasks** — id, title, description, assigned_to FK→users, created_by FK→users, job_id FK, priority, status, due_date
11. **calendar_events** — id, title, event_type, job_id FK, assigned_to FK→users, start_date, end_date, notes, created_by FK→users
12. **shipments** — id, supplier, reference, date_received, notes
13. **shipment_items** — id, shipment_id FK→shipments (CASCADE), item_type, item_id, qty_received, notes
14. **transfers** — id, transfer_no (unique, format TRF-YYYY-NNNN), from_location, to_location, job_id FK, notes, status, completed_at
15. **transfer_items** — id, transfer_id FK→transfers (CASCADE), item_type, item_id, item_name, qty
16. **movements** — id, item_type, item_id, item_name, movement_type, qty, job_id, shipment_id, notes (audit log)

### Views (12):
- **fabrics_view** — fabrics + calculated `remaining` column
- **hardware_view** — hardware_items + calculated `remaining`
- **jobs_list** — jobs + client_name, client_address, window_count
- **job_detail** — jobs + client info
- **windows_detail** — job_windows + fabric info + profile info
- **tasks_detail** — tasks + assigned_name, creator_name, job_number
- **calendar_detail** — calendar_events + job_number, client_name, assigned_name
- **quotes_view** — quotes + client_name, client_address, client_phone, client_email, rep_name
- **quote_items_view** — quote_items + fabric_alias, colour_hex, catalogue_no
- **transfers_view** — transfers + job_number
- **shipment_items_view** — shipment_items + fabric/hardware details
- **production_queue** — (must exist in Supabase but is NOT in schema.sql — likely created manually or needs migration)

### Migration Required:
`migration-quotes.sql` adds these columns that are NOT in the base schema.sql:
- quotes: customer_notes, terms, markup, upgrades, amount_paid, discount_reason, hide_prices
- quote_items: discount_pct, cassette_colour, control_type, lr_side, mount_type, fabric_code, hc_custom
- Updated quotes_view and quote_items_view

**IMPORTANT:** The `production_queue` view is referenced in server.js (`/api/production` and `/api/production/stats`) and also the `production_status`, `cut_at`, `cut_by`, `assembled_at`, `assembled_by`, `qc_status`, `qc_at`, `qc_by`, `qc_notes`, `packed_at`, `packed_by` columns on `job_windows` — these are NOT in schema.sql. They were likely added via separate migration or directly in Supabase. If setting up fresh, you'll need to add these columns to job_windows and create the production_queue view.

---

## API Endpoints

### Auth
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | `/api/auth/login` | None | Any | Login with email/password, returns JWT |
| GET | `/api/auth/me` | Yes | Any | Get current user info |

### Users
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/users` | Yes | owner, admin | List all users |
| POST | `/api/users` | Yes | owner, admin | Create user |
| PATCH | `/api/users/:id` | Yes | owner, admin | Update user (inc. password) |
| DELETE | `/api/users/:id` | Yes | owner | Soft-delete (sets active=false) |

### Dashboard
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/dashboard` | Yes | Any | Job counts, recent jobs, low fabric alerts, my tasks, revenue (owner only) |

### Profiles
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/profiles` | Yes | Any | List cut profiles A-J |

### Clients
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/clients` | Yes | owner, admin, sales | List clients |
| POST | `/api/clients` | Yes | owner, admin, sales | Create client |
| PATCH | `/api/clients/:id` | Yes | owner, admin, sales | Update client |

### Jobs
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/jobs` | Yes | Any (filtered by role) | List jobs — sales sees own, installer sees ready/installed, factory sees in_production |
| GET | `/api/jobs/:id` | Yes | Any | Get job detail with windows |
| POST | `/api/jobs` | Yes | owner, admin, sales | Create job (auto-generates SB-YYYY-NNNN) |
| PATCH | `/api/jobs/:id` | Yes | Any | Update job status/details |
| DELETE | `/api/jobs/:id` | Yes | owner, admin | Delete job (cascades windows) |

### Job Windows
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | `/api/jobs/:job_id/windows` | Yes | Any | Add window — auto-calculates cuts |
| DELETE | `/api/windows/:id` | Yes | Any | Delete window |

### CSV Import
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | `/api/jobs/import` | Yes | Any | Bulk import: creates client, job, windows, optional quote |

### Quotes
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/quotes` | Yes | owner, admin, sales | List quotes with items (sales sees own) |
| GET | `/api/quotes/:id` | Yes | owner, admin, sales | Get single quote with items |
| POST | `/api/quotes` | Yes | owner, admin, sales | Create quote (auto QT-YYYY-NNNN) |
| PUT | `/api/quotes/:id` | Yes | owner, admin, sales | Full update (replaces items) |
| PATCH | `/api/quotes/:id` | Yes | owner, admin, sales | Partial update (status/notes/discount) |
| POST | `/api/quotes/:id/convert` | Yes | owner, admin | Convert quote to job |

### PDF Generation
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/quotes/:id/pdf?type=quote|invoice` | Yes | owner, admin, sales | Generate and download PDF |

### Tasks
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/tasks` | Yes | Any (filtered) | List tasks — owner/admin see all, others see own |
| POST | `/api/tasks` | Yes | Any | Create task |
| PATCH | `/api/tasks/:id` | Yes | Any | Update task |
| DELETE | `/api/tasks/:id` | Yes | Any | Delete task |

### Calendar
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/calendar?month=&year=` | Yes | Any (filtered) | List events — installer/factory see own |
| POST | `/api/calendar` | Yes | owner, admin | Create event |
| PATCH | `/api/calendar/:id` | Yes | owner, admin | Update event |
| DELETE | `/api/calendar/:id` | Yes | owner, admin | Delete event |

### Fabrics
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/fabrics` | Yes | Any | List active fabrics |
| POST | `/api/fabrics` | Yes | owner, admin, warehouse | Add fabric |
| PATCH | `/api/fabrics/:id` | Yes | owner, admin, warehouse | Update fabric |

### Hardware
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/hardware` | Yes | Any | List active hardware |
| POST | `/api/hardware` | Yes | owner, admin, warehouse | Add hardware item |
| PATCH | `/api/hardware/:id` | Yes | owner, admin, warehouse | Update hardware |

### Shipments
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/shipments` | Yes | owner, admin, warehouse | List shipments with items |
| POST | `/api/shipments` | Yes | owner, admin, warehouse | Create shipment (auto-updates fabric/hardware quantities) |

### Transfers
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/transfers` | Yes | Any | List transfers |
| POST | `/api/transfers` | Yes | owner, admin, warehouse | Create transfer |
| PATCH | `/api/transfers/:id/complete` | Yes | Any | Mark transfer completed |
| DELETE | `/api/transfers/:id` | Yes | owner, admin, warehouse | Delete transfer |

### Movements
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/movements` | Yes | owner, admin, warehouse | Audit log (last 200) |

### Production
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/production` | Yes | Any | Production queue |
| GET | `/api/production/stats` | Yes | Any | Production status counts |
| PATCH | `/api/windows/:id/production` | Yes | Any | Advance production: start_cut → finish_cut → start_assemble → finish_assemble → qc_pass/qc_fail → start_pack → finish_pack (or rework) |

### Cut Sheet
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/jobs/:id/cutsheet` | Yes | Any | Job detail + windows for cut sheet view |

### Reports (Owner only)
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/reports` | Yes | owner | Jobs by status, by rep, top clients, quote revenue, monthly trend |

### Debug/Admin (REMOVE FOR PRODUCTION)
| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | `/api/reset-all` | **NONE** | **NONE** | Nuclear reset — wipes ALL data, recreates 6 demo users. Has hardcoded service_role key. **MUST BE REMOVED OR PROTECTED.** |

---

## Cut Calculation System

10 profiles (A-J) define deduction formulas for different blind/cassette combinations:

```
Profile A: Flat Zebra + Regular Clutch + Wands + S. Cord
Profile B: Flat Zebra + 1cm Clutch + Wands + S. Cords + Motor
Profile C: Round Combi (White only) + Zebra + 1cm Clutch + Motors
Profile D: Cordless mechanism
Profile E: Roller without cassette — Regular clutch only
Profile F: Roller + Flat Cassette + Heavy Rail + Regular Clutch
Profile G: Roller + Flat Cassette + 1cm Clutch + Motor
Profile H: 2026 Combi Flat Case + Dual Rollers
Profile I: Flat Zebra + Tubular Motor
Profile J: Flat Roller + Tubular Motor
```

Each profile has 4 deduction values: cassette (c), roller (r), bottom rail (br), bottom core (bc).

The `calcCuts()` function computes:
- **cut_cassette** = total_width + profile.c
- **cut_roller** = total_width + profile.r
- **cut_bottom_rail** = total_width + profile.br
- **cut_bottom_core** = total_width + profile.bc (0 if bc is 0)
- **cut_fabric_width** = cut_bottom_rail - 0.0625
- **cut_fabric_drop** = varies by cassette colour (mill vs regular)
- **fabric_meters** = converted from inches, doubled for Zebra/Screen fabrics
- **cord_wand_size** = S/M/L based on length (none for motor)
- **bracket_count** = 3 if width > 59", else 2

---

## Quote & Pricing System

### Blind Types:
- Zebra, Roller, Double Roller, Honeycomb

### Fabric Catalog (Frontend):
63 coded entries in `FABRIC_CAT` array in index.html:
- Codes like Z1A, Z1B, R2B-L, S1A, etc.
- Each has: code, label, series info
- Honeycomb type uses custom text input (`hc_custom`) instead of fabric selection

### Price Lookup:
- 13 width brackets × 15 height brackets (hardcoded in frontend)
- Same price table for all blind types
- Width brackets: 17-23, 23.125-29, 29.125-35, ... up to 119.125-127
- Height brackets: 12-24, 24.125-36, 36.125-48, ... up to 180.125-192

### Quote Calculation:
```
MSRP = sum of (unit_price × qty) per item (with per-item discount)
After markup: MSRP + markup amount
After discount: × (1 - discount_pct/100)
Plus upgrades: + upgrades (motor $200/unit, cordless $50/unit)
Tax: × (1 + tax_pct/100)
= TOTAL
```

### Double Roller:
- Auto-pairs two rows (front + back fabric) under one quote line
- Uses special pairing logic in the frontend quote builder

### PDF Output:
- 2-page layout using pdfkit
- Page 1: SOHO BLINDS logo (circle grid), quote/invoice header, bill-to section, line items table, financial summary
- Page 2: Terms & Conditions — Changes, Warranty (10yr mechanical, 1yr motor), Payment, customer acknowledgment bullets, initial line
- Orange accent color throughout

---

## Frontend Architecture

### Single Page Application:
The entire UI is in `public/index.html` (~1600+ lines). Navigation is handled by showing/hiding `<section>` elements.

### Sections (sidebar nav):
1. **Dashboard** — stat cards (jobs, clients, revenue), recent jobs table, low fabric alerts, my tasks
2. **Jobs** — list, detail view, add/edit forms, status progression
3. **Cut Sheets** — per-job cut data view for factory floor
4. **Clients** — CRUD list
5. **Quotes** — builder with fabric selection, pricing, discounts, PDF download
6. **Tasks** — Kanban-style or list view, priority levels
7. **Calendar** — monthly view, event types (install, measure, delivery, other)
8. **Production** — factory workflow: pending → cutting → cut → assembling → assembled → QC → packing → packed
9. **Inventory: Fabrics** — stock levels, remaining meters with wastage
10. **Inventory: Hardware** — stock levels by category
11. **Shipments** — receiving inventory, auto-updates quantities
12. **Transfers** — warehouse-to-job material transfers
13. **Users** — (owner/admin) user management
14. **Reports** — (owner) charts and stats

### Color Theme:
```css
--brand: #0f172a   (deep navy — sidebar, headers)
--accent: #e8580c  (orange — buttons, active nav, table headers, highlights)
--accent-h: #c2410c (orange hover)
--accent-bg: #fff7ed (light orange background)
```

### Mobile Responsive:
- Cards layout for ≤768px (table hidden, card view shown)
- Touch-friendly: 16px fonts, 44px minimum button heights
- Sidebar slides in/out with hamburger menu
- Overlay backdrop when sidebar is open

### Fractions:
Displayed as plain text: 1/8, 1/4, 3/8, 1/2, 5/8, 3/4, 7/8 (not Unicode characters)

---

## Logo

The Novus logo is an "N" letterform with blind slat motif — horizontal slats at varying opacity create a gradient effect behind the N shape. The N itself is cut out as negative space from the slats.

- Background: rounded rectangle #1e293b
- Slats: #e8580c at opacities 0.3, 0.5, 0.7, 0.85, 1.0
- N: negative space (cutout via fill-rule: evenodd path)
- Used in: sidebar, login page, favicon.svg

---

## Deployment

### Vercel Config (`vercel.json`):
```json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

### How it works:
- Vercel detects `server.js` as a Node.js serverless function
- All routes are proxied to server.js (Express handles routing)
- Static files in `public/` are served by Express's `express.static`
- On Vercel, `process.env.VERCEL` is set, so `module.exports = app` is used instead of `app.listen()`
- The `seed()` function runs on cold start to create demo data if the users table is empty

### Deploying Updates:
```bash
cd soho-wms
git add .
git commit -m "description"
git push origin main
```
Vercel auto-deploys on push to main.

### Environment Variables (set in Vercel dashboard):
- `SUPABASE_URL`
- `SUPABASE_KEY` (service_role key)
- `JWT_SECRET`

---

## Seed Data

The `seed()` function (runs on startup if no users exist) creates:
- 6 demo users (owner, admin, sales, warehouse, installer, factory)
- 10 cut profiles (A-J) with deduction values
- 12 sample fabrics (Z1A through Z2D) with stock levels
- 11 sample hardware items (head rails, tubes, brackets, etc.)

---

## Known Issues & Security Concerns

### CRITICAL:
1. **`/api/reset-all` endpoint has NO authentication** — anyone can wipe the entire database by visiting this URL. It also contains a hardcoded service_role key. **MUST be removed or protected before any real use.**
2. **Hardcoded credentials in server.js** — SUPABASE_URL, SUPABASE_KEY, and JWT_SECRET are hardcoded as fallbacks. The env vars override them on Vercel, but the keys are still visible in the source code on GitHub (if the repo is public).
3. **RLS is enabled on Supabase tables** — The service_role key with `{ auth: { autoRefreshToken: false, persistSession: false } }` bypasses RLS, but if the env var key is wrong or missing, RLS will block all operations silently.

### Login Issues (History):
The login system went through several fixes:
- `.single()` replaced with `.limit(1)` + `users?.[0]` to handle duplicate user rows
- bcrypt hashes generated in one runtime (sandbox) didn't match in another (Vercel) — solved by generating hashes on the same runtime via `/api/reset-all`
- RLS blocked inserts even with service_role key until the `{ auth: ... }` options were added

### Missing Schema:
- `production_queue` view is used in code but NOT defined in schema.sql
- Production columns on `job_windows` (production_status, cut_at, cut_by, assembled_at, etc.) are NOT in schema.sql
- `migration-quotes.sql` must be run separately after schema.sql

### Other:
- `generate-pdf.py` still exists in the repo — can be deleted
- Quote price lookup table is hardcoded in the frontend (not in the database)
- No pagination on list endpoints — may be slow with large datasets
- No input sanitization beyond what Express/Supabase provides
- No rate limiting on login endpoint
- JWT tokens are 12h — no refresh token mechanism
- Soft-delete for users only (sets active=false) — no hard delete

---

## Pending Features (Not Yet Implemented)

1. **Role-based access refinement** — Sales should only see their own clients/quotes (partially done for jobs)
2. **Sales commission system** — Track commissions per sales rep
3. **Sales rep data isolation** — Enforce per-rep data boundaries
4. **Installer job assignment** — Assign specific installers to jobs, restrict their view
5. **End-to-end role verification** — Test all endpoints with each role
6. **Remove /api/reset-all** — Or protect it with owner auth
7. **Production queue view** — Ensure production_queue view and production columns exist in schema.sql

---

## Local Development

```bash
cd soho-wms
npm install
npm run dev    # uses nodemon for auto-reload
# or
npm start      # plain node
```

Server runs at http://localhost:3000. Uses hardcoded Supabase credentials as fallback, so it connects to the same production database by default. To use a different database, set env vars:

```bash
SUPABASE_URL=... SUPABASE_KEY=... JWT_SECRET=... npm run dev
```

---

## Quick Reference: Number Formats

- Job numbers: `SB-2026-0001`, `SB-2026-0002`, ...
- Quote numbers: `QT-2026-0001`, `QT-2026-0002`, ...
- Transfer numbers: `TRF-2026-0001`, ...
- Generated by `genNumber(table, col, prefix)` — looks at last row's number and increments

---

## Dependencies

```json
{
  "@supabase/supabase-js": "^2.49.1",
  "bcryptjs": "^2.4.3",
  "express": "^4.18.2",
  "jsonwebtoken": "^9.0.2",
  "pdfkit": "^0.19.1"
}
```

No frontend dependencies — vanilla JS, no build step.
