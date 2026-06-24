const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'soho-blinds-secret-2026';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tntmgwukdzzeknlfmotz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudG1nd3VrZHp6ZWtubGZtb3R6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU3MTI1MCwiZXhwIjoyMDk2MTQ3MjUwfQ.593no0oW97qNYCNgGtFNdnIhoSEVsaTke7PYc9gepvk';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function genNumber(table, col, prefix) {
  const year = new Date().getFullYear();
  const { data } = await supabase.from(table).select(col).order('id', { ascending: false }).limit(1);
  let seq = 1;
  if (data?.length) { const n = parseInt(data[0][col].split('-').pop()); if (!isNaN(n)) seq = n + 1; }
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

async function logMovement(item_type, item_id, item_name, movement_type, qty, job_id, shipment_id, notes) {
  await supabase.from('movements').insert({ item_type, item_id, item_name, movement_type, qty, job_id, shipment_id, notes });
}

async function calcCuts(w) {
  const P = {
    A:{c:-0.375,r:-1.0625,br:-1.0625,bc:-1.25},B:{c:-0.375,r:-0.875,br:-0.875,bc:-1.0625},
    C:{c:-0.3125,r:-0.75,br:-0.75,bc:-0.875},D:{c:-0.3125,r:-0.5625,br:-0.5625,bc:-0.6875},
    E:{c:0,r:-1.125,br:-1.125,bc:0},F:{c:-0.375,r:-1.0625,br:-1.0625,bc:0},
    G:{c:-0.375,r:-0.875,br:-0.875,bc:0},H:{c:-0.3125,r:-0.875,br:-0.875,bc:-1.0625},
    I:{c:-0.3125,r:-0.75,br:-0.75,bc:-0.875},J:{c:-0.375,r:-1.0,br:-1.0,bc:0}
  };
  const p = P[w.profile_code]; if (!p) return null;
  const tw = (parseFloat(w.width_in)||0) + (parseFloat(w.width_frac)||0);
  const tl = (parseFloat(w.length_in)||0) + (parseFloat(w.length_frac)||0);
  const cut_cassette = parseFloat((tw+p.c).toFixed(4));
  const cut_roller = parseFloat((tw+p.r).toFixed(4));
  const cut_bottom_rail = parseFloat((tw+p.br).toFixed(4));
  const cut_bottom_core = p.bc ? parseFloat((tw+p.bc).toFixed(4)) : 0;
  const cut_fabric_width = parseFloat((cut_bottom_rail-0.0625).toFixed(4));
  let fabric = w._fabricData || null;
  if (!fabric && w.fabric_id) {
    const { data } = await supabase.from('fabrics').select('*').eq('id', w.fabric_id).single();
    fabric = data;
  }
  const cassette = (w.cassette_colour||'').toLowerCase();
  // Use fabric_code text field as fallback when fabric_id not set (e.g. converted from quote)
  const fabricCode = fabric ? fabric.catalogue_no : (w.fabric_code||'');
  const prefix = fabricCode ? fabricCode[0].toUpperCase() : '';
  // Infer blind type from fabric prefix if not explicitly set (Z/S = Zebra, else Roller)
  const blindType = (w.blind_type||'').toLowerCase() || (prefix==='Z'||prefix==='S' ? 'zebra' : 'roller');
  // Zebra: height + slat_size/2 - 5/8". Roller / Double Roller: height + 6"
  const cut_fabric_drop = blindType === 'zebra'
    ? parseFloat((tl + (fabric?.slat_size||3)/2 - 0.625).toFixed(4))
    : parseFloat((tl + 6).toFixed(4));
  const fabric_meters = parseFloat(((prefix==='Z'||prefix==='S') ? cut_fabric_drop*0.0254*2 : cut_fabric_drop*0.0254).toFixed(4));
  const ctrl = (w.control_type||'').toLowerCase();
  const cord_wand_size = ctrl.startsWith('m') ? 'None' : tl<30 ? 'S' : tl<45 ? 'M' : 'L';
  const bracket_count = tw > 59 ? 3 : 2;
  return { cut_cassette, cut_roller, cut_bottom_rail, cut_bottom_core, cut_fabric_width, cut_fabric_drop, fabric_meters, cord_wand_size, bracket_count };
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}
const ownerAdmin = requireRole('owner','admin');
const ownerAdminSales = requireRole('owner','admin','sales');
const warehouseRoles = requireRole('owner','admin','warehouse');

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

// Nuclear reset — uses hardcoded service_role key to bypass RLS
app.get('/api/reset-all', async (req, res) => {
  try {
    // Create admin client with service_role key directly — bypasses RLS
    const admin = createClient(
      'https://tntmgwukdzzeknlfmotz.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudG1nd3VrZHp6ZWtubGZtb3R6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU3MTI1MCwiZXhwIjoyMDk2MTQ3MjUwfQ.593no0oW97qNYCNgGtFNdnIhoSEVsaTke7PYc9gepvk',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Wipe everything
    const tables = ['shipment_items','shipments','quote_items','quotes','job_windows','jobs','tasks','calendar_events','users'];
    for (const t of tables) {
      await admin.from(t).delete().neq('id', 0);
    }

    // Create fresh users
    const h = p => bcrypt.hashSync(p, 10);
    const { data, error } = await admin.from('users').insert([
      { name:'Owner Account', email:'owner@soho.ca', password_hash:h('owner123'), role:'owner', active:true },
      { name:'Office Admin', email:'admin@soho.ca', password_hash:h('admin123'), role:'admin', active:true },
      { name:'Sales Rep', email:'sales@soho.ca', password_hash:h('sales123'), role:'sales', active:true },
      { name:'Warehouse Team', email:'warehouse@soho.ca', password_hash:h('warehouse123'), role:'warehouse', active:true },
      { name:'Installer', email:'installer@soho.ca', password_hash:h('installer123'), role:'installer', active:true },
      { name:'Factory Floor', email:'factory@soho.ca', password_hash:h('factory123'), role:'factory', active:true },
    ]).select('id,email,role');
    if (error) return res.json({ ok: false, step: 'insert', error: error.message });

    // Verify
    const { data: check } = await admin.from('users').select('*').eq('email', 'owner@soho.ca').limit(1);
    const match = check?.[0] ? bcrypt.compareSync('owner123', check[0].password_hash) : false;

    // Also check which key the main client uses
    const keyUsed = SUPABASE_KEY.substring(0, 30) + '...';

    res.json({ ok: true, users_created: data, bcrypt_verify: match, main_key_preview: keyUsed });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Demo account passwords (plain text — these are public knowledge, bcrypt provides no benefit here)
const DEMO_PASSWORDS = {
  'owner@soho.ca': 'owner123',
  'admin@soho.ca': 'admin123',
  'sales@soho.ca': 'sales123',
  'warehouse@soho.ca': 'warehouse123',
  'installer@soho.ca': 'installer123',
  'factory@soho.ca': 'factory123',
};

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const normalizedEmail = email.toLowerCase().trim();
    const { data: users, error } = await supabase.from('users').select('*').eq('email', normalizedEmail).eq('active', true).limit(1);
    if (error) { console.error('Login DB error:', error); return res.status(500).json({ error: 'Database error: ' + error.message }); }
    const user = users?.[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    // Demo accounts: plain text compare. Real accounts: bcrypt.
    const demoPass = DEMO_PASSWORDS[normalizedEmail];
    const ok = demoPass ? password === demoPass : bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch(e) { console.error('Login error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,role,active,created_at').eq('id', req.user.id).single();
  res.json(data);
});

// ─── USERS ───────────────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, ownerAdmin, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,role,active,created_at').order('role').order('name');
  res.json(data);
});
app.post('/api/users', requireAuth, ownerAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name||!email||!password||!role) return res.status(400).json({ error: 'All fields required' });
  const hash = bcrypt.hashSync(password, 10);
  const { data, error } = await supabase.from('users').insert({ name, email: email.toLowerCase(), password_hash: hash, role }).select('id,name,email,role,active').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/users/:id', requireAuth, ownerAdmin, async (req, res) => {
  const { name, email, role, active, password } = req.body;
  const updates = {};
  if (name) updates.name = name;
  if (email) updates.email = email;
  if (role) updates.role = role;
  if (active != null) updates.active = active;
  if (password) updates.password_hash = bcrypt.hashSync(password, 10);
  await supabase.from('users').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('users').select('id,name,email,role,active').eq('id', req.params.id).single();
  res.json(data);
});
app.delete('/api/users/:id', requireAuth, requireRole('owner'), async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await supabase.from('users').update({ active: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const { role, id } = req.user;
  const [
    { data: allJobs },
    { count: totalClients },
    { data: recentJobs },
    { data: lowFabric },
    { data: myTasks },
    { data: qr }
  ] = await Promise.all([
    supabase.from('jobs').select('status'),
    supabase.from('clients').select('*', { count: 'exact', head: true }),
    supabase.from('jobs_list').select('*').order('created_at', { ascending: false }).limit(6),
    supabase.from('fabrics_view').select('*').eq('active', true).lt('remaining', 20).order('remaining').limit(5),
    supabase.from('tasks_detail').select('*').eq('assigned_to', id).neq('status', 'done').order('due_date').limit(5),
    role === 'owner' ? supabase.from('quotes').select('total,status').in('status', ['accepted','converted']) : Promise.resolve({ data: null })
  ]);
  const counts = {}; (allJobs||[]).forEach(j => { counts[j.status] = (counts[j.status]||0)+1; });
  const jobCounts = Object.entries(counts).map(([status,count]) => ({ status, count }));
  const revenue = qr ? { total: qr.reduce((s,q) => s + (q.total||0), 0), count: qr.length } : null;
  res.json({ jobCounts, totalJobs: (allJobs||[]).length, totalClients, recentJobs: recentJobs||[], lowFabric: lowFabric||[], myTasks: myTasks||[], revenue });
});

// ─── PROFILES ────────────────────────────────────────────────────────────────

app.get('/api/profiles', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  const { data } = await supabase.from('profiles').select('*').order('code');
  res.json(data);
});

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

