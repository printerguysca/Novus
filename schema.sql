-- ═══════════════════════════════════════════════════════════════════════════
-- SOHO BLINDS WMS — Supabase / PostgreSQL Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── TABLES ──────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','sales','warehouse','installer','factory')),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  blind_type TEXT NOT NULL,
  cassette_ded DOUBLE PRECISION NOT NULL,
  roller_ded DOUBLE PRECISION NOT NULL,
  bottom_rail_ded DOUBLE PRECISION NOT NULL,
  bottom_core_ded DOUBLE PRECISION NOT NULL,
  description TEXT
);

CREATE TABLE fabrics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalogue_no TEXT UNIQUE NOT NULL,
  series TEXT,
  alias TEXT NOT NULL,
  colour_hex TEXT DEFAULT '#cccccc',
  slat_size DOUBLE PRECISION DEFAULT 3.0,
  roll_qty INTEGER DEFAULT 0,
  total_meters DOUBLE PRECISION DEFAULT 0,
  used_meters DOUBLE PRECISION DEFAULT 0,
  wastage_factor DOUBLE PRECISION DEFAULT 0.1,
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE hardware_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT NOT NULL,
  item_code TEXT,
  description TEXT NOT NULL,
  unit TEXT DEFAULT 'meters',
  total_qty DOUBLE PRECISION DEFAULT 0,
  used_qty DOUBLE PRECISION DEFAULT 0,
  wastage_factor DOUBLE PRECISION DEFAULT 0.05,
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE clients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  contact TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_number TEXT UNIQUE NOT NULL,
  client_id BIGINT REFERENCES clients(id),
  rep TEXT,
  rep_id BIGINT REFERENCES users(id),
  status TEXT DEFAULT 'new',
  date_in TEXT,
  date_due TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE job_windows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  window_no INTEGER,
  location TEXT,
  fabric_id BIGINT REFERENCES fabrics(id),
  profile_code TEXT,
  cassette_colour TEXT,
  width_in DOUBLE PRECISION DEFAULT 0,
  width_frac DOUBLE PRECISION DEFAULT 0,
  length_in DOUBLE PRECISION DEFAULT 0,
  length_frac DOUBLE PRECISION DEFAULT 0,
  control_type TEXT DEFAULT 'chain',
  lr_side TEXT DEFAULT 'R',
  mount_type TEXT DEFAULT 'in',
  notes TEXT,
  cut_cassette DOUBLE PRECISION,
  cut_roller DOUBLE PRECISION,
  cut_bottom_rail DOUBLE PRECISION,
  cut_bottom_core DOUBLE PRECISION,
  cut_fabric_width DOUBLE PRECISION,
  cut_fabric_drop DOUBLE PRECISION,
  fabric_meters DOUBLE PRECISION,
  cord_wand_size TEXT,
  bracket_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE quotes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_number TEXT UNIQUE NOT NULL,
  client_id BIGINT REFERENCES clients(id),
  created_by BIGINT REFERENCES users(id),
  status TEXT DEFAULT 'draft',
  subtotal DOUBLE PRECISION DEFAULT 0,
  discount_pct DOUBLE PRECISION DEFAULT 0,
  tax_pct DOUBLE PRECISION DEFAULT 5,
  total DOUBLE PRECISION DEFAULT 0,
  notes TEXT,
  valid_until TEXT,
  job_id BIGINT REFERENCES jobs(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE quote_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  location TEXT,
  fabric_id BIGINT REFERENCES fabrics(id),
  profile_code TEXT,
  blind_type TEXT,
  width_in DOUBLE PRECISION,
  width_frac DOUBLE PRECISION DEFAULT 0,
  length_in DOUBLE PRECISION,
  length_frac DOUBLE PRECISION DEFAULT 0,
  qty INTEGER DEFAULT 1,
  unit_price DOUBLE PRECISION DEFAULT 0,
  line_total DOUBLE PRECISION DEFAULT 0
);

