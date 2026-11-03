// Mock Supabase for the headless test harness. Zero npm dependencies.
//
// Exports MOCK_SOURCE: one self-contained classic-script string that replaces window.supabase
// with an in-memory mock and seeds window.__MOCK_DB before any page script runs.
//
// Inject with CDP before navigation:
//   await client.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_SOURCE });
//
// Why a getter instead of a plain assignment: index.html loads the real supabase-js UMD from a
// CDN *after* the document-start script. The UMD bundle assigns `window.supabase = factory()` at
// load time, so a plain `window.supabase = mock` would be clobbered. The accessor keeps the mock
// authoritative (the real library is stashed on window.__REAL_SUPABASE for debugging).
//
// The builder mirrors the subset of PostgREST / supabase-js the app actually uses, plus
// upsert(onConflict) and the usual convenience filters so feature modules can rely on it.

export const MOCK_SOURCE = String.raw`(function () {
  'use strict';

  if (window.__MOCK_SUPABASE__) return;

  /* ========================================================================
     Deterministic ids and dates
     ======================================================================== */
  var NOW = new Date();
  function pad2(n) { return ('0' + n).slice(-2); }
  function isoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function offsetDate(days) { var d = new Date(NOW.getTime()); d.setDate(d.getDate() + days); return isoDate(d); }
  function offsetTs(days) { return new Date(NOW.getTime() + days * 86400000).toISOString(); }
  function sid(prefix, n) { return prefix + '0000000-0000-4000-8000-' + ('000000000000' + n).slice(-12); }
  var TODAY = isoDate(NOW);
  var UUID_SEQ = 0;
  function newUuid() {
    UUID_SEQ += 1;
    var hex = UUID_SEQ.toString(16);
    while (hex.length < 12) hex = '0' + hex;
    return 'f0000000-0000-4000-8000-' + hex;
  }
  function clone(value) {
    if (value === null || value === undefined) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }
  var PHOTO_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  var PHOTO_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  /* ========================================================================
     Seeded fixtures (deterministic ids, realistic UAE construction data)
     ======================================================================== */
  var companyId = sid('a', 1);
  var profiles = {
    director: { id: sid('b', 1), username: 'director', name: 'Hamed Al Kitbi', role: 'director', email: 'director@example.com', phone: '+971 50 111 2233', created_at: offsetTs(-400) },
    controller: { id: sid('b', 2), username: 'controller', name: 'Fatima Al Mansoori', role: 'controller', email: 'controller@example.com', phone: '+971 50 444 5566', created_at: offsetTs(-390) },
    super: { id: sid('b', 3), username: 'super', name: 'Ravi Kumar', role: 'super', email: 'super@example.com', phone: '+971 55 777 8899', created_at: offsetTs(-300) },
    lead: { id: sid('b', 4), username: 'lead', name: 'Ahmed Hassan', role: 'lead', email: 'lead@example.com', phone: '+971 56 222 3344', created_at: offsetTs(-200) }
  };
  var projectA = sid('c', 1);
  var projectB = sid('c', 2);
  var boq = {
    prelim: sid('d', 1),
    excav: sid('d', 2),
    hardcore: sid('d', 3),
    foundations: sid('d', 4),
    columns: sid('d', 5),
    steel: sid('d', 6),
    electrical: sid('d', 7),
    blockwork: sid('d', 8),
    canopy: sid('d', 9)
  };
  var workerIds = [sid('e', 1), sid('e', 2), sid('e', 3), sid('e', 4), sid('e', 5), sid('e', 6)];

  var SEED = {};

  SEED.companies = [{
    id: companyId,
    name: 'Al Nakheel Contracting LLC',
    address: 'Warehouse 12, Al Quoz Industrial Area 3, Dubai, UAE',
    phone: '+971 4 555 0192',
    email: 'accounts@alnakheel-contracting.ae',
    website: 'https://alnakheel-contracting.ae',
    tax_id: '100234567800003',
    logo_data: null,
    created_at: offsetTs(-420)
  }];

  SEED.profiles = [
    Object.assign({}, profiles.director, { active: true }),
    Object.assign({}, profiles.controller, { active: true }),
    Object.assign({}, profiles.super, { active: true }),
    Object.assign({}, profiles.lead, { active: true })
  ];

  SEED.projects = [{
    id: projectA,
    company_id: companyId,
    code: 'PRJ-001',
    name: 'Al Barsha G+M Warehouse',
    client: 'Emaar Retail LLC',
    client_trn: '100456789000003',
    consultant_name: 'Dar Al Handasah',
    pm_name: 'Khalid Rahman',
    location: 'Al Barsha South, Dubai',
    plot_no: '361-1247',
    permit_no: 'BLD-2026-0451',
    project_scope: 'G+M Warehouse',
    bua_sqm: 4850.5,
    power_kw: 250,
    contract_value_aed: 12500000,
    retention_pct: 10,
    advance_payment_pct: 10,
    advance_aed: 1250000,
    dlp_months: 12,
    start_date: offsetDate(-210),
    finish_date: offsetDate(240),
    status: 'active',
    is_active: true,
    created_at: offsetTs(-215)
  }, {
    id: projectB,
    company_id: companyId,
    code: 'PRJ-002',
    name: 'JVC G+1 Villa',
    client: 'Private Client - Al Suwaidi',
    client_trn: null,
    consultant_name: 'Arab Engineering Bureau',
    pm_name: 'Sara Al Ali',
    location: 'Jumeirah Village Circle, Dubai',
    plot_no: 'JVC-15-092',
    permit_no: 'BLD-2026-1120',
    project_scope: 'G+1 Villa',
    bua_sqm: 612.75,
    power_kw: 45,
    contract_value_aed: 2850000,
    retention_pct: 10,
    advance_payment_pct: 5,
    advance_aed: 142500,
    dlp_months: 12,
    start_date: offsetDate(-95),
    finish_date: offsetDate(280),
    status: 'active',
    is_active: true,
    created_at: offsetTs(-100)
  }];

  SEED.company_budget_lines = [
    { id: sid('f', 1), company_id: companyId, category: 'Salaries', description: 'Office and site staff payroll', budget_aed: 2400000, actual_aed: 1985000, created_at: offsetTs(-410) },
    { id: sid('f', 2), company_id: companyId, category: 'Rent', description: 'Head office and yard lease', budget_aed: 420000, actual_aed: 315000, created_at: offsetTs(-410) },
    { id: sid('f', 3), company_id: companyId, category: 'Utilities', description: 'DEWA, water and internet', budget_aed: 96000, actual_aed: 74200, created_at: offsetTs(-410) },
    { id: sid('f', 4), company_id: companyId, category: 'Marketing', description: 'Tender advertising and website', budget_aed: 120000, actual_aed: 45300, created_at: offsetTs(-410) },
    { id: sid('f', 5), company_id: companyId, category: 'Transport', description: 'Fleet fuel, salik and maintenance', budget_aed: 380000, actual_aed: 291400, created_at: offsetTs(-410) },
    { id: sid('f', 6), company_id: companyId, category: 'Insurance', description: 'CAR, public liability and plant', budget_aed: 265000, actual_aed: 265000, created_at: offsetTs(-410) }
  ];

  SEED.budget_lines = [
    { id: sid('a', 11), project_id: projectA, code: '01', description: 'Preliminaries & site establishment', category: 'Preliminaries', trade: 'PRELIM', budget_aed: 450000, actual_aed: 410000, ev_pct: 0.82, pv_pct: 0.85, created_at: offsetTs(-210) },
    { id: sid('a', 12), project_id: projectA, code: '02', description: 'Earthworks & substructure', category: 'Civil', trade: 'CONC', budget_aed: 380000, actual_aed: 395000, ev_pct: 0.92, pv_pct: 0.9, created_at: offsetTs(-210) },
    { id: sid('a', 13), project_id: projectA, code: '03', description: 'Reinforced concrete works', category: 'Civil', trade: 'CONC', budget_aed: 2400000, actual_aed: 2280000, ev_pct: 0.88, pv_pct: 0.86, created_at: offsetTs(-210) },
    { id: sid('a', 14), project_id: projectA, code: '04', description: 'Structural steel package', category: 'Steel', trade: 'STEL', budget_aed: 3100000, actual_aed: 2600000, ev_pct: 0.78, pv_pct: 0.8, created_at: offsetTs(-210) },
    { id: sid('a', 15), project_id: projectA, code: '05', description: 'MEP package', category: 'MEP', trade: 'ELEC', budget_aed: 1900000, actual_aed: 1200000, ev_pct: 0.55, pv_pct: 0.6, created_at: offsetTs(-210) },
    { id: sid('a', 16), project_id: projectA, code: '06', description: 'Finishes & joinery', category: 'Finishes', trade: 'DRYW', budget_aed: 1200000, actual_aed: 300000, ev_pct: 0.2, pv_pct: 0.25, created_at: offsetTs(-210) },
    { id: sid('b', 11), project_id: projectB, code: '01', description: 'Preliminaries', category: 'Preliminaries', trade: 'PRELIM', budget_aed: 185000, actual_aed: 92000, ev_pct: 0.5, pv_pct: 0.55, created_at: offsetTs(-95) },
    { id: sid('b', 12), project_id: projectB, code: '02', description: 'Substructure & frame', category: 'Civil', trade: 'CONC', budget_aed: 950000, actual_aed: 410000, ev_pct: 0.42, pv_pct: 0.45, created_at: offsetTs(-95) },
    { id: sid('b', 13), project_id: projectB, code: '03', description: 'MEP first fix', category: 'MEP', trade: 'ELEC', budget_aed: 320000, actual_aed: 95000, ev_pct: 0.28, pv_pct: 0.3, created_at: offsetTs(-95) },
    { id: sid('b', 14), project_id: projectB, code: '04', description: 'Finishes', category: 'Finishes', trade: 'DRYW', budget_aed: 410000, actual_aed: 48000, ev_pct: 0.1, pv_pct: 0.12, created_at: offsetTs(-95) }
  ];

  SEED.boq_items = [
    { id: boq.prelim, project_id: projectA, section: 'PRELIMINARIES', code: '1.1', description: 'Site establishment, hoarding and temporary facilities', unit: 'LS', quantity: 1, rate: 450000, sort_order: 1, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.excav, project_id: projectA, section: 'EARTHWORKS', code: '2.1', description: 'Excavation and disposal of unsuitable material', unit: 'm3', quantity: 4200, rate: 38, sort_order: 2, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.hardcore, project_id: projectA, section: 'EARTHWORKS', code: '2.2', description: 'Blinding and hardcore to substructure', unit: 'm3', quantity: 380, rate: 145, sort_order: 3, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.foundations, project_id: projectA, section: 'CONCRETE', code: '3.1', description: 'Reinforced concrete grade 35/20 to foundations', unit: 'm3', quantity: 1450, rate: 620, sort_order: 4, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.columns, project_id: projectA, section: 'CONCRETE', code: '3.2', description: 'Reinforced concrete to columns and beams', unit: 'm3', quantity: 860, rate: 780, sort_order: 5, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.steel, project_id: projectA, section: 'STEEL STRUCTURE', code: '4.1', description: 'Structural steel columns, rafters and purlins', unit: 'ton', quantity: 210, rate: 9800, sort_order: 6, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.electrical, project_id: projectA, section: 'MEP', code: '5.1', description: 'Electrical containment, cabling and distribution', unit: 'LS', quantity: 1, rate: 1250000, sort_order: 7, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.blockwork, project_id: projectA, section: 'FINISHES', code: '6.1', description: 'Blockwork and plaster to office area', unit: 'm2', quantity: 1850, rate: 145, sort_order: 8, status: 'approved', created_at: offsetTs(-209) },
    { id: boq.canopy, project_id: projectA, section: 'VARIATIONS', code: '7.1', description: 'Additional canopy over loading bay (proposed)', unit: 'LS', quantity: 1, rate: 185000, sort_order: 9, status: 'pending', created_at: offsetTs(-4) },
    { id: sid('d', 21), project_id: projectB, section: 'PRELIMINARIES', code: '1.1', description: 'Site setup and protection', unit: 'LS', quantity: 1, rate: 185000, sort_order: 1, status: 'approved', created_at: offsetTs(-94) },
    { id: sid('d', 22), project_id: projectB, section: 'STRUCTURE', code: '2.1', description: 'Raft foundation and ground beams', unit: 'm3', quantity: 210, rate: 650, sort_order: 2, status: 'approved', created_at: offsetTs(-94) },
    { id: sid('d', 23), project_id: projectB, section: 'STRUCTURE', code: '2.2', description: 'Columns, beams and slabs', unit: 'm3', quantity: 160, rate: 820, sort_order: 3, status: 'approved', created_at: offsetTs(-94) },
    { id: sid('d', 24), project_id: projectB, section: 'MEP', code: '3.1', description: 'Electrical and plumbing first fix', unit: 'LS', quantity: 1, rate: 320000, sort_order: 4, status: 'approved', created_at: offsetTs(-94) }
  ];

  SEED.materials = [
    { id: sid('c', 1), project_id: projectA, boq_item_id: boq.foundations, po_number: 'PO-2051', invoice_no: 'INV-88421', supplier: 'Emirates Ready Mix', trade: 'CONC', description: 'Ready-mix concrete C35/20', quantity: 320, unit: 'm3', unit_cost_aed: 285, baseline_cost_aed: 285, stage: 'Delivered', invoice_date: offsetDate(-40), source: 'manual', status: 'approved', created_at: offsetTs(-40) },
    { id: sid('c', 2), project_id: projectA, boq_item_id: boq.steel, po_number: 'PO-2052', invoice_no: 'AGS-9921', supplier: 'Al Ghurair Steel', trade: 'STEL', description: 'Structural steel sections and plates', quantity: 85, unit: 'ton', unit_cost_aed: 9850, baseline_cost_aed: 9850, stage: 'Installed', invoice_date: offsetDate(-32), source: 'manual', status: 'approved', created_at: offsetTs(-32) },
    { id: sid('c', 3), project_id: projectA, boq_item_id: boq.hardcore, po_number: 'PO-2057', invoice_no: 'GSA-3311', supplier: 'Gulf Sand & Aggregate', trade: 'CONC', description: 'Crushed aggregate and hardcore fill', quantity: 500, unit: 'm3', unit_cost_aed: 145, baseline_cost_aed: 145, stage: 'Installed', invoice_date: offsetDate(-28), source: 'manual', status: 'approved', created_at: offsetTs(-28) },
    { id: sid('c', 4), project_id: projectA, boq_item_id: boq.electrical, po_number: 'PO-2053', invoice_no: null, supplier: 'Danube Electricals', trade: 'ELEC', description: 'LV panels, cable trays and containment', quantity: 1, unit: 'LS', unit_cost_aed: 240000, baseline_cost_aed: 240000, stage: 'Ordered', invoice_date: offsetDate(-6), source: 'manual', status: 'pending', created_at: offsetTs(-6) },
    { id: sid('c', 5), project_id: projectA, boq_item_id: boq.blockwork, po_number: 'PO-2054', invoice_no: null, supplier: 'Al Quoz Block Factory', trade: 'CONC', description: 'AAC blocks 200mm', quantity: 12000, unit: 'pcs', unit_cost_aed: 3.4, baseline_cost_aed: 3.4, stage: 'In Transit', invoice_date: offsetDate(-3), source: 'manual', status: 'pending', created_at: offsetTs(-3) },
    { id: sid('c', 6), project_id: projectA, boq_item_id: null, po_number: 'PO-2055', invoice_no: 'SFT-1180', supplier: 'Safety First Trading', trade: 'HEQV', description: 'PPE, harnesses and site safety signage', quantity: 1, unit: 'LS', unit_cost_aed: 18500, baseline_cost_aed: 18500, stage: 'Delivered', invoice_date: offsetDate(-12), source: 'manual', status: 'approved', created_at: offsetTs(-12) },
    { id: sid('c', 7), project_id: projectB, boq_item_id: sid('d', 22), po_number: 'PO-3101', invoice_no: 'INV-91220', supplier: 'Emirates Ready Mix', trade: 'CONC', description: 'Ready-mix concrete C40/20 raft', quantity: 110, unit: 'm3', unit_cost_aed: 305, baseline_cost_aed: 305, stage: 'Delivered', invoice_date: offsetDate(-20), source: 'manual', status: 'approved', created_at: offsetTs(-20) }
  ];

  SEED.timesheets = [
    { id: sid('f', 1), project_id: projectA, boq_item_id: boq.foundations, employee_name: 'Muhammad Asif', trade: 'CONC', work_date: offsetDate(-5), reg_hours: 8, ot_hours: 2, total_hours: 10, rate_aed: 22, total_cost_aed: 242, status: 'approved', approved_by: 'Hamed Al Kitbi', created_at: offsetTs(-5) },
    { id: sid('f', 2), project_id: projectA, boq_item_id: boq.steel, employee_name: 'Ahmed Hassan', trade: 'STEL', work_date: offsetDate(-4), reg_hours: 8, ot_hours: 4, total_hours: 12, rate_aed: 28, total_cost_aed: 392, status: 'approved', approved_by: 'Fatima Al Mansoori', created_at: offsetTs(-4) },
    { id: sid('f', 3), project_id: projectA, boq_item_id: boq.electrical, employee_name: 'Joseph Mwangi', trade: 'ELEC', work_date: offsetDate(-3), reg_hours: 8, ot_hours: 0, total_hours: 8, rate_aed: 24, total_cost_aed: 192, status: 'approved', approved_by: 'Hamed Al Kitbi', created_at: offsetTs(-3) },
    { id: sid('f', 4), project_id: projectA, boq_item_id: boq.blockwork, employee_name: 'Sunil Perera', trade: 'HVAC', work_date: offsetDate(-2), reg_hours: 9, ot_hours: 1, total_hours: 10, rate_aed: 25, total_cost_aed: 262.5, status: 'pending', approved_by: null, created_at: offsetTs(-2) },
    { id: sid('f', 5), project_id: projectA, boq_item_id: boq.prelim, employee_name: 'Ravi Kumar', trade: 'CONC', work_date: offsetDate(-1), reg_hours: 8, ot_hours: 3, total_hours: 11, rate_aed: 30, total_cost_aed: 375, status: 'pending', approved_by: null, created_at: offsetTs(-1) },
    { id: sid('f', 6), project_id: projectB, boq_item_id: sid('d', 22), employee_name: 'Muhammad Asif', trade: 'CONC', work_date: offsetDate(-6), reg_hours: 8, ot_hours: 0, total_hours: 8, rate_aed: 22, total_cost_aed: 176, status: 'approved', approved_by: 'Hamed Al Kitbi', created_at: offsetTs(-6) }
  ];

  SEED.payments = [
    { id: sid('a', 21), project_id: projectA, payment_type: 'received', invoice_no: 'ADV-001', description: 'Mobilisation advance from client', amount: 1250000, due_date: offsetDate(-180), paid_date: offsetDate(-175), status: 'paid', payment_method: 'Bank Transfer', created_by: 'Fatima Al Mansoori', created_at: offsetTs(-180) },
    { id: sid('a', 22), project_id: projectA, payment_type: 'received', invoice_no: 'IPC-001', description: 'Interim payment certificate 01 (part)', amount: 850000, due_date: offsetDate(-55), paid_date: offsetDate(-48), status: 'paid', payment_method: 'Cheque', created_by: 'Fatima Al Mansoori', created_at: offsetTs(-60) },
    { id: sid('a', 23), project_id: projectA, payment_type: 'pending', invoice_no: 'IPC-002', description: 'Interim payment certificate 02 - awaiting client release', amount: 420000, due_date: offsetDate(12), paid_date: null, status: 'pending', payment_method: 'Bank Transfer', created_by: 'Fatima Al Mansoori', created_at: offsetTs(-20) },
    { id: sid('a', 24), project_id: projectA, payment_type: 'invoice', invoice_no: 'SUP-3311', description: 'Supplier invoice - Gulf Sand & Aggregate', amount: 96500, due_date: offsetDate(5), paid_date: null, status: 'overdue', payment_method: 'Bank Transfer', created_by: 'Hamed Al Kitbi', created_at: offsetTs(-28) },
    { id: sid('a', 25), project_id: projectB, payment_type: 'received', invoice_no: 'ADV-201', description: 'Advance payment - villa project', amount: 142500, due_date: offsetDate(-80), paid_date: offsetDate(-78), status: 'paid', payment_method: 'Bank Transfer', created_by: 'Fatima Al Mansoori', created_at: offsetTs(-80) }
  ];

  SEED.progress_billings = [
    { id: sid('b', 21), project_id: projectA, billing_no: 'PB-001', period_from: offsetDate(-60), period_to: offsetDate(-31), completion_pct: 25, retention_pct: 10, status: 'certified', total_claim: 3100000, retention_amount: 310000, net_payable: 2480000, previous_billed: 0, advance_recovery_pct: 10, advance_recovery_amount: 310000, current_net_excl_vat: 2480000, vat_pct: 5, vat_amount: 124000, total_payable_inc_vat: 2604000, created_by: 'Hamed Al Kitbi', created_at: offsetTs(-30) },
    { id: sid('b', 22), project_id: projectA, billing_no: 'PB-002', period_from: offsetDate(-30), period_to: offsetDate(-1), completion_pct: 37.2, retention_pct: 10, status: 'paid', total_claim: 4650000, retention_amount: 465000, net_payable: 3720000, previous_billed: 2480000, advance_recovery_pct: 10, advance_recovery_amount: 465000, current_net_excl_vat: 1240000, vat_pct: 5, vat_amount: 62000, total_payable_inc_vat: 1302000, created_by: 'Fatima Al Mansoori', created_at: offsetTs(-2) }
  ];

  SEED.project_parties = [
    { id: sid('c', 21), project_id: projectA, party_type: 'customer', name: 'Emaar Retail LLC', company_name: 'Emaar Retail LLC', contact_person: 'Mariam Al Zaabi', phone: '+971 4 366 1234', email: 'projects@emaar-retail.ae', address: 'Emaar Square, Downtown Dubai', notes: 'Client representative for IPC certification', created_at: offsetTs(-215) },
    { id: sid('c', 22), project_id: projectA, party_type: 'consultant', name: 'Dar Al Handasah', company_name: 'Dar Al Handasah (Shair & Partners)', contact_person: 'Elie Haddad', phone: '+971 4 336 5511', email: 'elie.haddad@dar.com', address: 'Al Quoz, Dubai', notes: 'Site supervision and payment certification', created_at: offsetTs(-215) },
    { id: sid('c', 23), project_id: projectA, party_type: 'subcontractor', name: 'Rapid MEP Works LLC', company_name: 'Rapid MEP Works LLC', contact_person: 'Sanjay Menon', phone: '+971 55 401 7788', email: 'sanjay@rapidmep.ae', address: 'Ras Al Khor, Dubai', notes: 'Electrical and plumbing subcontract - 8% of contract', created_at: offsetTs(-190) },
    { id: sid('c', 24), project_id: projectA, party_type: 'supplier', name: 'Emirates Ready Mix', company_name: 'Emirates Ready Mix LLC', contact_person: 'Omar Farooq', phone: '+971 4 885 2200', email: 'sales@emiratesreadymix.ae', address: 'Al Aweer, Dubai', notes: 'Concrete supplier - net 30', created_at: offsetTs(-190) },
    { id: sid('c', 25), project_id: projectB, party_type: 'customer', name: 'Private Client - Al Suwaidi', company_name: 'Private Client', contact_person: 'Juma Al Suwaidi', phone: '+971 50 998 1122', email: 'juma.alsuwaidi@example.com', address: 'JVC, Dubai', notes: 'Owner-occupied villa', created_at: offsetTs(-95) },
    { id: sid('c', 26), project_id: projectB, party_type: 'consultant', name: 'Arab Engineering Bureau', company_name: 'Arab Engineering Bureau', contact_person: 'Noor Khalifa', phone: '+971 4 444 8811', email: 'noor@aeb.qa', address: 'Doha / Dubai', notes: 'Design and supervision consultant', created_at: offsetTs(-95) }
  ];

  SEED.site_reports = [
    { id: sid('d', 21), project_id: projectA, report_date: offsetDate(-2), title: 'Steel erection - grid C to F completed', weather: 'Sunny', temperature: 36, workforce_count: 42, activities: 'Completed rafter erection over grid C-F. Torque checked 80% of purlins.\nSecond concrete pour to columns 3.2 prepared.', issues: 'Crane permit renewal pending from DDA.', safety_notes: 'Toolbox talk on working at height. All harnesses inspected.', photos: [{ name: 'steel-grid-cf.jpg', data: PHOTO_A }, { name: 'column-pour-prep.jpg', data: PHOTO_B }], created_by: 'Ravi Kumar', created_at: offsetTs(-2) },
    { id: sid('d', 22), project_id: projectA, report_date: offsetDate(-9), title: 'Foundations handover walk with consultant', weather: 'Hazy', temperature: 33, workforce_count: 38, activities: 'Consultant inspected foundation reinforcement and approved for pour. Waterproofing completed to raft edge.', issues: null, safety_notes: 'Excavation edges barricaded.', photos: [{ name: 'raft-inspection.jpg', data: PHOTO_B }], created_by: 'Khalid Rahman', created_at: offsetTs(-9) },
    { id: sid('d', 23), project_id: projectB, report_date: offsetDate(-4), title: 'Raft concrete pour', weather: 'Hot', temperature: 39, workforce_count: 14, activities: 'Poured 110 m3 C40/20 raft. Slump tests passed.', issues: null, safety_notes: 'Concrete pump exclusion zone signed off.', photos: [], created_by: 'Ahmed Hassan', created_at: offsetTs(-4) }
  ];

  SEED.workers = [
    { id: workerIds[0], company_id: companyId, staff_no: 'EMP-0001', name: 'Ravi Kumar', role: 'Supervisor', trade: 'CONC', nationality: 'Indian', phone: '+971 55 101 2020', email: 'ravi.kumar@alnakheel-contracting.ae', join_date: offsetDate(-720), passport_no: 'P2847711', passport_expiry: offsetDate(400), emirates_id: '784-1986-4455667-1', emirates_id_expiry: offsetDate(200), visa_no: 'V-887766', visa_expiry: offsetDate(120), work_permit_no: 'WP-112233', work_permit_expiry: offsetDate(25), work_permit_renewal_due: offsetDate(20), status: 'active', notes: '<!--sfpay:{"salary":6500,"loan":4000,"deduct":800}-->\nForklift and working-at-height certified.' },
    { id: workerIds[1], company_id: companyId, staff_no: 'EMP-0002', name: 'Ahmed Hassan', role: 'Foreman', trade: 'STEL', nationality: 'Egyptian', phone: '+971 56 222 3344', email: 'ahmed.hassan@alnakheel-contracting.ae', join_date: offsetDate(-650), passport_no: 'A1932770', passport_expiry: offsetDate(300), emirates_id: '784-1988-2233445-2', emirates_id_expiry: offsetDate(150), visa_no: 'V-551122', visa_expiry: offsetDate(90), work_permit_no: 'WP-445566', work_permit_expiry: offsetDate(180), work_permit_renewal_due: offsetDate(170), status: 'active', notes: '<!--sfpay:{"salary":5800,"loan":0,"deduct":0}-->\nSteel fixing and rigging lead.' },
    { id: workerIds[2], company_id: companyId, staff_no: 'EMP-0003', name: 'Muhammad Asif', role: 'Worker', trade: 'CONC', nationality: 'Pakistani', phone: '+971 55 778 9012', email: null, join_date: offsetDate(-500), passport_no: 'AP774122', passport_expiry: offsetDate(210), emirates_id: '784-1992-9988776-3', emirates_id_expiry: offsetDate(60), visa_no: 'V-339911', visa_expiry: offsetDate(-5), work_permit_no: 'WP-778899', work_permit_expiry: offsetDate(-5), work_permit_renewal_due: offsetDate(-10), status: 'active', notes: '<!--sfpay:{"salary":3200,"loan":2500,"deduct":500}-->\nRenewal documents with PRO.' },
    { id: workerIds[3], company_id: companyId, staff_no: 'EMP-0004', name: 'Joseph Mwangi', role: 'Worker', trade: 'ELEC', nationality: 'Kenyan', phone: '+971 54 334 5566', email: null, join_date: offsetDate(-380), passport_no: 'K1188334', passport_expiry: offsetDate(500), emirates_id: '784-1994-5566778-4', emirates_id_expiry: offsetDate(300), visa_no: 'V-445533', visa_expiry: offsetDate(140), work_permit_no: 'WP-223344', work_permit_expiry: offsetDate(140), work_permit_renewal_due: offsetDate(130), status: 'active', notes: '<!--sfpay:{"salary":3000,"loan":1200,"deduct":300}-->\nElectrical helper.' },
    { id: workerIds[4], company_id: companyId, staff_no: 'EMP-0005', name: 'Sunil Perera', role: 'Worker', trade: 'HVAC', nationality: 'Sri Lankan', phone: '+971 52 665 7788', email: null, join_date: offsetDate(-290), passport_no: 'SL998877', passport_expiry: offsetDate(380), emirates_id: '784-1990-1122334-5', emirates_id_expiry: offsetDate(120), visa_no: 'V-998822', visa_expiry: offsetDate(110), work_permit_no: 'WP-556677', work_permit_expiry: offsetDate(115), work_permit_renewal_due: offsetDate(105), status: 'active', notes: '<!--sfpay:{"salary":3100,"loan":0,"deduct":0}-->\nHVAC ducting installer.' },
    { id: workerIds[5], company_id: companyId, staff_no: 'EMP-0006', name: 'Bikash Thapa', role: 'Worker', trade: 'DRYW', nationality: 'Nepali', phone: '+971 50 221 3344', email: null, join_date: offsetDate(-800), passport_no: 'NP445511', passport_expiry: offsetDate(-30), emirates_id: null, emirates_id_expiry: null, visa_no: null, visa_expiry: null, work_permit_no: 'WP-112299', work_permit_expiry: offsetDate(30), work_permit_renewal_due: offsetDate(25), status: 'inactive', notes: '<!--sfpay:{"salary":2800,"loan":0,"deduct":0}-->\nOn leave - no active permit renewal.' }
  ];

  SEED.payroll_batches = [
    { id: sid('e', 21), project_id: projectA, period: '2026-09', worker_count: 42, gross_aed: 128400, net_aed: 121700, certified_at: offsetTs(-34), created_at: offsetTs(-34) },
    { id: sid('e', 22), project_id: projectA, period: '2026-10', worker_count: 44, gross_aed: 134900, net_aed: 127400, certified_at: offsetTs(-3), created_at: offsetTs(-3) },
    { id: sid('e', 23), project_id: projectB, period: '2026-10', worker_count: 14, gross_aed: 41200, net_aed: 39900, certified_at: offsetTs(-3), created_at: offsetTs(-3) }
  ];

  SEED.company_expenses = [
    { id: sid('f', 21), company_id: companyId, category: 'Salaries', description: 'September staff payroll transfer', amount: 185000, expense_date: offsetDate(-30), paid_to: 'WPS Bank', payment_method: 'Bank Transfer', created_by: 'Fatima Al Mansoori', status: 'approved', created_at: offsetTs(-30) },
    { id: sid('f', 22), company_id: companyId, category: 'Rent', description: 'Office rent Q3', amount: 32000, expense_date: offsetDate(-25), paid_to: 'Al Quoz Properties', payment_method: 'Cheque', created_by: 'Fatima Al Mansoori', status: 'approved', created_at: offsetTs(-25) },
    { id: sid('f', 23), company_id: companyId, category: 'Utilities', description: 'DEWA bill - yard and office', amount: 4800, expense_date: offsetDate(-12), paid_to: 'DEWA', payment_method: 'Credit Card', created_by: 'Ravi Kumar', status: 'pending', created_at: offsetTs(-12) },
    { id: sid('f', 24), company_id: companyId, category: 'Office Supplies', description: 'Printing and stationery', amount: 2350, expense_date: offsetDate(-8), paid_to: 'Office Depot', payment_method: 'Cash', created_by: 'Fatima Al Mansoori', status: 'approved', bill_path: companyId + '/expenses/bill-2350.jpg', created_at: offsetTs(-8) },
    { id: sid('f', 25), company_id: companyId, category: 'Transport', description: 'Fleet fuel - August', amount: 6700, expense_date: offsetDate(-6), paid_to: 'ENOC', payment_method: 'Credit Card', created_by: 'Ravi Kumar', status: 'approved', created_at: offsetTs(-6) },
    { id: sid('f', 26), company_id: companyId, category: 'Equipment', description: 'Generator rental - site 2', amount: 12500, expense_date: offsetDate(-2), paid_to: 'Al Faris Equipment', payment_method: 'Cheque', created_by: 'Ravi Kumar', status: 'pending', created_at: offsetTs(-2) }
  ];

  SEED.compliance_documents = [
    { id: sid('a', 31), company_id: companyId, doc_type: 'Trade License', doc_number: 'DL-772311', issuer: 'Dubai Economy & Tourism', issue_date: offsetDate(-300), expiry_date: offsetDate(200), renewal_due_date: offsetDate(190), payment_due_date: null, amount: 12500, notes: 'Renew annually', status: 'active', created_at: offsetTs(-300) },
    { id: sid('a', 32), company_id: companyId, doc_type: 'Commercial License', doc_number: 'CL-887766', issuer: 'Dubai Municipality', issue_date: offsetDate(-340), expiry_date: offsetDate(20), renewal_due_date: offsetDate(10), payment_due_date: null, amount: 9400, notes: null, status: 'active', created_at: offsetTs(-340) },
    { id: sid('a', 33), company_id: companyId, doc_type: 'Insurance', doc_number: 'POL-99112', issuer: 'Oman Insurance', issue_date: offsetDate(-375), expiry_date: offsetDate(-12), renewal_due_date: offsetDate(-15), payment_due_date: null, amount: 48000, notes: 'CAR and public liability', status: 'active', created_at: offsetTs(-375) },
    { id: sid('a', 34), company_id: companyId, doc_type: 'Vehicle Registration', doc_number: 'V-445533', issuer: 'RTA', issue_date: offsetDate(-320), expiry_date: offsetDate(45), renewal_due_date: offsetDate(40), payment_due_date: null, amount: 2100, notes: 'Toyota Hilux fleet', status: 'active', created_at: offsetTs(-320) },
    { id: sid('a', 35), company_id: companyId, doc_type: 'Fire Safety Certificate', doc_number: 'FSC-33221', issuer: 'Civil Defence', issue_date: offsetDate(-325), expiry_date: offsetDate(30), renewal_due_date: offsetDate(10), payment_due_date: offsetDate(5), amount: 6800, notes: 'Yard and warehouse', status: 'active', created_at: offsetTs(-325) }
  ];

  SEED.transaction_history = [
    { id: sid('d', 31), user_id: profiles.director.id, user_name: 'Hamed Al Kitbi', user_role: 'director', action: 'approve', table_name: 'approvals', record_id: null, record_label: 'Batch approve 3 - AED 42,500.00', project_id: projectA, before_data: null, after_data: { status: 'approved', count: 3 }, created_at: offsetTs(-1) },
    { id: sid('d', 32), user_id: profiles.controller.id, user_name: 'Fatima Al Mansoori', user_role: 'controller', action: 'create', table_name: 'progress_billings', record_id: sid('b', 22), record_label: 'PB-002', project_id: projectA, before_data: null, after_data: { total_claim: 4650000, status: 'paid' }, created_at: offsetTs(-2) },
    { id: sid('d', 33), user_id: profiles.super.id, user_name: 'Ravi Kumar', user_role: 'super', action: 'create', table_name: 'site_reports', record_id: sid('d', 21), record_label: 'Steel erection - grid C to F completed', project_id: projectA, before_data: null, after_data: { title: 'Steel erection - grid C to F completed' }, created_at: offsetTs(-2) },
    { id: sid('d', 34), user_id: profiles.director.id, user_name: 'Hamed Al Kitbi', user_role: 'director', action: 'update', table_name: 'materials', record_id: sid('c', 3), record_label: 'Crushed aggregate and hardcore fill', project_id: projectA, before_data: { status: 'pending' }, after_data: { status: 'approved' }, created_at: offsetTs(-4) },
    { id: sid('d', 35), user_id: profiles.controller.id, user_name: 'Fatima Al Mansoori', user_role: 'controller', action: 'create', table_name: 'progress_billings', record_id: sid('b', 21), record_label: 'PB-001', project_id: projectA, before_data: null, after_data: { total_claim: 3100000, status: 'certified' }, created_at: offsetTs(-30) },
    { id: sid('d', 36), user_id: profiles.director.id, user_name: 'Hamed Al Kitbi', user_role: 'director', action: 'delete', table_name: 'change_orders', record_id: sid('a', 41), record_label: 'CO-003 - Removed scope', project_id: projectA, before_data: { status: 'rejected' }, after_data: null, created_at: offsetTs(-40) },
    { id: sid('d', 37), user_id: profiles.super.id, user_name: 'Ravi Kumar', user_role: 'super', action: 'create', table_name: 'timesheets', record_id: sid('f', 5), record_label: 'Ravi Kumar', project_id: projectA, before_data: null, after_data: { status: 'pending', total_hours: 11 }, created_at: offsetTs(-1) },
    { id: sid('d', 38), user_id: profiles.controller.id, user_name: 'Fatima Al Mansoori', user_role: 'controller', action: 'create', table_name: 'payments', record_id: sid('a', 23), record_label: 'Interim payment certificate 02 - awaiting client release', project_id: projectA, before_data: null, after_data: { amount: 420000, status: 'pending' }, created_at: offsetTs(-20) }
  ];

  SEED.audit_log = [
    { id: sid('e', 31), project_id: projectA, ts: offsetTs(-1), user_name: 'Hamed Al Kitbi', user_role: 'director', action: 'approve', detail: 'Approved 3 pending items (AED 42,500.00)' },
    { id: sid('e', 32), project_id: projectA, ts: offsetTs(-2), user_name: 'Ravi Kumar', user_role: 'super', action: 'create', detail: 'Created site report "Steel erection - grid C to F completed"' },
    { id: sid('e', 33), project_id: projectA, ts: offsetTs(-3), user_name: 'Fatima Al Mansoori', user_role: 'controller', action: 'update', detail: 'Updated material PO-2054 status to pending' },
    { id: sid('e', 34), project_id: projectA, ts: offsetTs(-5), user_name: 'Ahmed Hassan', user_role: 'lead', action: 'create', detail: 'Logged timesheet for Sunil Perera (10 h)' },
    { id: sid('e', 35), project_id: projectA, ts: offsetTs(-9), user_name: 'Khalid Rahman', user_role: 'super', action: 'create', detail: 'Created site report "Foundations handover walk with consultant"' }
  ];

  SEED.notifications = [
    { id: sid('f', 31), title: 'BOQ line awaiting certification', body: '7.1 Additional canopy over loading bay (AED 185,000.00)', is_read: false, created_at: offsetTs(-4) },
    { id: sid('f', 32), title: 'Work permit expiring', body: 'Muhammad Asif - Work Permit expired 5 days ago', is_read: false, created_at: offsetTs(-5) },
    { id: sid('f', 33), title: 'IPC-002 awaiting client release', body: 'AED 420,000.00 due in 12 days', is_read: false, created_at: offsetTs(-20) },
    { id: sid('f', 34), title: 'Budget overrun detected', body: 'Hardcore to substructure: actual exceeds BOQ budget', is_read: true, created_at: offsetTs(-28) }
  ];

  SEED.payment_requests = [
    { id: sid('a', 41), project_id: projectA, request_no: 'PR-001', party_type: 'subcontractor', party_name: 'Rapid MEP Works LLC', party_id: sid('c', 23), description: 'Electrical first fix - milestone 1', amount_aed: 185000, status: 'pending', requested_by: 'Sanjay Menon', approved_by: null, paid_date: null, created_at: offsetTs(-6) },
    { id: sid('a', 42), project_id: projectA, request_no: 'PR-002', party_type: 'supplier', party_name: 'Emirates Ready Mix', party_id: sid('c', 24), description: 'Concrete supply - September statement', amount_aed: 96500, status: 'approved', requested_by: 'Omar Farooq', approved_by: 'Fatima Al Mansoori', paid_date: null, created_at: offsetTs(-15) },
    { id: sid('a', 43), project_id: projectA, request_no: 'PR-003', party_type: 'subcontractor', party_name: 'Rapid MEP Works LLC', party_id: sid('c', 23), description: 'Plumbing rough-in - milestone 1', amount_aed: 74000, status: 'paid', requested_by: 'Sanjay Menon', approved_by: 'Hamed Al Kitbi', paid_date: offsetDate(-18), created_at: offsetTs(-40) },
    { id: sid('a', 44), project_id: projectB, request_no: 'PR-004', party_type: 'subcontractor', party_name: 'Desert Interiors LLC', party_id: null, description: 'Gypsum and painting advance', amount_aed: 55000, status: 'pending', requested_by: 'Faisal Noor', approved_by: null, paid_date: null, created_at: offsetTs(-2) }
  ];

  SEED.payslips = [
    { id: sid('b', 31), project_id: projectA, worker_id: workerIds[0], worker_name: 'Ravi Kumar', period: '2026-10', gross_aed: 6500, deductions_aed: 800, net_aed: 5700, status: 'paid', created_at: offsetTs(-3) },
    { id: sid('b', 32), project_id: projectA, worker_id: workerIds[1], worker_name: 'Ahmed Hassan', period: '2026-10', gross_aed: 5800, deductions_aed: 0, net_aed: 5800, status: 'paid', created_at: offsetTs(-3) },
    { id: sid('b', 33), project_id: projectA, worker_id: workerIds[2], worker_name: 'Muhammad Asif', period: '2026-10', gross_aed: 3200, deductions_aed: 500, net_aed: 2700, status: 'certified', created_at: offsetTs(-3) },
    { id: sid('b', 34), project_id: projectA, worker_id: workerIds[3], worker_name: 'Joseph Mwangi', period: '2026-10', gross_aed: 3000, deductions_aed: 300, net_aed: 2700, status: 'draft', created_at: offsetTs(-3) }
  ];

  SEED.finance_settings = [
    { id: sid('c', 31), company_id: companyId, currency: 'AED', vat_pct: 5, retention_pct: 10, fiscal_year_start: '2026-01-01', updated_at: offsetTs(-120) }
  ];

  SEED.drawings = [
    { id: sid('d', 41), project_id: projectA, title: 'Architectural General Arrangement Plan', revision: 'C', category: 'Architectural', description: 'Ground floor layout with warehouse racking', file_path: projectA + '/drawings/aga-rev-c.pdf', file_name: 'AGA-Rev-C.pdf', file_size: 5242880, mime_type: 'application/pdf', status: 'current', uploaded_by: 'Khalid Rahman', created_at: offsetTs(-40) },
    { id: sid('d', 42), project_id: projectA, title: 'Structural Steel Connection Details', revision: 'B', category: 'Structural', description: 'Rafter to column moment connections', file_path: projectA + '/drawings/steel-details-rev-b.pdf', file_name: 'Steel-Details-Rev-B.pdf', file_size: 2097152, mime_type: 'application/pdf', status: 'current', uploaded_by: 'Khalid Rahman', created_at: offsetTs(-35) },
    { id: sid('d', 43), project_id: projectA, title: 'MEP Single Line Diagram', revision: 'A', category: 'MEP', description: 'LV distribution single line diagram', file_path: projectA + '/drawings/mep-sld-rev-a.pdf', file_name: 'MEP-SLD-Rev-A.pdf', file_size: 1048576, mime_type: 'application/pdf', status: 'current', uploaded_by: 'Ravi Kumar', created_at: offsetTs(-22) },
    { id: sid('d', 44), project_id: projectA, title: 'Architectural General Arrangement Plan', revision: 'B', category: 'Architectural', description: 'Superseded by rev C', file_path: projectA + '/drawings/aga-rev-b.pdf', file_name: 'AGA-Rev-B.pdf', file_size: 4718592, mime_type: 'application/pdf', status: 'superseded', uploaded_by: 'Khalid Rahman', created_at: offsetTs(-90) }
  ];

  SEED.attachments = [
    { id: sid('e', 41), project_id: projectA, entity_type: 'site_report', entity_id: sid('d', 21), file_name: 'steel-grid-cf.jpg', file_path: projectA + '/reports/steel-grid-cf.jpg', file_size: 1450000, mime_type: 'image/jpeg', uploaded_by: 'Ravi Kumar', created_at: offsetTs(-2) },
    { id: sid('e', 42), project_id: projectA, entity_type: 'drawing', entity_id: sid('d', 43), file_name: 'MEP-SLD-Rev-A.pdf', file_path: projectA + '/drawings/mep-sld-rev-a.pdf', file_size: 1048576, mime_type: 'application/pdf', uploaded_by: 'Ravi Kumar', created_at: offsetTs(-22) },
    { id: sid('e', 43), project_id: projectB, entity_type: 'site_report', entity_id: sid('d', 23), file_name: 'raft-pour.jpg', file_path: projectB + '/reports/raft-pour.jpg', file_size: 980000, mime_type: 'image/jpeg', uploaded_by: 'Ahmed Hassan', created_at: offsetTs(-4) }
  ];

  SEED.schedule_items = [
    { id: sid('f', 41), project_id: projectA, name: 'Mobilisation & site establishment', start_date: offsetDate(-210), end_date: offsetDate(-180), progress: 100, status: 'completed', assigned_to: 'Ravi Kumar', created_at: offsetTs(-210) },
    { id: sid('f', 42), project_id: projectA, name: 'Excavation & foundations', start_date: offsetDate(-180), end_date: offsetDate(-110), progress: 100, status: 'completed', assigned_to: 'Muhammad Asif', created_at: offsetTs(-180) },
    { id: sid('f', 43), project_id: projectA, name: 'Concrete frame & columns', start_date: offsetDate(-110), end_date: offsetDate(-20), progress: 82, status: 'in-progress', assigned_to: 'Ahmed Hassan', created_at: offsetTs(-110) },
    { id: sid('f', 44), project_id: projectA, name: 'Structural steel erection', start_date: offsetDate(-50), end_date: offsetDate(40), progress: 55, status: 'in-progress', assigned_to: 'Ahmed Hassan', created_at: offsetTs(-50) },
    { id: sid('f', 45), project_id: projectA, name: 'MEP first fix', start_date: offsetDate(-15), end_date: offsetDate(90), progress: 18, status: 'in-progress', assigned_to: 'Joseph Mwangi', created_at: offsetTs(-15) },
    { id: sid('f', 46), project_id: projectA, name: 'Finishes & handover', start_date: offsetDate(90), end_date: offsetDate(240), progress: 0, status: 'planned', assigned_to: null, created_at: offsetTs(-15) },
    { id: sid('f', 47), project_id: projectB, name: 'Substructure', start_date: offsetDate(-95), end_date: offsetDate(-10), progress: 100, status: 'completed', assigned_to: 'Ravi Kumar', created_at: offsetTs(-95) },
    { id: sid('f', 48), project_id: projectB, name: 'Superstructure', start_date: offsetDate(-10), end_date: offsetDate(120), progress: 25, status: 'in-progress', assigned_to: 'Ahmed Hassan', created_at: offsetTs(-10) }
  ];

  SEED.change_orders = [
    { id: sid('a', 42), project_id: projectA, co_number: 'CO-001', description: 'Upgraded fire-rated glazing to office block', amount: 85000, status: 'approved', created_at: offsetTs(-45) },
    { id: sid('a', 43), project_id: projectA, co_number: 'CO-002', description: 'Additional drainage run to loading bay', amount: 42500, status: 'pending', created_at: offsetTs(-3) },
    { id: sid('a', 44), project_id: projectA, co_number: 'CO-003', description: 'Removed landscape scope (client instruction)', amount: -18000, status: 'rejected', created_at: offsetTs(-40) }
  ];

  SEED.password_reset_requests = [];

  var DB = {};
  Object.keys(SEED).forEach(function (table) { DB[table] = clone(SEED[table]); });
  var INITIAL_COPY = clone(DB);
  window.__MOCK_DB = DB;
  window.__MOCK_SEED = INITIAL_COPY;

  /* ========================================================================
     Auth mock
     ======================================================================== */
  var authSession = null;
  var authListeners = [];

  function emitAuth(event, session) {
    authListeners.slice().forEach(function (cb) {
      try { cb(event, session); } catch (e) { /* listener errors stay in the page */ }
    });
  }
  function profileByEmail(email) {
    var wanted = String(email || '').trim().toLowerCase();
    var rows = DB.profiles || [];
    for (var i = 0; i < rows.length; i += 1) {
      var p = rows[i];
      if (String(p.email || '').toLowerCase() === wanted) return p;
      if (String(p.username || '').toLowerCase() === wanted) return p;
    }
    return null;
  }
  function sessionFor(profile) {
    return {
      access_token: 'mock-access-token-' + profile.id,
      refresh_token: 'mock-refresh-token-' + profile.id,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: profile.id,
        aud: 'authenticated',
        role: 'authenticated',
        email: profile.email,
        email_confirmed_at: profile.created_at,
        user_metadata: { name: profile.name, username: profile.username },
        created_at: profile.created_at
      }
    };
  }
  function authError(message, status) {
    return { message: message, status: status || 400, code: 'mock_auth_error' };
  }
  var auth = {
    signInWithPassword: function (creds) {
      var email = creds && creds.email;
      var password = creds && creds.password;
      var profile = profileByEmail(email);
      if (!profile || !password) {
        return Promise.resolve({ data: { user: null, session: null }, error: authError('Invalid login credentials') });
      }
      if (profile.active === false) {
        return Promise.resolve({ data: { user: null, session: null }, error: authError('Account disabled') });
      }
      authSession = sessionFor(profile);
      emitAuth('SIGNED_IN', authSession);
      return Promise.resolve({ data: { user: authSession.user, session: authSession }, error: null });
    },
    getSession: function () {
      return Promise.resolve({ data: { session: authSession }, error: null });
    },
    setSession: function (tokens) {
      if (!authSession) {
        return Promise.resolve({ data: { session: null }, error: authError('No session to refresh') });
      }
      if (tokens && tokens.access_token) authSession.access_token = tokens.access_token;
      if (tokens && tokens.refresh_token) authSession.refresh_token = tokens.refresh_token;
      return Promise.resolve({ data: { session: authSession, user: authSession.user }, error: null });
    },
    refreshSession: function () {
      return Promise.resolve({ data: { session: authSession }, error: authSession ? null : authError('No session') });
    },
    onAuthStateChange: function (cb) {
      authListeners.push(cb);
      return {
        data: {
          subscription: {
            unsubscribe: function () {
              var i = authListeners.indexOf(cb);
              if (i >= 0) authListeners.splice(i, 1);
            }
          }
        }
      };
    },
    signOut: function () {
      authSession = null;
      emitAuth('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    },
    updateUser: function (attrs) {
      if (!authSession) return Promise.resolve({ data: { user: null }, error: authError('Not authenticated') });
      return Promise.resolve({ data: { user: authSession.user }, error: null });
    },
    getUser: function () {
      return Promise.resolve({ data: { user: authSession ? authSession.user : null }, error: null });
    },
    admin: {
      createUser: function (attrs) { return Promise.resolve({ data: { user: { id: newUuid(), email: attrs && attrs.email } }, error: null }); },
      deleteUser: function () { return Promise.resolve({ data: {}, error: null }); },
      updateUserById: function () { return Promise.resolve({ data: {}, error: null }); }
    }
  };

  /* ========================================================================
     PostgREST builder
     ======================================================================== */
  function rowsOf(table) {
    if (!DB[table]) DB[table] = [];
    return DB[table];
  }
  function norm(v) { return v === null || v === undefined ? null : String(v); }
  function cmp(a, b) {
    var na = Number(a);
    var nb = Number(b);
    if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
    var sa = String(a);
    var sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  function matchFilter(row, f) {
    var rv = row[f.col];
    var v = f.val;
    switch (f.op) {
      case 'eq': return v === null || v === undefined ? rv === null || rv === undefined : norm(rv) === norm(v);
      case 'neq': return v === null || v === undefined ? rv !== null && rv !== undefined : norm(rv) !== norm(v);
      case 'in': return (v || []).some(function (x) { return norm(x) === norm(rv); });
      case 'gt': return rv !== null && rv !== undefined && cmp(rv, v) > 0;
      case 'gte': return rv !== null && rv !== undefined && cmp(rv, v) >= 0;
      case 'lt': return rv !== null && rv !== undefined && cmp(rv, v) < 0;
      case 'lte': return rv !== null && rv !== undefined && cmp(rv, v) <= 0;
      case 'is': return v === null || v === undefined ? rv === null || rv === undefined : (v === true ? rv === true : v === false ? rv === false : norm(rv) === norm(v));
      case 'like':
      case 'ilike': {
        var pattern = String(v == null ? '' : v).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
        var flags = f.op === 'ilike' ? 'i' : '';
        try { return new RegExp('^' + pattern + '$', flags).test(String(rv == null ? '' : rv)); } catch (e) { return false; }
      }
      case 'not': return !matchFilter(row, { col: f.col, op: f.notOp, val: f.notVal });
      default: return true;
    }
  }
  function errorResult(message, code, status) {
    return { data: null, error: { message: message, details: null, hint: null, code: code || 'MOCK_ERROR' }, count: null, status: status || 400 };
  }

  function makeBuilder(tableName) {
    var q = {
      action: 'select',
      payload: null,
      columns: '*',
      filters: [],
      orders: [],
      limit: null,
      range: null,
      single: false,
      maybeSingle: false,
      onConflict: null
    };
    var api = {};

    function executeSelect() {
      var rows = rowsOf(tableName).filter(function (row) {
        return q.filters.every(function (f) { return matchFilter(row, f); });
      });
      if (q.orders.length) {
        rows = rows.slice().sort(function (a, b) {
          for (var i = 0; i < q.orders.length; i += 1) {
            var o = q.orders[i];
            var av = a[o.col];
            var bv = b[o.col];
            var r;
            if ((av === null || av === undefined) && (bv === null || bv === undefined)) r = 0;
            else if (av === null || av === undefined) r = 1;
            else if (bv === null || bv === undefined) r = -1;
            else r = cmp(av, bv);
            if (r !== 0) return o.ascending === false ? -r : r;
          }
          return 0;
        });
      }
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit !== null) rows = rows.slice(0, q.limit);
      rows = rows.map(clone);
      if (q.single) {
        if (rows.length !== 1) {
          return errorResult('JSON object requested, multiple (or no) rows returned', 'PGRST116', 406);
        }
        return { data: rows[0], error: null, count: 1, status: 200 };
      }
      if (q.maybeSingle) return { data: rows.length ? rows[0] : null, error: null, count: rows.length, status: 200 };
      return { data: rows, error: null, count: rows.length, status: 200 };
    }

    function executeInsert() {
      var items = Array.isArray(q.payload) ? q.payload : [q.payload];
      var inserted = [];
      items.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var row = clone(item);
        if (row.id === null || row.id === undefined) row.id = newUuid();
        if (row.created_at === null || row.created_at === undefined) row.created_at = new Date().toISOString();
        rowsOf(tableName).push(row);
        inserted.push(clone(row));
      });
      return { data: inserted, error: null, count: inserted.length, status: 201 };
    }

    function executeUpsert() {
      var items = Array.isArray(q.payload) ? q.payload : [q.payload];
      var keys = q.onConflict
        ? String(q.onConflict).split(',').map(function (s) { return s.trim(); }).filter(Boolean)
        : ['id'];
      var out = [];
      items.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var row = clone(item);
        var matchable = keys.every(function (k) { return row[k] !== null && row[k] !== undefined; });
        var target = null;
        if (matchable) {
          var table = rowsOf(tableName);
          for (var i = 0; i < table.length; i += 1) {
            var candidate = table[i];
            var hit = keys.every(function (k) { return norm(candidate[k]) === norm(row[k]); });
            if (hit) { target = candidate; break; }
          }
        }
        if (target) {
          Object.keys(row).forEach(function (k) { target[k] = row[k]; });
          if (target.updated_at === null || target.updated_at === undefined) target.updated_at = new Date().toISOString();
          out.push(clone(target));
        } else {
          if (row.id === null || row.id === undefined) row.id = newUuid();
          if (row.created_at === null || row.created_at === undefined) row.created_at = new Date().toISOString();
          rowsOf(tableName).push(row);
          out.push(clone(row));
        }
      });
      return { data: out, error: null, count: out.length, status: 201 };
    }

    function executeUpdate() {
      var rows = rowsOf(tableName).filter(function (row) {
        return q.filters.every(function (f) { return matchFilter(row, f); });
      });
      var patched = rows.map(function (row) {
        var patch = clone(q.payload || {});
        Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
        if (row.updated_at === null || row.updated_at === undefined) row.updated_at = new Date().toISOString();
        return clone(row);
      });
      return { data: patched, error: null, count: patched.length, status: 200 };
    }

    function executeDelete() {
      var table = rowsOf(tableName);
      var doomed = table.filter(function (row) {
        return q.filters.every(function (f) { return matchFilter(row, f); });
      });
      var remaining = table.filter(function (row) { return doomed.indexOf(row) < 0; });
      DB[tableName] = remaining;
      return { data: doomed.map(clone), error: null, count: doomed.length, status: 200 };
    }

    function execute() {
      switch (q.action) {
        case 'insert': return executeInsert();
        case 'upsert': return executeUpsert();
        case 'update': return executeUpdate();
        case 'delete': return executeDelete();
        default: return executeSelect();
      }
    }

    function chain(name) {
      api[name] = function () {
        var args = arguments;
        if (name === 'select') { q.columns = args[0] || '*'; if (q.action === 'select' && args[0]) q.action = 'select'; }
        else if (name === 'insert') { q.action = 'insert'; q.payload = args[0]; }
        else if (name === 'update') { q.action = 'update'; q.payload = args[0]; }
        else if (name === 'upsert') { q.action = 'upsert'; q.payload = args[0]; q.onConflict = args[1] && args[1].onConflict ? args[1].onConflict : null; }
        else if (name === 'delete') { q.action = 'delete'; }
        else if (name === 'eq' || name === 'neq' || name === 'gt' || name === 'gte' || name === 'lt' || name === 'lte' || name === 'like' || name === 'ilike' || name === 'is') { q.filters.push({ op: name, col: args[0], val: args[1] }); }
        else if (name === 'in') { q.filters.push({ op: 'in', col: args[0], val: args[1] || [] }); }
        else if (name === 'not') { q.filters.push({ op: 'not', col: args[0], notOp: args[1], notVal: args[2] }); }
        else if (name === 'order') { q.orders.push({ col: args[0], ascending: !(args[1] && args[1].ascending === false) }); }
        else if (name === 'limit') { q.limit = Number(args[0]); }
        else if (name === 'range') { q.range = [Number(args[0]), Number(args[1])]; }
        else if (name === 'single') { q.single = true; q.maybeSingle = false; }
        else if (name === 'maybeSingle') { q.maybeSingle = true; q.single = false; }
        else if (name === 'match') { var obj = args[0] || {}; Object.keys(obj).forEach(function (k) { q.filters.push({ op: 'eq', col: k, val: obj[k] }); }); }
        else if (name === 'filter') { q.filters.push({ op: args[1], col: args[0], val: args[2] }); }
        return api;
      };
    }
    ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'order', 'limit', 'range', 'single', 'maybeSingle', 'match', 'filter'].forEach(chain);

    api.then = function (onFulfilled, onRejected) {
      return Promise.resolve(execute()).then(onFulfilled, onRejected);
    };
    api.catch = function (onRejected) { return Promise.resolve(execute()).catch(onRejected); };
    api.finally = function (onFinally) { return Promise.resolve(execute()).finally(onFinally); };
    api.execute = execute;
    return api;
  }

  /* ========================================================================
     Storage mock (in-memory bucket objects)
     ======================================================================== */
  var storageObjects = {};
  function storageFrom(bucket) {
    var bucketName = bucket || 'siteforge-files';
    function key(path) { return bucketName + '/' + String(path); }
    return {
      upload: function (path, file, options) {
        var entry = { path: String(path), bucket: bucketName, size: file && (file.size || (file.byteLength || 0)) || 0, contentType: (file && file.type) || (options && options.contentType) || 'application/octet-stream', storedAt: new Date().toISOString() };
        storageObjects[key(path)] = entry;
        return Promise.resolve({ data: { path: String(path), id: newUuid(), fullPath: key(path) }, error: null });
      },
      createSignedUrl: function (path, expiresIn) {
        var entry = storageObjects[key(path)];
        return Promise.resolve({
          data: { signedUrl: 'https://mock.supabase.co/storage/v1/object/sign/' + bucketName + '/' + encodeURIComponent(String(path)) + '?token=mock-token', path: String(path), expiresIn: expiresIn || 3600, exists: !!entry },
          error: null
        });
      },
      getPublicUrl: function (path) {
        return { data: { publicUrl: 'https://mock.supabase.co/storage/v1/object/public/' + bucketName + '/' + encodeURIComponent(String(path)) } };
      },
      remove: function (paths) {
        var list = Array.isArray(paths) ? paths : [paths];
        list.forEach(function (p) { delete storageObjects[key(p)]; });
        return Promise.resolve({ data: list.map(function (p) { return { name: String(p) }; }), error: null });
      },
      list: function (prefix) {
        var entries = Object.keys(storageObjects)
          .filter(function (k) { return k.indexOf(bucketName + '/') === 0 && (!prefix || k.indexOf(prefix) >= 0); })
          .map(function (k) { return storageObjects[k]; });
        return Promise.resolve({ data: entries, error: null });
      },
      download: function (path) {
        var entry = storageObjects[key(path)];
        if (!entry) return Promise.resolve({ data: null, error: { message: 'Object not found', status: 404 } });
        var blob = new Blob([entry.path], { type: entry.contentType });
        return Promise.resolve({ data: blob, error: null });
      },
      getBucket: function () { return Promise.resolve({ data: { id: bucketName, name: bucketName }, error: null }); }
    };
  }

  /* ========================================================================
     Edge function fetch interception
     ======================================================================== */
  function jsonResponse(payload, status) {
    var code = status || 200;
    return {
      ok: code >= 200 && code < 300,
      status: code,
      statusText: code === 200 ? 'OK' : 'Mock',
      headers: { get: function () { return 'application/json'; } },
      json: function () { return Promise.resolve(clone(payload)); },
      text: function () { return Promise.resolve(JSON.stringify(payload)); }
    };
  }
  function edgePayload(url) {
    if (url.indexOf('scan-passport') >= 0) {
      return {
        ok: true,
        name: 'Nimal Perera',
        nationality: 'Sri Lankan',
        passport_no: 'N7711223',
        passport_expiry: offsetDate(900),
        emirates_id: '784-1991-6677889-1',
        emirates_id_expiry: offsetDate(600),
        visa_no: 'V-778811',
        visa_expiry: offsetDate(160),
        work_permit_no: 'WP-334455',
        work_permit_expiry: offsetDate(180),
        work_permit_renewal_due: offsetDate(170),
        trade: 'CONC',
        role: 'Worker'
      };
    }
    if (url.indexOf('scan-invoice-real') >= 0 || url.indexOf('scan-invoice') >= 0) {
      return {
        ok: true,
        merchant: 'Emirates Ready Mix',
        vendor: 'Emirates Ready Mix',
        supplier: 'Emirates Ready Mix',
        invoice_no: 'INV-88421',
        invoice_number: 'INV-88421',
        date: TODAY,
        total: 18450,
        amount: 18450,
        subtotal: 17571.43,
        vat: 878.57,
        currency: 'AED',
        category: 'Materials',
        items: [{ description: 'Ready-mix concrete C35/20', quantity: 60, unit: 'm3', unit_price: 285, total: 17100 }]
      };
    }
    if (url.indexOf('admin-user-ops') >= 0) {
      return { ok: true, id: newUuid(), email: 'new.user@example.com', action: 'mock', message: 'Mock admin operation completed' };
    }
    return { ok: true, mock: true };
  }
  function mockRestRows(url) {
    var path = url.split('/rest/v1/')[1] || '';
    var tableName = path.split('?')[0].replace(/\/+$/, '');
    var rows = DB[tableName];
    if (!rows) return [];
    var query = path.split('?')[1] || '';
    var params = {};
    query.split('&').forEach(function (part) {
      if (!part) return;
      var eq = part.indexOf('=');
      if (eq < 0) return;
      params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    });
    var filtered = rows.filter(function (row) {
      return Object.keys(params).every(function (k) {
        var raw = params[k];
        if (raw === 'eq.' + norm(row[k]) || (raw.indexOf('eq.') === 0 && norm(raw.slice(3)) === norm(row[k]))) return true;
        return raw === 'select' || raw.indexOf('select.') === 0 || k === 'select' ? true : false;
      });
    });
    return clone(filtered);
  }
  var realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) { url = ''; }
    if (url.indexOf('/functions/v1/') >= 0) return Promise.resolve(jsonResponse(edgePayload(url), 200));
    if (url.indexOf('/rest/v1/') >= 0) return Promise.resolve(jsonResponse(mockRestRows(url), 200));
    if (realFetch) return realFetch(input, init);
    return Promise.resolve(jsonResponse({ error: 'fetch unavailable in mock' }, 500));
  };

  /* ========================================================================
     Install window.supabase (survives the real CDN UMD assignment)
     ======================================================================== */
  var client = {
    from: function (table) { return makeBuilder(table); },
    storage: { from: storageFrom },
    auth: auth,
    functions: {
      invoke: function (name, options) {
        var fakeUrl = 'https://mock.supabase.co/functions/v1/' + name;
        return Promise.resolve({ data: edgePayload(fakeUrl), error: null });
      }
    },
    rpc: function (fn, args) {
      return Promise.resolve({ data: { fn: fn, args: args || null, mock: true }, error: null });
    },
    channel: function () {
      var ch = {
        on: function () { return ch; },
        subscribe: function () { return ch; },
        unsubscribe: function () { return Promise.resolve('ok'); }
      };
      return ch;
    },
    removeChannel: function () { return Promise.resolve('ok'); },
    realtime: { connect: function () {} }
  };
  function createClient() { return client; }
  var supabaseApi = {
    createClient: createClient,
    version: 'mock-2.45.4',
    SupabaseClient: function () { return client; }
  };

  window.__MOCK_SUPABASE__ = supabaseApi;
  Object.defineProperty(window, 'supabase', {
    configurable: false,
    enumerable: true,
    get: function () { return supabaseApi; },
    set: function (value) { window.__REAL_SUPABASE = value; }
  });

  window.__MOCK = {
    db: DB,
    seed: SEED,
    seedTable: function (table, rows) { DB[table] = clone(rows || []); return DB[table]; },
    reset: function () {
      Object.keys(DB).forEach(function (k) { delete DB[k]; });
      Object.keys(INITIAL_COPY).forEach(function (k) { DB[k] = clone(INITIAL_COPY[k]); });
      window.__MOCK_DB = DB;
      authSession = null;
      authListeners = [];
      return DB;
    },
    resetAuth: function () { authSession = null; },
    session: function () { return authSession; },
    tables: function () { return Object.keys(DB); },
    uuid: newUuid,
    version: '1.0.0'
  };
  window.__applyMockOverrides = function (overrides) {
    if (!overrides) return;
    Object.keys(overrides).forEach(function (table) { DB[table] = clone(overrides[table]); });
  };
})();`;