app.get('/api/clients', requireAuth, ownerAdminSales, async (req, res) => {
  const { data } = await supabase.from('clients').select('*').order('name');
  res.json(data);
});
app.post('/api/clients', requireAuth, ownerAdminSales, async (req, res) => {
  const { name, address, contact, phone, email, notes } = req.body;
  const { data, error } = await supabase.from('clients').insert({ name, address, contact, phone, email, notes }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/clients/:id', requireAuth, ownerAdminSales, async (req, res) => {
  const { name, address, contact, phone, email, notes } = req.body;
  const updates = {};
  if (name) updates.name = name; if (address != null) updates.address = address;
  if (contact != null) updates.contact = contact; if (phone != null) updates.phone = phone;
  if (email != null) updates.email = email; if (notes != null) updates.notes = notes;
  await supabase.from('clients').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
  res.json(data);
});

// ─── JOBS ─────────────────────────────────────────────────────────────────────

app.get('/api/jobs', requireAuth, async (req, res) => {
  const { role, id } = req.user;
  let q = supabase.from('jobs_list').select('*');
  if (role === 'sales') q = q.eq('rep_id', id);
  else if (role === 'installer') q = q.in('status', ['ready','installed']);
  else if (role === 'factory') q = q.eq('status', 'in_production');
  const { data } = await q.order('created_at', { ascending: false });
  res.json(data || []);
});
app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  const [{ data: job }, { data: windows }] = await Promise.all([
    supabase.from('job_detail').select('*').eq('id', req.params.id).single(),
    supabase.from('windows_detail').select('*').eq('job_id', req.params.id).order('window_no')
  ]);
  if (!job) return res.status(404).json({ error: 'Not found' });
  job.phone = job.client_phone; delete job.client_phone;
  res.json({ ...job, windows: windows || [] });
});
app.post('/api/jobs', requireAuth, requireRole('owner','admin','sales'), async (req, res) => {
  const { client_id, rep, date_in, date_due, notes } = req.body;
  const job_number = await genNumber('jobs', 'job_number', 'SB');
  const { data, error } = await supabase.from('jobs').insert({ job_number, client_id, rep: rep||req.user.name, rep_id: req.user.id, date_in, date_due, notes }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/jobs/:id', requireAuth, async (req, res) => {
  const { status, rep, date_due, notes } = req.body;
  const updates = {};
  if (status) updates.status = status; if (rep) updates.rep = rep;
  if (date_due) updates.date_due = date_due; if (notes != null) updates.notes = notes;
  await supabase.from('jobs').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.delete('/api/jobs/:id', requireAuth, ownerAdmin, async (req, res) => {
  await supabase.from('jobs').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── JOB WINDOWS ─────────────────────────────────────────────────────────────

app.post('/api/jobs/:job_id/windows', requireAuth, async (req, res) => {
  const job_id = parseInt(req.params.job_id);
  const data = req.body;
  const cuts = await calcCuts(data);
  const { count } = await supabase.from('job_windows').select('*', { count: 'exact', head: true }).eq('job_id', job_id);
  const { data: win, error } = await supabase.from('job_windows').insert({
    job_id, window_no: (count||0)+1, location: data.location, fabric_id: data.fabric_id || null,
    blind_type: data.blind_type || null,
    profile_code: data.profile_code, cassette_colour: data.cassette_colour,
    width_in: data.width_in, width_frac: data.width_frac, length_in: data.length_in, length_frac: data.length_frac,
    control_type: data.control_type, lr_side: data.lr_side, mount_type: data.mount_type, notes: data.notes,
    cut_cassette: cuts?.cut_cassette, cut_roller: cuts?.cut_roller, cut_bottom_rail: cuts?.cut_bottom_rail,
    cut_bottom_core: cuts?.cut_bottom_core, cut_fabric_width: cuts?.cut_fabric_width,
    cut_fabric_drop: cuts?.cut_fabric_drop, fabric_meters: cuts?.fabric_meters,
    cord_wand_size: cuts?.cord_wand_size, bracket_count: cuts?.bracket_count
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  // Fetch with joined data for response
  const { data: full } = await supabase.from('windows_detail').select('*').eq('id', win.id).single();
  res.json(full);
});
app.delete('/api/windows/:id', requireAuth, async (req, res) => {
  await supabase.from('job_windows').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── CSV IMPORT (bulk) ──────────────────────────────────────────────────────

app.post('/api/jobs/import', requireAuth, async (req, res) => {
  const { client, windows, quote, notes } = req.body;
  try {
    // 1. Create client
    let client_id;
    if (client.id) { client_id = client.id; }
    else {
      const { data: c } = await supabase.from('clients').insert({ name: client.name||'Unnamed', phone: client.phone||'', address: client.address||'' }).select().single();
      client_id = c.id;
    }
    // 2. Create job
    const job_number = await genNumber('jobs', 'job_number', 'SB');
    const { data: job } = await supabase.from('jobs').insert({
      job_number, client_id, rep: req.user.name, rep_id: req.user.id,
      date_in: new Date().toISOString().split('T')[0], notes: notes||'', status: 'new'
    }).select().single();
    // 3. Create windows
    for (let i = 0; i < (windows||[]).length; i++) {
      const w = windows[i];
      const cuts = await calcCuts(w);
      await supabase.from('job_windows').insert({
        job_id: job.id, window_no: i+1, location: w.location, fabric_id: w.fabric_id||null,
        profile_code: w.profile_code, cassette_colour: w.cassette_colour||'White',
        width_in: w.width_in||0, width_frac: w.width_frac||0, length_in: w.length_in||0, length_frac: w.length_frac||0,
        control_type: w.control_type||'chain', lr_side: w.lr_side||'R', mount_type: w.mount_type||'in', notes: w.notes||'',
        cut_cassette: cuts?.cut_cassette, cut_roller: cuts?.cut_roller, cut_bottom_rail: cuts?.cut_bottom_rail,
        cut_bottom_core: cuts?.cut_bottom_core, cut_fabric_width: cuts?.cut_fabric_width,
        cut_fabric_drop: cuts?.cut_fabric_drop, fabric_meters: cuts?.fabric_meters,
        cord_wand_size: cuts?.cord_wand_size, bracket_count: cuts?.bracket_count
      });
    }
    // 4. Optionally create quote
    if (quote) {
      const qn = quote.quote_number || await genNumber('quotes', 'quote_number', 'QT');
      const subtotal = parseFloat(quote.subtotal)||0;
      const disc = parseFloat(quote.discount_pct)||0;
      const tax = parseFloat(quote.tax_pct)||5;
      const total = parseFloat(quote.total) || parseFloat((subtotal*(1-disc/100)*(1+tax/100)).toFixed(2));
      const { data: q } = await supabase.from('quotes').insert({
        quote_number: qn, client_id, created_by: req.user.id, subtotal, discount_pct: disc,
        tax_pct: tax, total, notes: quote.notes||'', job_id: job.id, status: 'accepted'
      }).select().single();
      for (const w of (windows||[])) {
        await supabase.from('quote_items').insert({
          quote_id: q.id, location: w.location, fabric_id: w.fabric_id||null, fabric_code: w.fabric_code||null,
          hc_custom: w.hc_custom||null, blind_type: w.blind_type||'',
          width_in: w.width_in||0, width_frac: w.width_frac||0, length_in: w.length_in||0, length_frac: w.length_frac||0,
          qty: w.qty||1, unit_price: w.unit_price||0, line_total: (w.unit_price||0)*(w.qty||1)
        });
      }
    }
    res.json({ job_id: job.id, job_number });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── QUOTES ──────────────────────────────────────────────────────────────────

app.get('/api/quotes', requireAuth, ownerAdminSales, async (req, res) => {
  const { role, id } = req.user;
  let q = supabase.from('quotes_view').select('*');
  if (role === 'sales') q = q.eq('created_by', id);
  // Fetch quotes + all items in parallel (2 queries instead of N+1)
  const [{ data: rows }, { data: allItems }] = await Promise.all([
    q.order('created_at', { ascending: false }),
    supabase.from('quote_items_view').select('*').order('id')
  ]);
  const itemsByQuote = {};
  (allItems||[]).forEach(i => { if(!itemsByQuote[i.quote_id]) itemsByQuote[i.quote_id]=[]; itemsByQuote[i.quote_id].push(i); });
  res.json((rows||[]).map(row => ({ ...row, items: itemsByQuote[row.id]||[] })));
});
app.get('/api/quotes/:id', requireAuth, ownerAdminSales, async (req, res) => {
  const { data: q } = await supabase.from('quotes_view').select('*').eq('id', req.params.id).single();
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { data: items } = await supabase.from('quote_items_view').select('*').eq('quote_id', q.id).order('id');
  res.json({ ...q, items: items||[] });
});
app.post('/api/quotes', requireAuth, ownerAdminSales, async (req, res) => {
  const { client_id, customer_notes, terms, valid_until, items, discount_pct, tax_pct,
          markup, upgrades, amount_paid, discount_reason, hide_prices, notes } = req.body;
  const quote_number = await genNumber('quotes', 'quote_number', 'QT');
  const msrp = (items||[]).reduce((s,i) => {
    const lp = (i.unit_price||0)*(i.qty||1);
    return s + (lp - lp*((i.discount_pct||0)/100));
  }, 0);
  const mk = parseFloat(markup)||0;
  const disc = parseFloat(discount_pct)||0;
  const upg = parseFloat(upgrades)||0;
  const tax = parseFloat(tax_pct)||5;
  const beforeTax = (msrp + mk) * (1 - disc/100) + upg;
  const total = parseFloat((beforeTax * (1 + tax/100)).toFixed(2));
  const { data: q, error } = await supabase.from('quotes').insert({
    quote_number, client_id, created_by: req.user.id, subtotal: parseFloat(msrp.toFixed(2)),
    discount_pct: disc, tax_pct: tax, total, notes: notes||'', valid_until: valid_until||null,
    customer_notes: customer_notes||'Thank you for your business!',
    terms: terms||'Payment due within 30 days.',
    markup: mk, upgrades: upg, amount_paid: parseFloat(amount_paid)||0,
    discount_reason: discount_reason||null, hide_prices: hide_prices||false
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  for (const i of (items||[])) {
    const lt = (i.unit_price||0)*(i.qty||1);
    await supabase.from('quote_items').insert({
      quote_id: q.id, location: i.location, fabric_id: i.fabric_id||null,
      fabric_code: i.fabric_code||null, hc_custom: i.hc_custom||null,
      profile_code: i.profile_code, blind_type: i.blind_type,
      width_in: i.width_in, width_frac: i.width_frac||0,
      length_in: i.length_in, length_frac: i.length_frac||0, qty: i.qty||1,
      unit_price: i.unit_price||0, line_total: parseFloat((lt - lt*((i.discount_pct||0)/100)).toFixed(2)),
      discount_pct: i.discount_pct||0, cassette_colour: i.cassette_colour||null,
      control_type: i.control_type||null, lr_side: i.lr_side||null, mount_type: i.mount_type||null,
      fabric_code_2: i.fabric_code_2||null,
      control_type_2: i.control_type_2||null, lr_side_2: i.lr_side_2||null
    });
  }
  res.json(q);
});
app.put('/api/quotes/:id', requireAuth, ownerAdminSales, async (req, res) => {
  const { client_id, customer_notes, terms, valid_until, items, discount_pct, tax_pct,
          markup, upgrades, amount_paid, discount_reason, hide_prices, notes, status } = req.body;
  const msrp = (items||[]).reduce((s,i) => {
    const lp = (i.unit_price||0)*(i.qty||1);
    return s + (lp - lp*((i.discount_pct||0)/100));
  }, 0);
  const mk = parseFloat(markup)||0;
  const disc = parseFloat(discount_pct)||0;
  const upg = parseFloat(upgrades)||0;
  const tax = parseFloat(tax_pct)||5;
  const beforeTax = (msrp + mk) * (1 - disc/100) + upg;
  const total = parseFloat((beforeTax * (1 + tax/100)).toFixed(2));
  const updates = {
    client_id, subtotal: parseFloat(msrp.toFixed(2)), discount_pct: disc, tax_pct: tax, total,
    notes: notes||'', valid_until: valid_until||null, customer_notes: customer_notes||'',
    terms: terms||'', markup: mk, upgrades: upg, amount_paid: parseFloat(amount_paid)||0,
    discount_reason: discount_reason||null, hide_prices: hide_prices||false
  };
  if (status) updates.status = status;
  await supabase.from('quotes').update(updates).eq('id', req.params.id);
  await supabase.from('quote_items').delete().eq('quote_id', req.params.id);
  for (const i of (items||[])) {
    const lt = (i.unit_price||0)*(i.qty||1);
    await supabase.from('quote_items').insert({
      quote_id: parseInt(req.params.id), location: i.location, fabric_id: i.fabric_id||null,
      fabric_code: i.fabric_code||null, hc_custom: i.hc_custom||null,
      profile_code: i.profile_code, blind_type: i.blind_type,
      width_in: i.width_in, width_frac: i.width_frac||0,
      length_in: i.length_in, length_frac: i.length_frac||0, qty: i.qty||1,
      unit_price: i.unit_price||0, line_total: parseFloat((lt - lt*((i.discount_pct||0)/100)).toFixed(2)),
      discount_pct: i.discount_pct||0, cassette_colour: i.cassette_colour||null,
      control_type: i.control_type||null, lr_side: i.lr_side||null, mount_type: i.mount_type||null,
      fabric_code_2: i.fabric_code_2||null,
      control_type_2: i.control_type_2||null, lr_side_2: i.lr_side_2||null
    });
  }
  const { data } = await supabase.from('quotes_view').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.patch('/api/quotes/:id', requireAuth, ownerAdminSales, async (req, res) => {
  const { status, notes, discount_pct } = req.body;
  const updates = {};
  if (status) updates.status = status; if (notes != null) updates.notes = notes;
  if (discount_pct != null) updates.discount_pct = discount_pct;
  await supabase.from('quotes').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('quotes').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.post('/api/quotes/:id/convert', requireAuth, ownerAdmin, async (req, res) => {
  const { data: q } = await supabase.from('quotes').select('*').eq('id', req.params.id).single();
  if (!q) return res.status(404).json({ error: 'Not found' });
  const { data: qItems } = await supabase.from('quote_items').select('*').eq('quote_id', q.id).order('id');
  const job_number = await genNumber('jobs', 'job_number', 'SB');
  const { data: job, error: jobErr } = await supabase.from('jobs').insert({
    job_number, client_id: q.client_id, rep_id: q.created_by, rep: req.user.name,
    date_in: new Date().toISOString().split('T')[0], notes: `Converted from ${q.quote_number}`
  }).select().single();
  if (jobErr) return res.status(500).json({ error: jobErr.message });
  // Pre-load all referenced fabrics in one query to avoid N round trips in calcCuts
  const fabricIds = [...new Set((qItems||[]).map(i => i.fabric_id).filter(Boolean))];
  let fabricMap = {};
  if (fabricIds.length) {
    const { data: fabrics } = await supabase.from('fabrics').select('*').in('id', fabricIds);
    (fabrics||[]).forEach(f => { fabricMap[f.id] = f; });
  }
  // Copy each quote item → job windows (expand by qty)
  let windowNo = 1;
  for (const item of (qItems || [])) {
    const count = Math.max(1, parseInt(item.qty) || 1);
    const cuts = await calcCuts({ ...item, _fabricData: item.fabric_id ? fabricMap[item.fabric_id] : null });
    for (let n = 0; n < count; n++) {
      await supabase.from('job_windows').insert({
        job_id: job.id,
        window_no: windowNo++,
        location: item.location || '',
        blind_type: item.blind_type || null,
        fabric_id: item.fabric_id || null,
        fabric_code: item.fabric_code || null,
        fabric_code_2: item.fabric_code_2 || null,
        profile_code: item.profile_code || null,
        cassette_colour: item.cassette_colour || null,
        width_in: item.width_in || 0,
        width_frac: item.width_frac || 0,
        length_in: item.length_in || 0,
        length_frac: item.length_frac || 0,
        control_type: item.control_type || 'chain',
        lr_side: item.lr_side || 'R',
        control_type_2: item.control_type_2 || null,
        lr_side_2: item.lr_side_2 || null,
        mount_type: item.mount_type || 'in',
        notes: item.blind_type || null,
        cut_cassette: cuts?.cut_cassette||null, cut_roller: cuts?.cut_roller||null,
        cut_bottom_rail: cuts?.cut_bottom_rail||null, cut_bottom_core: cuts?.cut_bottom_core||null,
        cut_fabric_width: cuts?.cut_fabric_width||null, cut_fabric_drop: cuts?.cut_fabric_drop||null,
        fabric_meters: cuts?.fabric_meters||null, cord_wand_size: cuts?.cord_wand_size||null,
        bracket_count: cuts?.bracket_count||null
      });
    }
  }
  await supabase.from('quotes').update({ status: 'converted', job_id: job.id }).eq('id', q.id);
  res.json({ job_id: job.id, job_number });
});

// ─── PDF GENERATION ──────────────────────────────────────────────────────────

// ── PDF helpers ──
const FRACS_MAP = {0:'',0.125:'1/8',0.25:'1/4',0.375:'3/8',0.5:'1/2',0.625:'5/8',0.75:'3/4',0.875:'7/8'};
function fracStr(w,f){const whole=parseInt(w)||0;const fr=FRACS_MAP[parseFloat(f)||0]||'';return fr?`${whole} ${fr}"`:`${whole}"`;}
function fmt$(v){return'$'+parseFloat(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtDate(d){try{return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});}catch(e){return d||'';}}
const ORANGE='#e8580c',DARK='#333333',GREY_BG='#f0f0f0',GREY_LINE='#cccccc',LGREY='#888888';

function generateQuotePDF(doc_type, q, items) {
  const doc = new PDFDocument({ size: 'letter', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
  const W = 612, M = 50, CW = W - 2*M;

  // ═══ PAGE 1 ═══
  // Logo circles
  const r = 22, gap = 4;
  const letters = [['S','O'],['H','O']];
  letters.forEach((row, ri) => {
    row.forEach((ch, ci) => {
      const cx = M + ci*(r*2+gap) + r;
      const cy = 60 + ri*(r*2+gap) + r;
      doc.circle(cx, cy, r).fill(DARK);
      doc.fontSize(18).font('Helvetica-Bold').fillColor('white').text(ch, cx-7, cy-8, {width:14,align:'center'});
    });
  });
  doc.fontSize(14).font('Helvetica-Bold').fillColor(DARK).text('SOHO BLINDS', M, 60+2*(r*2+gap)+8, {width:2*(r*2+gap),align:'center'});

  // Title block (right side)
  doc.fontSize(36).font('Helvetica-Bold').fillColor(DARK).text(doc_type, 0, 55, {width:W-M,align:'right'});
  doc.fontSize(16).text(q.quote_number||'', 0, 95, {width:W-M,align:'right'});
  doc.fontSize(11).font('Helvetica').fillColor(LGREY).text(fmtDate(q.created_at), 0, 118, {width:W-M,align:'right'});

  // Status badge
  const status = (q.status||'draft').toUpperCase();
  const sw = doc.widthOfString(status, {font:'Helvetica-Bold',fontSize:10});
  const bx = W-M-sw-16, by = 135;
  doc.roundedRect(bx, by, sw+16, 20, 3).lineWidth(1).stroke(DARK);
  doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(status, bx, by+5, {width:sw+16,align:'center'});

  // Separator line
  const yLine = 170;
  doc.moveTo(M, yLine).lineTo(W-M, yLine).lineWidth(2).stroke(DARK);

  // Company info
  doc.fontSize(8).font('Helvetica').fillColor(DARK);
  doc.text('Soho Blinds · 2 Donald Street · Winnipeg, Manitoba R3L 0K5 · ca · Phone: 2044757646 · Email: info@sohoblinds.ca ·', M, yLine+8, {width:CW,align:'center'});
  doc.text('https://sohoblinds.ca', M, yLine+20, {width:CW,align:'center'});

  // Bill To box
  const yBill = yLine + 45;
  doc.roundedRect(M, yBill, CW, 100, 5).fill(GREY_BG);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(DARK).text('Bill To:', M+20, yBill+15);
  doc.fontSize(12).text(q.client_name||'—', M+20, yBill+33);
  doc.fontSize(10).font('Helvetica');
  let yb = yBill+50;
  if(q.client_email){doc.text(`Email: ${q.client_email}`, M+20, yb);yb+=15;}
  if(q.client_phone){doc.text(`Phone: ${q.client_phone}`, M+20, yb);yb+=15;}
  if(q.client_address){doc.text(`Address: ${q.client_address}`, M+20, yb);}

  // Line items table
  let yT = yBill + 120;
  const cols = [{n:'#',w:25},{n:'Location',w:80},{n:'Type',w:55},{n:'Fabric',w:55},{n:'Case',w:45},{n:'Width',w:60},{n:'Height',w:60},{n:'Control',w:55},{n:'LR',w:25},{n:'Mount',w:35},{n:'Qty',w:30}];

  // Header
  doc.rect(M, yT, CW, 24).fill(GREY_BG);
  doc.fontSize(8).font('Helvetica-Bold').fillColor(DARK);
  let cx = M+5;
  cols.forEach(c=>{doc.text(c.n, cx, yT+8);cx+=c.w;});
  yT += 24;

  // Rows
  const ctrlLabel = ct => ({motor:'Motor','motor-tubular':'Motor Tub.',chain:'Chain',wand:'Wand',cordless:'Cordless'}[ct]||ct||'—');
  (items||[]).forEach((it,i) => {
    if(i%2===1){doc.rect(M,yT,CW,28).fill('#fafafa');}
    doc.moveTo(M,yT+28).lineTo(W-M,yT+28).lineWidth(0.5).stroke(GREY_LINE);
    doc.fontSize(9).font('Helvetica').fillColor(DARK);
    cx=M+5;
    const fabricDisplay = it.blind_type==='Double Roller'
      ? [it.fabric_code||'—', it.fabric_code_2||'—'].filter(Boolean).join(' / ')
      : (it.fabric_code||it.hc_custom||'—');
    const vals=[String(i+1),it.location||'—',it.blind_type||'—',fabricDisplay,it.cassette_colour||'—',fracStr(it.width_in,it.width_frac),fracStr(it.length_in,it.length_frac),ctrlLabel(it.control_type),it.lr_side||'—',it.mount_type==='in'?'In':'Out',String(it.qty||1)];
    cols.forEach((c,j)=>{doc.text(vals[j]||'', cx, yT+9, {width:c.w-4});cx+=c.w;});
    yT+=28;
  });

  // Summary
  let yS = yT + 16;
  const lx = W-M-200, vx = W-M;
  const msrp=parseFloat(q.subtotal||0), mk=parseFloat(q.markup||0), disc=parseFloat(q.discount_pct||0);
  const upg=parseFloat(q.upgrades||0), taxPct=parseFloat(q.tax_pct||5), total=parseFloat(q.total||0);
  const paid=parseFloat(q.amount_paid||0);

  function sRow(label, val, opts={}){
    doc.fontSize(10).font(opts.labelBold?'Helvetica-Bold':'Helvetica').fillColor(DARK).text(label, lx-100, yS, {width:100,align:'right'});
    doc.font(opts.bold?'Helvetica-Bold':'Helvetica').fillColor(opts.color||DARK).text(val, vx-100, yS, {width:100,align:'right'});
    yS+=18;
  }
  sRow('MSRP:', fmt$(msrp), {labelBold:true});
  if(mk>0) sRow('Markup:', '+'+fmt$(mk), {labelBold:true});
  if(disc>0){ const da=(msrp+mk)*disc/100; sRow(`Discount (${disc}%):`, '-'+fmt$(da), {labelBold:true, color:ORANGE}); }
  if(upg>0){
    sRow('Upgrades:', '+'+fmt$(upg), {labelBold:true, color:ORANGE});
    const motorQ=items.filter(it=>(it.control_type||'').startsWith('motor')).reduce((s,it)=>s+(it.qty||1),0);
    const cordQ=items.filter(it=>it.control_type==='cordless').reduce((s,it)=>s+(it.qty||1),0);
    if(cordQ>0){doc.fontSize(9).font('Helvetica').fillColor(LGREY).text(`Cordless × ${cordQ} units`, lx-100, yS, {width:100,align:'right'}).text(fmt$(cordQ*50), vx-100, yS, {width:100,align:'right'});yS+=16;}
    if(motorQ>0){doc.fontSize(9).font('Helvetica').fillColor(LGREY).text(`Motor × ${motorQ} units`, lx-100, yS, {width:100,align:'right'}).text(fmt$(motorQ*200), vx-100, yS, {width:100,align:'right'});yS+=16;}
  }
  const bDisc=(msrp+mk)*(1-disc/100), subtot=bDisc+upg, taxAmt=subtot*taxPct/100;
  sRow('Subtotal:', fmt$(subtot), {labelBold:true});
  sRow(`Tax (${taxPct.toFixed(2)}%):`, fmt$(taxAmt), {labelBold:true});
  doc.moveTo(lx-100, yS-2).lineTo(vx, yS-2).lineWidth(1.5).stroke(DARK);
  yS+=2;
  doc.fontSize(13).font('Helvetica-Bold').fillColor(DARK).text('TOTAL:', lx-100, yS, {width:100,align:'right'}).text(fmt$(total), vx-100, yS, {width:100,align:'right'});
  yS+=22;
  if(paid>0){
    const bal=total-paid;
    sRow('Paid:', fmt$(paid), {labelBold:true, color:'#16a34a'});
    sRow('Balance Due:', fmt$(bal), {labelBold:true, bold:true, color:bal>0?ORANGE:'#16a34a'});
  }

  // ═══ PAGE 2 — Terms & Conditions ═══
  doc.addPage();
  let y2 = 50;
  doc.fontSize(22).font('Helvetica-Bold').fillColor(DARK).text('Terms and Conditions', M, y2);
  y2+=30;
  doc.moveTo(M,y2).lineTo(M+280,y2).lineWidth(1).stroke(ORANGE);
  y2+=20;

  doc.fontSize(14).font('Helvetica-Bold').text('Changes', M, y2);y2+=20;
  doc.fontSize(10).font('Helvetica').text('Any changes in the original order must be discussed at the Soho Blinds office line at (204) 475-7646, Monday to Friday 10 am till 4 pm or email at info@sohoblinds.ca before they could be performed by the technician.', M, y2, {width:CW});
  y2+=45;

  doc.fontSize(14).font('Helvetica-Bold').text('Warranty & Handling', M, y2);y2+=20;
  doc.fontSize(10).font('Helvetica').text('Soho Blinds offers warranty of 10 years on the mechanical parts including aluminum hardware tracks or casings, mechanical clutches, types of manual controls and 1 year on the motorization parts. Soho Blinds will repair any defects related to mechanical or hardware parts of the blinds during the 10-year period and motorized parts for the 1-year period from the date of install. Any other warranties explicitly mentioned are not valid. Soho Blinds\' Warranty does not cover damage caused by improper use, improper cleaning, abuse or neglect.', M, y2, {width:CW});
  y2+=72;

  doc.fontSize(14).font('Helvetica-Bold').text('Payment', M, y2);y2+=20;
  doc.fontSize(10).font('Helvetica').text('Deposits for all customized products are non-refundable. Balance payment is due in full upon installation and completion of the project or the services provided, unless an installment method is chosen.', M, y2, {width:CW});
  y2+=40;

  doc.moveTo(M,y2).lineTo(W-M,y2).lineWidth(0.5).stroke(GREY_LINE);y2+=14;

  doc.fontSize(10).font('Helvetica-Bold').text('Please have the Customer initial on the line to confirm critical details for the chosen products:', M, y2, {width:CW});y2+=22;

  const bullets = [
    'Sheer weave and screen weave blinds do not offer privacy at night when lights are on indoors.',
    'Zebra and Roller Shades will have large gaps in bay/bow window installation.',
    'All inside mount blinds and shades will have light gaps between product and frame to allow for smooth operation.',
    'No products or applications offer 100% light filtration or blackout.',
    'Customer is aware that "gaps" will be prevalent where blinds and shades butt together.',
    'Customer will move all the furniture and obstructions prior to the arrival of the installer.',
    'Customer will remove all existing tracks, blinds and drapes prior to the installer\'s arrival.\n(If required, please consult with your sales representative about surcharges)',
    'Customer will dispose of all garbage associated with the installation.\n(If required, please consult with your sales representative about surcharges)',
  ];
  bullets.forEach(b => {
    doc.fontSize(9).font('Helvetica').fillColor(DARK);
    doc.text('•', M+8, y2);
    const lines = b.split('\n');
    lines.forEach((line,li) => {
      doc.font(li>0?'Helvetica':'Helvetica').fillColor(li>0?LGREY:DARK).fontSize(li>0?8:9);
      const h = doc.heightOfString(line, {width:CW-30});
      doc.text(line, M+22, y2, {width:CW-30});
      y2 += h + 3;
    });
    y2 += 2;
  });
  y2+=6;

  doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK).text('Thank you for placing your order with Soho Blinds Canada. We will make our best efforts to ensure that your custom made products are processed in a timely manner. We trust that you will be satisfied with the product and services we provide.', M, y2, {width:CW});
  y2+=38;
  doc.text('Should you have any questions on your order or require a status update, please feel free to contact our office at 204-475-7646 (SOHO) or email us at info@sohoblinds.ca', M, y2, {width:CW});
  y2+=28;

  doc.moveTo(M,y2).lineTo(W-M,y2).lineWidth(0.5).stroke(GREY_LINE);y2+=14;
  doc.fontSize(10).font('Helvetica-Bold').text('By initializing this page, customer agrees that you have read and accepted all the terms and conditions and product information mentioned above.', M, y2, {width:CW});
  y2+=32;
  doc.fontSize(11).text('Initial here: _______________', M, y2);

  // Footer
  const yF = 720;
  doc.moveTo(M,yF).lineTo(W-M,yF).lineWidth(0.5).stroke(GREY_LINE);
  doc.fontSize(10).font('Helvetica-Bold').fillColor(ORANGE).text('Thank you for your business!', M, yF+10, {width:CW,align:'center'});
  doc.fontSize(9).font('Helvetica').fillColor(LGREY).text(`${doc_type.charAt(0)+doc_type.slice(1).toLowerCase()} generated on ${fmtDate(q.created_at)}`, M, yF+26, {width:CW,align:'center'});
  doc.text(`This ${doc_type.toLowerCase()} is valid for 30 days from the date above.`, M, yF+40, {width:CW,align:'center'});

  return doc;
}

app.get('/api/quotes/:id/pdf', requireAuth, ownerAdminSales, async (req, res) => {
  try {
    const doc_type = req.query.type === 'invoice' ? 'INVOICE' : 'QUOTE';
    const { data: q } = await supabase.from('quotes_view').select('*').eq('id', req.params.id).single();
    if (!q) return res.status(404).json({ error: 'Not found' });
    const { data: items } = await supabase.from('quote_items_view').select('*').eq('quote_id', q.id).order('id');

    const doc = generateQuotePDF(doc_type, q, items || []);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc_type}-${q.quote_number}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch(e) {
    console.error('PDF generation error:', e.message);
    res.status(500).json({ error: 'PDF generation failed: ' + e.message });
  }
});

// ─── TASKS ────────────────────────────────────────────────────────────────────

app.get('/api/tasks', requireAuth, async (req, res) => {
  const { role, id } = req.user;
  let q = supabase.from('tasks_detail').select('*');
  if (role !== 'owner' && role !== 'admin') q = q.eq('assigned_to', id);
  const { data } = await q.order('due_date').order('priority', { ascending: false });
  res.json(data || []);
});
app.post('/api/tasks', requireAuth, async (req, res) => {
  const { title, description, assigned_to, job_id, priority, due_date } = req.body;
  const { data } = await supabase.from('tasks').insert({
    title, description, assigned_to: assigned_to||null, created_by: req.user.id,
    job_id: job_id||null, priority: priority||'medium', due_date: due_date||null
  }).select().single();
  const { data: full } = await supabase.from('tasks_detail').select('*').eq('id', data.id).single();
  res.json(full);
});
app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const { status, title, description, assigned_to, priority, due_date } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (status) updates.status = status; if (title) updates.title = title;
  if (description != null) updates.description = description;
  if (assigned_to != null) updates.assigned_to = assigned_to;
  if (priority) updates.priority = priority; if (due_date != null) updates.due_date = due_date;
  await supabase.from('tasks').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('tasks').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  await supabase.from('tasks').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── CALENDAR ─────────────────────────────────────────────────────────────────

app.get('/api/calendar', requireAuth, async (req, res) => {
  const { role, id } = req.user;
  const { month, year } = req.query;
  let q = supabase.from('calendar_detail').select('*');
  if (month && year) {
    const start = `${year}-${String(month).padStart(2,'0')}-01`;
    const nextM = parseInt(month) === 12 ? 1 : parseInt(month)+1;
    const nextY = parseInt(month) === 12 ? parseInt(year)+1 : parseInt(year);
    const end = `${nextY}-${String(nextM).padStart(2,'0')}-01`;
    q = q.gte('start_date', start).lt('start_date', end);
  }
  if (role === 'installer' || role === 'factory') q = q.eq('assigned_to', id);
  const { data } = await q.order('start_date');
  res.json(data || []);
});
app.post('/api/calendar', requireAuth, ownerAdmin, async (req, res) => {
  const { title, event_type, job_id, assigned_to, start_date, end_date, notes } = req.body;
  const { data } = await supabase.from('calendar_events').insert({
    title, event_type: event_type||'other', job_id: job_id||null,
    assigned_to: assigned_to||null, start_date, end_date: end_date||null,
    notes: notes||null, created_by: req.user.id
  }).select().single();
  res.json(data);
});
app.patch('/api/calendar/:id', requireAuth, ownerAdmin, async (req, res) => {
  const { title, event_type, job_id, assigned_to, start_date, end_date, notes } = req.body;
  const updates = {};
  if (title) updates.title = title; if (event_type) updates.event_type = event_type;
  if (job_id != null) updates.job_id = job_id; if (assigned_to != null) updates.assigned_to = assigned_to;
  if (start_date) updates.start_date = start_date; if (end_date != null) updates.end_date = end_date;
  if (notes != null) updates.notes = notes;
  await supabase.from('calendar_events').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('calendar_events').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.delete('/api/calendar/:id', requireAuth, ownerAdmin, async (req, res) => {
  await supabase.from('calendar_events').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── FABRICS ──────────────────────────────────────────────────────────────────

app.get('/api/fabrics', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'private, max-age=120');
  const { data } = await supabase.from('fabrics_view').select('*').eq('active', true).order('catalogue_no');
  res.json(data || []);
});
app.post('/api/fabrics', requireAuth, warehouseRoles, async (req, res) => {
  const { catalogue_no, series, alias, colour_hex, slat_size, roll_qty, total_meters } = req.body;
  const { data, error } = await supabase.from('fabrics').insert({
    catalogue_no, series, alias, colour_hex: colour_hex||'#cccccc',
    slat_size: slat_size||3, roll_qty: roll_qty||0, total_meters: total_meters||0
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  const { data: full } = await supabase.from('fabrics_view').select('*').eq('id', data.id).single();
  res.json(full);
});
app.patch('/api/fabrics/:id', requireAuth, warehouseRoles, async (req, res) => {
  const { alias, colour_hex, roll_qty, total_meters, active } = req.body;
  const updates = {};
  if (alias) updates.alias = alias; if (colour_hex) updates.colour_hex = colour_hex;
  if (roll_qty != null) updates.roll_qty = roll_qty; if (total_meters != null) updates.total_meters = total_meters;
  if (active != null) updates.active = active;
  await supabase.from('fabrics').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('fabrics_view').select('*').eq('id', req.params.id).single();
  res.json(data);
});

// ─── HARDWARE ─────────────────────────────────────────────────────────────────

app.get('/api/hardware', requireAuth, async (req, res) => {
  const { data } = await supabase.from('hardware_view').select('*').eq('active', true).order('category');
  res.json(data || []);
});
app.post('/api/hardware', requireAuth, warehouseRoles, async (req, res) => {
  const { category, item_code, description, unit, total_qty } = req.body;
  const { data } = await supabase.from('hardware_items').insert({
    category, item_code, description, unit: unit||'meters', total_qty: total_qty||0
  }).select().single();
  const { data: full } = await supabase.from('hardware_view').select('*').eq('id', data.id).single();
  res.json(full);
});
app.patch('/api/hardware/:id', requireAuth, warehouseRoles, async (req, res) => {
  const { total_qty, used_qty } = req.body;
  const updates = {};
  if (total_qty != null) updates.total_qty = total_qty;
  if (used_qty != null) updates.used_qty = used_qty;
  await supabase.from('hardware_items').update(updates).eq('id', req.params.id);
  const { data } = await supabase.from('hardware_view').select('*').eq('id', req.params.id).single();
  res.json(data);
});

// ─── SHIPMENTS ────────────────────────────────────────────────────────────────

app.get('/api/shipments', requireAuth, warehouseRoles, async (req, res) => {
  const { data: shipments } = await supabase.from('shipments').select('*').order('date_received', { ascending: false });
  const result = [];
  for (const s of (shipments||[])) {
    const { data: items } = await supabase.from('shipment_items_view').select('*').eq('shipment_id', s.id);
    result.push({ ...s, items: items||[] });
  }
  res.json(result);
});
app.post('/api/shipments', requireAuth, warehouseRoles, async (req, res) => {
  const { supplier, reference, date_received, notes, items } = req.body;
  const { data: ship } = await supabase.from('shipments').insert({ supplier, reference, date_received, notes }).select().single();
  for (const item of (items||[])) {
    await supabase.from('shipment_items').insert({ shipment_id: ship.id, item_type: item.item_type, item_id: item.item_id, qty_received: item.qty_received });
    if (item.item_type === 'fabric') {
      const { data: f } = await supabase.from('fabrics').select('*').eq('id', item.item_id).single();
      if (f) {
        await supabase.from('fabrics').update({ total_meters: f.total_meters + item.qty_received }).eq('id', item.item_id);
        await logMovement('fabric', item.item_id, f.alias, 'received', item.qty_received, null, ship.id, `Shipment #${ship.id}`);
      }
    } else {
      const { data: h } = await supabase.from('hardware_items').select('*').eq('id', item.item_id).single();
      if (h) {
        await supabase.from('hardware_items').update({ total_qty: h.total_qty + item.qty_received }).eq('id', item.item_id);
        await logMovement('hardware', item.item_id, h.description, 'received', item.qty_received, null, ship.id, `Shipment #${ship.id}`);
      }
    }
  }
  res.json({ id: ship.id });
});

// ─── TRANSFERS ────────────────────────────────────────────────────────────────

app.get('/api/transfers', requireAuth, async (req, res) => {
  const { data: transfers } = await supabase.from('transfers_view').select('*').order('created_at', { ascending: false });
  const result = [];
  for (const t of (transfers||[])) {
    const { data: items } = await supabase.from('transfer_items').select('*').eq('transfer_id', t.id);
    result.push({ ...t, items: items||[] });
  }
  res.json(result);
});
app.post('/api/transfers', requireAuth, warehouseRoles, async (req, res) => {
  const { from_location, to_location, job_id, notes, items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items' });
  const transfer_no = await genNumber('transfers', 'transfer_no', 'TRF');
  const { data: t } = await supabase.from('transfers').insert({ transfer_no, from_location, to_location, job_id: job_id||null, notes: notes||null }).select().single();
  for (const i of items) {
    await supabase.from('transfer_items').insert({ transfer_id: t.id, item_type: i.item_type, item_id: i.item_id, item_name: i.item_name, qty: i.qty });
    await logMovement(i.item_type, i.item_id, i.item_name, 'transferred', i.qty, job_id||null, null, `${from_location} → ${to_location} | ${transfer_no}`);
  }
  res.json({ id: t.id, transfer_no });
});
app.patch('/api/transfers/:id/complete', requireAuth, async (req, res) => {
  await supabase.from('transfers').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/transfers/:id', requireAuth, warehouseRoles, async (req, res) => {
  await supabase.from('transfers').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── MOVEMENTS ────────────────────────────────────────────────────────────────

app.get('/api/movements', requireAuth, warehouseRoles, async (req, res) => {
  const { data } = await supabase.from('movements').select('*').order('created_at', { ascending: false }).limit(200);
  res.json(data || []);
});

// ─── PRODUCTION ──────────────────────────────────────────────────────────────

app.get('/api/production', requireAuth, async (req, res) => {
  const { data } = await supabase.from('production_queue').select('*').order('date_due').order('job_number').order('window_no');
  res.json(data || []);
});

app.get('/api/production/stats', requireAuth, async (req, res) => {
  const { data } = await supabase.from('production_queue').select('production_status');
  const counts = { pending:0, cutting:0, cut:0, assembling:0, assembled:0, qc_pass:0, qc_fail:0, packing:0, packed:0 };
  (data||[]).forEach(w => { counts[w.production_status] = (counts[w.production_status]||0)+1; });
  res.json(counts);
});

app.patch('/api/windows/:id/production', requireAuth, async (req, res) => {
  const { action, notes } = req.body;
  const name = req.user.name;
  const now = new Date().toISOString();
  const updates = {};

  if (action === 'start_cut') { updates.production_status = 'cutting'; }
  else if (action === 'finish_cut') { updates.production_status = 'cut'; updates.cut_at = now; updates.cut_by = name; }
  else if (action === 'start_assemble') { updates.production_status = 'assembling'; }
  else if (action === 'finish_assemble') { updates.production_status = 'assembled'; updates.assembled_at = now; updates.assembled_by = name; }
  else if (action === 'qc_pass') { updates.production_status = 'qc_pass'; updates.qc_status = 'pass'; updates.qc_at = now; updates.qc_by = name; updates.qc_notes = notes||''; }
  else if (action === 'qc_fail') { updates.production_status = 'qc_fail'; updates.qc_status = 'fail'; updates.qc_at = now; updates.qc_by = name; updates.qc_notes = notes||''; }
  else if (action === 'start_pack') { updates.production_status = 'packing'; }
  else if (action === 'finish_pack') { updates.production_status = 'packed'; updates.packed_at = now; updates.packed_by = name; }
  else if (action === 'rework') { updates.production_status = 'assembling'; updates.qc_status = null; updates.qc_at = null; updates.qc_by = null; updates.qc_notes = notes ? 'REWORK: '+notes : 'Sent back for rework'; }
  else { return res.status(400).json({ error: 'Invalid action' }); }

  const { error } = await supabase.from('job_windows').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  // Auto-update job status based on window production states
  const { data: win } = await supabase.from('job_windows').select('job_id').eq('id', req.params.id).single();
  if (win) {
    const { data: allWins } = await supabase.from('job_windows').select('production_status').eq('job_id', win.job_id);
    const statuses = (allWins||[]).map(w => w.production_status);
    let jobStatus = 'in_production';
    if (statuses.every(s => s === 'packed')) jobStatus = 'ready';
    else if (statuses.some(s => s !== 'pending')) jobStatus = 'in_production';
    await supabase.from('jobs').update({ status: jobStatus }).eq('id', win.job_id);
  }

  const { data: updated } = await supabase.from('production_queue').select('*').eq('id', req.params.id).single();
  res.json(updated);
});

// ─── CUT SHEET ────────────────────────────────────────────────────────────────

app.get('/api/jobs/:id/cutsheet', requireAuth, async (req, res) => {
  const { data: job } = await supabase.from('job_detail').select('*').eq('id', req.params.id).single();
  if (!job) return res.status(404).json({ error: 'Not found' });
  job.phone = job.client_phone; delete job.client_phone;
  const { data: windows } = await supabase.from('windows_detail').select('*').eq('job_id', req.params.id).order('window_no');
  res.json({ job, windows: windows||[] });
});

// ─── REPORTS (owner) ──────────────────────────────────────────────────────────

app.get('/api/reports', requireAuth, requireRole('owner'), async (req, res) => {
  // Jobs by status
  const { data: allJobs } = await supabase.from('jobs').select('status,rep,created_at');
  const statusCounts = {}; (allJobs||[]).forEach(j => { statusCounts[j.status] = (statusCounts[j.status]||0)+1; });
  const jobsByStatus = Object.entries(statusCounts).map(([status,count]) => ({ status, count }));
  // Jobs by rep
  const repCounts = {}; (allJobs||[]).forEach(j => { repCounts[j.rep||'Unknown'] = (repCounts[j.rep||'Unknown']||0)+1; });
  const jobsByRep = Object.entries(repCounts).map(([rep,count]) => ({ rep, count })).sort((a,b) => b.count-a.count);
  // Top clients
  const { data: clientJobs } = await supabase.from('jobs_list').select('client_name,client_id');
  const clientCounts = {}; (clientJobs||[]).forEach(j => { if(j.client_name) clientCounts[j.client_name] = (clientCounts[j.client_name]||0)+1; });
  const topClients = Object.entries(clientCounts).map(([name,job_count]) => ({ name, job_count })).sort((a,b) => b.job_count-a.job_count).slice(0,8);
  // Quote revenue
  const { data: quotes } = await supabase.from('quotes').select('status,total');
  const qrMap = {}; (quotes||[]).forEach(q => { if(!qrMap[q.status]) qrMap[q.status]={status:q.status,count:0,revenue:0}; qrMap[q.status].count++; qrMap[q.status].revenue+=(q.total||0); });
  const quoteRevenue = Object.values(qrMap);
  // Monthly jobs (last 6 months)
  const sixAgo = new Date(); sixAgo.setMonth(sixAgo.getMonth()-6);
  const monthly = {}; (allJobs||[]).forEach(j => { if(j.created_at >= sixAgo.toISOString()){ const m=j.created_at.substring(0,7); monthly[m]=(monthly[m]||0)+1; }});
  const monthlyJobs = Object.entries(monthly).sort().map(([month,count]) => ({ month, count }));
  res.json({ jobsByStatus, jobsByRep, topClients, quoteRevenue, monthlyJobs });
});

// ─── SEED ────────────────────────────────────────────────────────────────────

async function seed() {
  // Use hardcoded service_role key (same as /api/reset-all) to guarantee write access regardless of env vars
  const admin = createClient(
    'https://tntmgwukdzzeknlfmotz.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRudG1nd3VrZHp6ZWtubGZtb3R6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDU3MTI1MCwiZXhwIjoyMDk2MTQ3MjUwfQ.593no0oW97qNYCNgGtFNdnIhoSEVsaTke7PYc9gepvk',
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { count, error: countErr } = await admin.from('users').select('*', { count: 'exact', head: true });
  if (countErr) { console.error('Seed check failed — did you run schema.sql in Supabase SQL Editor?', countErr.message); return; }
  if (count > 0) { console.log('Database already seeded (' + count + ' users found)'); return; }

  const hash = p => bcrypt.hashSync(p, 10);
  const users = [
    { name:'Owner Account', email:'owner@soho.ca', password_hash:hash('owner123'), role:'owner', active:true },
    { name:'Office Admin', email:'admin@soho.ca', password_hash:hash('admin123'), role:'admin', active:true },
    { name:'Sales Rep', email:'sales@soho.ca', password_hash:hash('sales123'), role:'sales', active:true },
    { name:'Warehouse Team', email:'warehouse@soho.ca', password_hash:hash('warehouse123'), role:'warehouse', active:true },
    { name:'Installer', email:'installer@soho.ca', password_hash:hash('installer123'), role:'installer', active:true },
    { name:'Factory Floor', email:'factory@soho.ca', password_hash:hash('factory123'), role:'factory', active:true },
  ];
  const { error: ue } = await admin.from('users').insert(users);
  if (ue) { console.error('Failed to seed users:', ue.message); return; }

  // Only seed reference data if it doesn't exist yet
  const { count: profileCount } = await admin.from('profiles').select('*', { count: 'exact', head: true });
  if (profileCount > 0) { console.log('Reference data already exists, skipping'); return; }

  const profiles = [
    { code:'A', blind_type:'zebra', cassette_ded:-0.375, roller_ded:-1.0625, bottom_rail_ded:-1.0625, bottom_core_ded:-1.25, description:'Flat Zebra + Regular Clutch + Wands + S. Cord' },
    { code:'B', blind_type:'zebra', cassette_ded:-0.375, roller_ded:-0.875, bottom_rail_ded:-0.875, bottom_core_ded:-1.0625, description:'Flat Zebra + 1cm Clutch + Wands + S. Cords + Motor' },
    { code:'C', blind_type:'zebra', cassette_ded:-0.3125, roller_ded:-0.75, bottom_rail_ded:-0.75, bottom_core_ded:-0.875, description:'Round Combi (White only) + Zebra + 1cm Clutch + Motors' },
    { code:'D', blind_type:'zebra', cassette_ded:-0.3125, roller_ded:-0.5625, bottom_rail_ded:-0.5625, bottom_core_ded:-0.6875, description:'Cordless mechanism' },
    { code:'E', blind_type:'roller', cassette_ded:0, roller_ded:-1.125, bottom_rail_ded:-1.125, bottom_core_ded:0, description:'Roller without cassette — Regular clutch only' },
    { code:'F', blind_type:'roller', cassette_ded:-0.375, roller_ded:-1.0625, bottom_rail_ded:-1.0625, bottom_core_ded:0, description:'Roller + Flat Cassette + Heavy Rail + Regular Clutch' },
    { code:'G', blind_type:'roller', cassette_ded:-0.375, roller_ded:-0.875, bottom_rail_ded:-0.875, bottom_core_ded:0, description:'Roller + Flat Cassette + 1cm Clutch + Motor' },
    { code:'H', blind_type:'roller', cassette_ded:-0.3125, roller_ded:-0.75, bottom_rail_ded:-0.75, bottom_core_ded:-0.875, description:'2026 Combi Flat Case + Dual Rollers' },
    { code:'I', blind_type:'zebra', cassette_ded:-0.3125, roller_ded:-0.75, bottom_rail_ded:-0.75, bottom_core_ded:-0.875, description:'Flat Zebra + Tubular Motor' },
    { code:'J', blind_type:'roller', cassette_ded:-0.375, roller_ded:-1.0, bottom_rail_ded:-1.0, bottom_core_ded:0, description:'Flat Roller + Tubular Motor' },
  ];
  await admin.from('profiles').insert(profiles);

  const fabrics = [
    { catalogue_no:'Z1A', series:'Exotic Matte', alias:'Matte Ivory', colour_hex:'#F5F0E8', slat_size:3, roll_qty:3, total_meters:138, used_meters:311.29 },
    { catalogue_no:'Z1B', series:'Exotic Matte', alias:'Matte Sand', colour_hex:'#D4B896', slat_size:3, roll_qty:4, total_meters:200, used_meters:407.02 },
    { catalogue_no:'Z1C', series:'Exotic Matte', alias:'Matte Silver', colour_hex:'#C0C0C0', slat_size:3, roll_qty:5, total_meters:250, used_meters:859.38 },
    { catalogue_no:'Z1D', series:'Exotic Matte', alias:'Matte Gray', colour_hex:'#808080', slat_size:3, roll_qty:7, total_meters:350, used_meters:196.84 },
    { catalogue_no:'Z1E', series:'Exotic Matte', alias:'Matte Gold', colour_hex:'#C9A84C', slat_size:3, roll_qty:3, total_meters:158, used_meters:94.11 },
    { catalogue_no:'Z1F', series:'Exotic Matte', alias:'Matte Brown', colour_hex:'#8B4513', slat_size:3, roll_qty:3, total_meters:150, used_meters:176.89 },
    { catalogue_no:'Z1G', series:'Exotic Matte', alias:'Dark Chocolate', colour_hex:'#3D1C02', slat_size:3, roll_qty:0, total_meters:50, used_meters:243.27 },
    { catalogue_no:'Z1H', series:'Exotic Matte', alias:'Matte Cream', colour_hex:'#FFFDD0', slat_size:3, roll_qty:0, total_meters:30, used_meters:0 },
    { catalogue_no:'Z2A', series:'Mysterious', alias:'Mysterious Ivory', colour_hex:'#F0EBD8', slat_size:3.875, roll_qty:15, total_meters:750, used_meters:0 },
    { catalogue_no:'Z2B', series:'Mysterious', alias:'Mysterious Beige', colour_hex:'#E8DCC8', slat_size:3.875, roll_qty:15, total_meters:750, used_meters:0 },
    { catalogue_no:'Z2C', series:'Mysterious', alias:'Mysterious Sand', colour_hex:'#C8A882', slat_size:3.875, roll_qty:5, total_meters:252, used_meters:70.96 },
    { catalogue_no:'Z2D', series:'Mysterious', alias:'Mysterious Gray', colour_hex:'#A0A0A0', slat_size:3.875, roll_qty:3, total_meters:150, used_meters:80.24 },
  ];
  await admin.from('fabrics').insert(fabrics);

  const hardware = [
    { category:'Valance / Head Rail', item_code:'F5 Head Rail', description:'F5 white headrail 0.95mm - 5.8m lengths', unit:'meters', total_qty:2958, used_qty:2135.44 },
    { category:'Core Roller', item_code:'38mm Tube BD38', description:'38mm silvery roller tube 1.0mm - 5.8m lengths', unit:'meters', total_qty:2958, used_qty:2135.44 },
    { category:'Bottom Rail', item_code:'ZB31015', description:'Bottom rail 1.0mm white - 5.8m lengths', unit:'meters', total_qty:2366.4, used_qty:2135.44 },
    { category:'Bottom Core', item_code:'Tube 15mm', description:'Inner bottom core 1.3mm white - 5.8m lengths', unit:'meters', total_qty:2366.4, used_qty:2135.44 },
    { category:'End Caps', item_code:'End Cap BR', description:'Bottom rail end caps white', unit:'count', total_qty:2000, used_qty:1775 },
    { category:'Clutches', item_code:'F5TYY', description:'38mm clutch chain 1.2m white', unit:'count', total_qty:2500, used_qty:1659 },
    { category:'Brackets - Inside', item_code:'CBY38 Ceiling', description:'Inside mount ceiling bracket nickel 38mm', unit:'count', total_qty:4000, used_qty:3583 },
    { category:'Brackets - Outside', item_code:'WBY38 Wall', description:'Outside mount wall bracket galvanized 38mm', unit:'count', total_qty:1000, used_qty:405 },
    { category:'Stick Tape Valance', item_code:'Stick Strip 77mm', description:'Stick strip 77mm adhesive', unit:'meters', total_qty:1500, used_qty:2135.44 },
    { category:'PVC Valance Sheet', item_code:'PVC F5 78mm', description:'PVC sheet for F5 headrail 78mm', unit:'meters', total_qty:3000, used_qty:0 },
    { category:'Stick Strip Gray', item_code:'Stick Tape 12mm', description:'Stick tape 12mm gray adhesive', unit:'meters', total_qty:3500, used_qty:4270.88 },
  ];
  await admin.from('hardware_items').insert(hardware);

  console.log('Database seeded with default users and inventory');
}

// ─── START ────────────────────────────────────────────────────────────────────

// Vercel: export the app; Local: listen on PORT
if (process.env.VERCEL) {
  seed().catch(err => console.error('Seed error:', err.message));
  module.exports = app;
} else {
  seed().then(() => {
    app.listen(PORT, () => {
      console.log(`\nNovus running at http://localhost:${PORT}\n`);
      console.log('Default logins:');
      console.log('  owner@soho.ca     / owner123');
      console.log('  admin@soho.ca     / admin123');
      console.log('  sales@soho.ca     / sales123');
      console.log('  warehouse@soho.ca / warehouse123');
      console.log('  installer@soho.ca / installer123');
      console.log('  factory@soho.ca   / factory123\n');
    });
  }).catch(err => {
    console.error('Seed error:', err.message);
    app.listen(PORT, () => console.log(`\nNovus running at http://localhost:${PORT}\n`));
  });
}