CREATE TABLE tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assigned_to BIGINT REFERENCES users(id),
  created_by BIGINT REFERENCES users(id),
  job_id BIGINT REFERENCES jobs(id),
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  due_date TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE calendar_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  event_type TEXT DEFAULT 'other',
  job_id BIGINT REFERENCES jobs(id),
  assigned_to BIGINT REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  notes TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier TEXT NOT NULL,
  reference TEXT,
  date_received TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE shipment_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id BIGINT REFERENCES shipments(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id BIGINT NOT NULL,
  qty_received DOUBLE PRECISION NOT NULL,
  notes TEXT
);

CREATE TABLE transfers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_no TEXT UNIQUE NOT NULL,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  job_id BIGINT REFERENCES jobs(id),
  notes TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE transfer_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,
  item_id BIGINT NOT NULL,
  item_name TEXT,
  qty DOUBLE PRECISION NOT NULL
);

CREATE TABLE movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id BIGINT NOT NULL,
  item_name TEXT,
  movement_type TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  job_id BIGINT,
  shipment_id BIGINT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── VIEWS ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW fabrics_view AS
SELECT *, (total_meters - used_meters - (used_meters * wastage_factor)) as remaining
FROM fabrics;

CREATE OR REPLACE VIEW hardware_view AS
SELECT *, (total_qty - used_qty - (used_qty * wastage_factor)) as remaining
FROM hardware_items;

CREATE OR REPLACE VIEW jobs_list AS
SELECT j.*, c.name as client_name, c.address as client_address,
  (SELECT COUNT(*) FROM job_windows WHERE job_id = j.id) as window_count
FROM jobs j LEFT JOIN clients c ON j.client_id = c.id;

CREATE OR REPLACE VIEW job_detail AS
SELECT j.*, c.name as client_name, c.address as client_address, c.contact, c.phone as client_phone
FROM jobs j LEFT JOIN clients c ON j.client_id = c.id;

CREATE OR REPLACE VIEW windows_detail AS
SELECT jw.*,
  f.alias as fabric_alias, f.catalogue_no, f.colour_hex, f.slat_size, f.series,
  p.description as profile_desc, p.blind_type
FROM job_windows jw
LEFT JOIN fabrics f ON jw.fabric_id = f.id
LEFT JOIN profiles p ON jw.profile_code = p.code;

CREATE OR REPLACE VIEW tasks_detail AS
SELECT t.*,
  u.name as assigned_name,
  u2.name as creator_name,
  j.job_number
FROM tasks t
LEFT JOIN users u ON t.assigned_to = u.id
LEFT JOIN users u2 ON t.created_by = u2.id
LEFT JOIN jobs j ON t.job_id = j.id;

CREATE OR REPLACE VIEW calendar_detail AS
SELECT e.*,
  j.job_number,
  c.name as client_name,
  u.name as assigned_name
FROM calendar_events e
LEFT JOIN jobs j ON e.job_id = j.id
LEFT JOIN clients c ON j.client_id = c.id
LEFT JOIN users u ON e.assigned_to = u.id;

CREATE OR REPLACE VIEW quotes_view AS
SELECT q.*, c.name as client_name, u.name as rep_name
FROM quotes q
LEFT JOIN clients c ON q.client_id = c.id
LEFT JOIN users u ON q.created_by = u.id;

CREATE OR REPLACE VIEW quote_items_view AS
SELECT qi.*, f.alias as fabric_alias, f.colour_hex
FROM quote_items qi
LEFT JOIN fabrics f ON qi.fabric_id = f.id;

CREATE OR REPLACE VIEW transfers_view AS
SELECT t.*, j.job_number
FROM transfers t
LEFT JOIN jobs j ON t.job_id = j.id;

CREATE OR REPLACE VIEW shipment_items_view AS
SELECT si.*,
  CASE WHEN si.item_type = 'fabric' THEN f.alias ELSE NULL END as fabric_alias,
  CASE WHEN si.item_type = 'fabric' THEN f.catalogue_no ELSE NULL END as catalogue_no,
  CASE WHEN si.item_type = 'hardware' THEN h.description ELSE NULL END as hw_desc
FROM shipment_items si
LEFT JOIN fabrics f ON si.item_type = 'fabric' AND si.item_id = f.id
LEFT JOIN hardware_items h ON si.item_type = 'hardware' AND si.item_id = h.id;
