-- ═══════════════════════════════════════════════════════════════════════════
-- ENHANCED QUOTE BUILDER MIGRATION
-- Run in: Supabase Dashboard → SQL Editor → New Query → Paste → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- Add new columns to quotes table
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_notes TEXT DEFAULT 'Thank you for your business!';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS terms TEXT DEFAULT 'Payment due within 30 days.';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS markup DOUBLE PRECISION DEFAULT 0;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS upgrades DOUBLE PRECISION DEFAULT 0;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS amount_paid DOUBLE PRECISION DEFAULT 0;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_reason TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS hide_prices BOOLEAN DEFAULT FALSE;

-- Add discount_pct per line item
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS discount_pct DOUBLE PRECISION DEFAULT 0;

-- Add cassette_colour, control_type, lr_side, mount_type to quote_items for the builder
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS cassette_colour TEXT;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS control_type TEXT;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS lr_side TEXT;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS mount_type TEXT;

-- Add fabric_code (coded catalog system: Z1A, R2B-L, etc.) and hc_custom (honeycomb custom code)
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS fabric_code TEXT;
ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS hc_custom TEXT;

-- Update quotes_view to include new fields
CREATE OR REPLACE VIEW quotes_view AS
SELECT q.*, c.name as client_name, c.address as client_address,
  c.phone as client_phone, c.email as client_email, c.contact as client_contact,
  u.name as rep_name
FROM quotes q
LEFT JOIN clients c ON q.client_id = c.id
LEFT JOIN users u ON q.created_by = u.id;

-- Update quote_items_view to include new fields
CREATE OR REPLACE VIEW quote_items_view AS
SELECT qi.*, f.alias as fabric_alias, f.colour_hex, f.catalogue_no
FROM quote_items qi
LEFT JOIN fabrics f ON qi.fabric_id = f.id;
