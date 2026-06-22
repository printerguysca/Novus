-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION WORKFLOW MIGRATION
-- Run in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- Add production tracking columns to job_windows
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS production_status TEXT DEFAULT 'pending';
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS cut_at TIMESTAMPTZ;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS cut_by TEXT;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS assembled_at TIMESTAMPTZ;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS assembled_by TEXT;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS qc_status TEXT;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS qc_at TIMESTAMPTZ;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS qc_by TEXT;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS qc_notes TEXT;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;
ALTER TABLE job_windows ADD COLUMN IF NOT EXISTS packed_by TEXT;

-- Update the windows_detail view to include production fields
CREATE OR REPLACE VIEW windows_detail AS
SELECT jw.*,
  f.alias as fabric_alias, f.catalogue_no, f.colour_hex, f.slat_size, f.series,
  p.description as profile_desc, p.blind_type
FROM job_windows jw
LEFT JOIN fabrics f ON jw.fabric_id = f.id
LEFT JOIN profiles p ON jw.profile_code = p.code;

-- Production queue view (windows in active production jobs)
CREATE OR REPLACE VIEW production_queue AS
SELECT jw.*,
  f.alias as fabric_alias, f.catalogue_no, f.colour_hex,
  p.blind_type, p.description as profile_desc,
  j.job_number, j.status as job_status, j.date_due,
  c.name as client_name
FROM job_windows jw
LEFT JOIN fabrics f ON jw.fabric_id = f.id
LEFT JOIN profiles p ON jw.profile_code = p.code
LEFT JOIN jobs j ON jw.job_id = j.id
LEFT JOIN clients c ON j.client_id = c.id
WHERE j.status IN ('in_production', 'measured', 'new');
