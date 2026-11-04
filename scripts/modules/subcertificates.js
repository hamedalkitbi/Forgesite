/* ============================================================================
 * SiteForge module: Subcontractor Measurement & Certificates
 * ----------------------------------------------------------------------------
 * Project-level measurement of subcontractor work against a BOQ line and a
 * supplier/subcontractor, producing a "SC-####" certificate with a certified
 * amount (measured_qty × rate_aed). A Project Director certifies a draft
 * certificate; any manager can then "Generate payment request" which inserts a
 * public.payment_requests row (request_type 'subcontractor', status 'submitted')
 * so it flows through the Executive Approvals Queue, and links that request id
 * back onto the certificate.
 *
 * Owned by: modules3. Contract: docs/modules/CONTRACT.md.
 * Table + RLS: supabase/migrations/202611050003_phase3.sql
 *   (public.subcontractor_certificates + public.retention_releases + RPC).
 * Docs: docs/modules/subcertificates.md. Checks: tools/checks/subcertificates.mjs.
 *
 * The module never edits scripts/app.js. It only uses the window.SF bridge and
 * registers the "subcertificates" view. A small pure/defensive API is exposed on
 * window.SF_modules.subcertificates = { list, compute, nextReference, create,
 * certify, generatePaymentRequest }.
 * ========================================================================== */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db;
  var UI = S.ui;

  var MODULE_ID = 'subcertificates';
  var TABLE = 'subcontractor_certificates';
  var PR_TABLE = 'payment_requests';
  var MIGRATION = 'supabase/migrations/202611050003_phase3.sql';
  var STATUSES = ['draft', 'certified', 'paid'];

  /* ------------------------------------------------------------------ */
  /* Number / escaping / date helpers (H fallbacks, file stays tolerant) */
  /* ------------------------------------------------------------------ */
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function round2(v) {
    var n = num(v);
    return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
  }
  function esc(v) {
    if (H.esc) return H.esc(v);
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (H.money) return H.money(round2(n));
    var v = round2(n);
    return (v < 0 ? '-AED ' : 'AED ') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function money0(n) {
    if (H.money0) return H.money0(round2(n));
    var v = round2(n);
    return (v < 0 ? '-AED ' : 'AED ') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function fmtDate(v) {
    if (H.fmtDate) return H.fmtDate(v);
    if (v === null || v === undefined || v === '') return '—';
    var s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '—';
  }
  function todayStr() {
    if (H.today) { try { return H.today(); } catch (e) { /* fall through */ } }
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(dateStr, days) {
    var s = String(dateStr || '');
    var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) d = new Date();
    d.setDate(d.getDate() + (Number(days) || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ------------------------------------------------------------------ */
  /* i18n (EN + AR; real Arabic, never machine transliteration)          */
  /* ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Measurement & Certificates',
      subtitle: 'Subcontractor measurement certificates',
      newBtn: '+ New certificate',
      loading: 'Loading certificates…',
      empty: 'No subcontractor certificates yet.',
      emptyHint: 'Measure a BOQ line against a subcontractor to create the first certificate.',
      migrationTitle: 'Database update required',
      migrationBody: 'Measurement & Certificates needs the subcontractor_certificates table before it can list or save certificates.',
      migrationRun: 'Run',
      migrationRunAfter: 'in the Supabase SQL editor, then reload this page.',
      retry: 'Retry',
      colRef: 'Ref',
      colBoq: 'BOQ line',
      colSupplier: 'Subcontractor',
      colQty: 'Qty',
      colRate: 'Rate',
      colCertified: 'Certified',
      colStatus: 'Status',
      colPayReq: 'Payment request',
      colActions: 'Actions',
      statusDraft: 'Draft',
      statusCertified: 'Certified',
      statusPaid: 'Paid',
      certify: 'Certify',
      genPay: 'Generate payment request',
      fBoq: 'BOQ line',
      fSupplier: 'Subcontractor / supplier',
      fQty: 'Measured quantity',
      fRate: 'Rate (AED)',
      fNotes: 'Notes',
      createTitle: 'New measurement certificate',
      noBoq: 'No BOQ lines in this project yet.',
      noSuppliers: 'No suppliers/subcontractors in the directory yet.',
      qtyPositive: 'Measured quantity must be greater than zero.',
      ratePositive: 'Rate must be greater than zero.',
      boqRequired: 'Choose a BOQ line.',
      supplierRequired: 'Choose a subcontractor/supplier.',
      directorOnly: 'Only a Project Director may certify a certificate.',
      managerOnly: 'This action requires a Project Director or Financial Controller.',
      alreadyCertified: 'Certificate is not in draft status.',
      alreadyRequested: 'A payment request already exists for this certificate.',
      notCertified: 'Certify the certificate before generating a payment request.',
      savedOk: 'Certificate created ✓',
      certifiedOk: 'Certificate certified ✓',
      payReqOk: 'Payment request generated ✓',
      failed: 'Failed',
      noProject: 'Select a project to measure subcontractor certificates.',
      bridgeNotReady: 'SiteForge bridge is not ready.',
      unknownSupplier: 'Unknown subcontractor',
      unknownBoq: 'Unknown BOQ line',
      kpiDraft: 'Draft',
      kpiCertified: 'Certified',
      kpiValue: 'Certified value',
      certCount: 'certificates'
    },
    ar: {
      title: 'شهادات المقاولين',
      subtitle: 'شهادات قياس أعمال المقاولين',
      newBtn: '+ شهادة جديدة',
      loading: 'جارٍ تحميل الشهادات…',
      empty: 'لا توجد شهادات مقاولين بعد.',
      emptyHint: 'قِس بند جدول كميات مقابل مقاول لإنشاء أول شهادة.',
      migrationTitle: 'يلزم تحديث قاعدة البيانات',
      migrationBody: 'يتطلب قسم الشهادات جدول subcontractor_certificates قبل أن يتمكن من عرض أو حفظ الشهادات.',
      migrationRun: 'شغّل',
      migrationRunAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      retry: 'إعادة المحاولة',
      colRef: 'المرجع',
      colBoq: 'بند جدول الكميات',
      colSupplier: 'المقاول',
      colQty: 'الكمية',
      colRate: 'السعر',
      colCertified: 'المعتمد',
      colStatus: 'الحالة',
      colPayReq: 'طلب الدفع',
      colActions: 'إجراءات',
      statusDraft: 'مسودة',
      statusCertified: 'معتمد',
      statusPaid: 'مدفوع',
      certify: 'اعتماد',
      genPay: 'إنشاء طلب دفع',
      fBoq: 'بند جدول الكميات',
      fSupplier: 'المقاول / المورد',
      fQty: 'الكمية المقاسة',
      fRate: 'السعر (درهم)',
      fNotes: 'ملاحظات',
      createTitle: 'شهادة قياس جديدة',
      noBoq: 'لا توجد بنود جدول كميات في هذا المشروع بعد.',
      noSuppliers: 'لا يوجد موردون أو مقاولون في الدليل بعد.',
      qtyPositive: 'يجب أن تكون الكمية المقاسة أكبر من صفر.',
      ratePositive: 'يجب أن يكون السعر أكبر من صفر.',
      boqRequired: 'اختر بند جدول الكميات.',
      supplierRequired: 'اختر مقاولاً / مورداً.',
      directorOnly: 'لا يجوز اعتماد الشهادة إلا لمدير المشروع.',
      managerOnly: 'يتطلب هذا الإجراء مدير مشروع أو مراقباً مالياً.',
      alreadyCertified: 'الشهادة ليست في حالة مسودة.',
      alreadyRequested: 'يوجد طلب دفع لهذه الشهادة بالفعل.',
      notCertified: 'اعتمد الشهادة قبل إنشاء طلب الدفع.',
      savedOk: 'تم إنشاء الشهادة ✓',
      certifiedOk: 'تم اعتماد الشهادة ✓',
      payReqOk: 'تم إنشاء طلب الدفع ✓',
      failed: 'فشل',
      noProject: 'اختر مشروعاً لقياس شهادات المقاولين.',
      bridgeNotReady: 'جسر SiteForge غير جاهز.',
      unknownSupplier: 'مقاول غير معروف',
      unknownBoq: 'بند غير معروف',
      kpiDraft: 'مسودات',
      kpiCertified: 'معتمدة',
      kpiValue: 'القيمة المعتمدة',
      certCount: 'شهادات'
    }
  };
  function currentLang() { return (S.language === 'ar') ? 'ar' : 'en'; }
  function labelFor(lang, k) {
    var dict = L[lang] || L.en;
    return dict[k] != null ? dict[k] : (L.en[k] != null ? L.en[k] : k);
  }
  function pick(k) { return labelFor(currentLang(), k); }

  /* ------------------------------------------------------------------ */
  /* Bridge accessors (all null-safe)                                    */
  /* ------------------------------------------------------------------ */
  function projectId() {
    try {
      if (S.currentProjectId) return S.currentProjectId;
      var st = S.data && S.data.state;
      return st ? (st.currentProjectId || null) : null;
    } catch (e) { return null; }
  }
  function userName() {
    try { return (S.user && S.user.name) || ''; } catch (e) { return ''; }
  }
  function isDirector() {
    try { return !!(S.user && S.user.role === 'director'); } catch (e) { return false; }
  }
  function canManage() {
    try { return !!(UI && typeof UI.canManage === 'function' && UI.canManage()); } catch (e) { return false; }
  }
  function boqLines() {
    try { return (S.data && S.data.state && S.data.state.boq) || []; } catch (e) { return []; }
  }
  function suppliers() {
    var st = null;
    try { st = (S.data && S.data.state) || {}; } catch (e) { st = {}; }
    if (st && Array.isArray(st.suppliers) && st.suppliers.length) return st.suppliers;
    if (S.suppliers && typeof S.suppliers.list === 'function') { try { return S.suppliers.list() || []; } catch (e) {} }
    if (window.SF_modules && window.SF_modules.suppliers && typeof window.SF_modules.suppliers.list === 'function') {
      try { return window.SF_modules.suppliers.list() || []; } catch (e) {}
    }
    return [];
  }

  /* ------------------------------------------------------------------ */
  /* Module state                                                        */
  /* ------------------------------------------------------------------ */
  var MOD = {
    rows: [],
    error: null,
    loaded: false,
    stale: true,
    token: 0,
    el: null
  };

  /* ------------------------------------------------------------------ */
  /* Data loading                                                        */
  /* ------------------------------------------------------------------ */
  function fetchCerts(pid) {
    if (!DB || typeof DB.selectStrict !== 'function') {
      return Promise.resolve({ rows: [], error: new Error(pick('bridgeNotReady')) });
    }
    return Promise.resolve()
      .then(function () { return DB.selectStrict(TABLE, { project_id: pid }, 'created_at', false); })
      .then(function (r) { return { rows: (r && r.rows) || [], error: (r && r.error) || null }; })
      .catch(function (e) { return { rows: [], error: e }; });
  }

  /* ------------------------------------------------------------------ */
  /* Pure helpers (exposed, no DOM / no SF dependency for the math)      */
  /* ------------------------------------------------------------------ */
  function compute(qty, rate) {
    return round2(num(qty) * num(rate));
  }
  function nextReference(rows, width) {
    var w = (width === undefined || width === null || width < 1) ? 4 : Math.floor(width);
    var max = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var raw = (r && typeof r === 'object') ? (r.reference !== undefined ? r.reference : r.ref) : r;
      if (raw === null || raw === undefined) return;
      var m = String(raw).match(/(\d+)\s*$/);
      if (!m) return;
      var n = parseInt(m[1], 10);
      if (isFinite(n) && n > max) max = n;
    });
    var s = String(max + 1);
    while (s.length < w) s = '0' + s;
    return 'SC-' + s;
  }
  function list() {
    return (MOD.rows || []).slice();
  }
  function rowById(id) {
    for (var i = 0; i < MOD.rows.length; i++) {
      if (MOD.rows[i] && String(MOD.rows[i].id) === String(id)) return MOD.rows[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Actions (public API; all return Promises that never reject)         */
  /* ------------------------------------------------------------------ */
  function create(values) {
    var v = values || {};
    var pid = projectId();
    return Promise.resolve().then(function () {
      if (!pid) return { ok: false, error: new Error(pick('noProject')) };
      if (!DB || typeof DB.insert !== 'function') return { ok: false, error: new Error(pick('bridgeNotReady')) };
      var boqId = v.boq_item_id;
      var supId = v.supplier_id;
      if (!boqId) return { ok: false, error: new Error(pick('boqRequired')) };
      if (!supId) return { ok: false, error: new Error(pick('supplierRequired')) };
      var qty = num(v.measured_qty);
      var rate = num(v.rate_aed);
      if (!(qty > 0)) return { ok: false, error: new Error(pick('qtyPositive')) };
      if (!(rate > 0)) return { ok: false, error: new Error(pick('ratePositive')) };
      var certified = compute(qty, rate);
      var payload = {
        project_id: pid,
        supplier_id: supId,
        boq_item_id: String(boqId),
        reference: nextReference(MOD.rows),
        period: todayStr().slice(0, 7),
        measured_qty: round2(qty),
        rate_aed: round2(rate),
        certified_amount_aed: certified,
        status: 'draft',
        notes: (v.notes === null || v.notes === undefined || v.notes === '') ? null : String(v.notes)
      };
      return Promise.resolve(DB.insert(TABLE, payload)).then(function (row) {
        if (row) MOD.rows = (MOD.rows || []).concat([row]);
        MOD.stale = true;
        if (MOD.el) startRender(MOD.el);
        return { ok: true, row: row };
      }).catch(function (e) { return { ok: false, error: e }; });
    }).catch(function (e) { return { ok: false, error: e }; });
  }

  function certify(certId) {
    return Promise.resolve().then(function () {
      if (!isDirector()) return { ok: false, error: new Error(pick('directorOnly')) };
      if (!DB || typeof DB.update !== 'function') return { ok: false, error: new Error(pick('bridgeNotReady')) };
      var cert = rowById(certId);
      if (!cert) return { ok: false, error: new Error('Certificate not found.') };
      if (String(cert.status || 'draft') !== 'draft') return { ok: false, error: new Error(pick('alreadyCertified')) };
      var patch = {
        status: 'certified',
        certified_by: userName() || null,
        certified_at: new Date().toISOString()
      };
      return Promise.resolve(DB.update(TABLE, cert.id, patch)).then(function () {
        cert.status = patch.status;
        cert.certified_by = patch.certified_by;
        cert.certified_at = patch.certified_at;
        MOD.stale = true;
        if (MOD.el) startRender(MOD.el);
        return { ok: true };
      }).catch(function (e) { return { ok: false, error: e }; });
    }).catch(function (e) { return { ok: false, error: e }; });
  }

  function generatePaymentRequest(certId) {
    return Promise.resolve().then(function () {
      if (!canManage()) return { ok: false, error: new Error(pick('managerOnly')) };
      if (!DB || typeof DB.insert !== 'function' || typeof DB.update !== 'function') {
        return { ok: false, error: new Error(pick('bridgeNotReady')) };
      }
      var cert = rowById(certId);
      if (!cert) return { ok: false, error: new Error('Certificate not found.') };
      if (String(cert.status || '') !== 'certified') return { ok: false, error: new Error(pick('notCertified')) };
      if (cert.payment_request_id) return { ok: false, error: new Error(pick('alreadyRequested')) };
      var ref = cert.reference || '';
      var amount = round2(cert.certified_amount_aed);
      var prPayload = {
        project_id: cert.project_id || projectId(),
        party_id: null,
        request_type: 'subcontractor',
        reference: 'PR-' + ref,
        description: 'Subcontractor certificate ' + ref,
        amount_aed: amount,
        retention_pct: 0,
        retention_aed: 0,
        net_aed: amount,
        due_date: addDays(todayStr(), 30),
        status: 'submitted',
        requested_by: userName() || null
      };
      return Promise.resolve(DB.insert(PR_TABLE, prPayload)).then(function (prRow) {
        var prId = prRow && prRow.id;
        if (!prId) return { ok: false, error: new Error('Payment request created without an id.') };
        return Promise.resolve(DB.update(TABLE, cert.id, { payment_request_id: String(prId) })).then(function () {
          cert.payment_request_id = String(prId);
          MOD.stale = true;
          if (MOD.el) startRender(MOD.el);
          return { ok: true, paymentRequest: prRow };
        });
      }).catch(function (e) { return { ok: false, error: e }; });
    }).catch(function (e) { return { ok: false, error: e }; });
  }

  /* Expose the API before view registration. */
  window.SF_modules = window.SF_modules || {};
  window.SF_modules[MODULE_ID] = {
    list: list,
    compute: compute,
    nextReference: nextReference,
    create: create,
    certify: certify,
    generatePaymentRequest: generatePaymentRequest,
    version: 1
  };

  /* ------------------------------------------------------------------ */
  /* Presentation helpers                                                */
  /* ------------------------------------------------------------------ */
  function boqLabelOf(id) {
    var rows = boqLines();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i].id) === String(id)) {
        return (rows[i].code ? rows[i].code + ' · ' : '') + (rows[i].desc || id);
      }
    }
    return id ? String(id) : pick('unknownBoq');
  }
  function supplierNameOf(id) {
    var rows = suppliers();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i].id) === String(id)) return rows[i].name || rows[i].company_name || id;
    }
    return id ? String(id) : pick('unknownSupplier');
  }
  function statusTag(status) {
    var s = String(status || 'draft').toLowerCase();
    var cls = s === 'certified' ? 'info' : (s === 'paid' ? 'ok' : 'warn');
    var label = s === 'paid' ? pick('statusPaid') : (s === 'certified' ? pick('statusCertified') : pick('statusDraft'));
    return '<span class="tag ' + cls + '">' + esc(label) + '</span>';
  }
  function kpi(cls, label, value, sub) {
    return '<div class="kpi ' + cls + '"><div class="lbl">' + esc(label) + '</div>' +
      '<div class="val">' + esc(value) + '</div>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function tableHTML(headers, rowsHtml, emptyText) {
    return '<div style="overflow-x:auto"><table><thead><tr>' +
      headers.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + esc(h.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="' + headers.length + '" class="empty">' + esc(emptyText || pick('empty')) + '</td></tr>') +
      '</tbody></table></div>';
  }
  function actionBtn(action, label, cls, id) {
    return '<button type="button" class="btn ' + (cls || 'ghost') + ' sm" data-sf-action="' + esc(action) + '"' +
      (id ? ' data-sf-id="' + esc(String(id)) + '"' : '') + '>' + esc(label) + '</button>';
  }
  function rowsHtml() {
    return (MOD.rows || []).map(function (r) {
      var actions = [];
      if (String(r.status || 'draft') === 'draft' && isDirector()) {
        actions.push(actionBtn('certify', pick('certify'), 'ok', r.id));
      }
      if (String(r.status || '') === 'certified' && canManage() && !r.payment_request_id) {
        actions.push(actionBtn('genpay', pick('genPay'), 'blue', r.id));
      }
      return '<tr>' +
        '<td class="mono" style="color:var(--accent)">' + esc(r.reference || '—') + '</td>' +
        '<td>' + esc(boqLabelOf(r.boq_item_id)) + '</td>' +
        '<td><b>' + esc(supplierNameOf(r.supplier_id)) + '</b></td>' +
        '<td class="tright mono">' + esc(num(r.measured_qty)) + '</td>' +
        '<td class="tright mono">' + esc(money(r.rate_aed)) + '</td>' +
        '<td class="tright mono"><b>' + esc(money(r.certified_amount_aed)) + '</b></td>' +
        '<td>' + statusTag(r.status) + '</td>' +
        '<td class="mono mutc">' + (r.payment_request_id ? esc(String(r.payment_request_id)) : '—') + '</td>' +
        '<td class="nowrap">' + (actions.join(' ') || '—') + '</td>' +
        '</tr>';
    });
  }
  function kpisHtml() {
    var drafts = (MOD.rows || []).filter(function (r) { return String(r.status || 'draft') === 'draft'; });
    var certified = (MOD.rows || []).filter(function (r) { return String(r.status || '') === 'certified' || String(r.status || '') === 'paid'; });
    var value = round2(certified.reduce(function (s, r) { return s + num(r.certified_amount_aed); }, 0));
    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px">' +
      kpi('warn', pick('kpiDraft'), String(drafts.length), pick('certCount')) +
      kpi('info', pick('kpiCertified'), String(certified.length), pick('certCount')) +
      kpi('g', pick('kpiValue'), money0(value), '') +
      '</div>';
  }
  function tableCard() {
    if (!(MOD.rows || []).length) {
      return '<div class="card"><div class="empty"><div class="big">📏</div>' + esc(pick('empty')) +
        '<div class="mutc" style="font-size:11px;margin-top:6px">' + esc(pick('emptyHint')) + '</div></div></div>';
    }
    var headers = [
      { label: pick('colRef') }, { label: pick('colBoq') }, { label: pick('colSupplier') },
      { label: pick('colQty'), cls: 'tright' }, { label: pick('colRate'), cls: 'tright' },
      { label: pick('colCertified'), cls: 'tright' }, { label: pick('colStatus') },
      { label: pick('colPayReq') }, { label: pick('colActions') }
    ];
    return '<div class="card"><h3>📏 ' + esc(pick('title')) + '</h3>' +
      tableHTML(headers, rowsHtml(), pick('empty')) + '</div>';
  }
  function migrationCard(err) {
    var msg = (err && err.message) || (err && String(err)) || '';
    return '<div class="card" style="border-color:rgba(248,81,73,.45)">' +
      '<h3>⚠ ' + esc(pick('migrationTitle')) + '</h3>' +
      '<p class="badc" style="margin-bottom:8px">' + esc(pick('migrationBody')) + '</p>' +
      '<p class="mutc" style="margin-bottom:8px">' + esc(pick('migrationRun')) +
      ' <code style="direction:ltr;unicode-bidi:embed">' + esc(MIGRATION) + '</code> ' +
      esc(pick('migrationRunAfter')) + '</p>' +
      (msg ? '<p class="mutc mono" style="font-size:11px;white-space:pre-wrap;direction:ltr;unicode-bidi:embed">' + esc(msg) + '</p>' : '') +
      '<div style="margin-top:10px"><button type="button" class="btn ghost sm" data-sf-action="retry">' + esc(pick('retry')) + '</button></div>' +
      '</div>';
  }
  function buildView() {
    var proj = S.currentProject || {};
    var projText = proj.name ? (proj.name + (proj.code ? ' · ' + proj.code : '')) : '';
    var head = '<h2 class="vt">📏 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) +
      (projText ? ' · ' + esc(projText) : '') +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn" data-sf-action="new">➕ ' + esc(pick('newBtn')) + '</button></div>';
    var body = MOD.error ? migrationCard(MOD.error) : (kpisHtml() + tableCard());
    return '<div data-sf-subs="list">' + head + body + '</div>';
  }
  function loadingHTML() {
    return '<div data-sf-subs="loading"><h2 class="vt">📏 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>' +
      '<div class="card"><div class="empty"><div class="big">📏</div>' + esc(pick('loading')) + '</div></div></div>';
  }
  function noProjectHTML() {
    return '<div data-sf-subs="noproject"><h2 class="vt">📏 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><div class="empty"><div class="big">🏗</div>' + esc(pick('noProject')) + '</div></div></div>';
  }
  function errorHTML(e) {
    var msg = (e && e.message) || String(e) || 'Unexpected error';
    return '<div data-sf-subs="error"><h2 class="vt">📏 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><h3>⚠ ' + esc(pick('failed')) + '</h3>' +
      '<p class="badc">' + esc(msg) + '</p></div></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Rendering + events                                                  */
  /* ------------------------------------------------------------------ */
  function boqOptions() {
    return boqLines().map(function (b) {
      return { value: b.id, label: (b.code ? b.code + ' · ' : '') + (b.desc || b.id) };
    });
  }
  function supplierOptions() {
    return suppliers().map(function (s) {
      return { value: s.id, label: s.name || s.company_name || s.id };
    });
  }
  function openCreateForm() {
    if (!UI || !UI.openFormModal) { if (UI && UI.toast) UI.toast(pick('failed'), 'bad'); return; }
    var boq = boqOptions();
    var sup = supplierOptions();
    if (!boq.length) { if (UI.toast) UI.toast(pick('noBoq'), 'bad'); return; }
    if (!sup.length) { if (UI.toast) UI.toast(pick('noSuppliers'), 'bad'); return; }
    UI.openFormModal({
      title: '📏 ' + esc(pick('createTitle')),
      wide: true,
      values: { boq_item_id: boq[0].value, supplier_id: sup[0].value, measured_qty: '', rate_aed: '', notes: '' },
      fields: [
        { key: 'boq_item_id', label: pick('fBoq'), type: 'select', options: boq, required: true },
        { key: 'supplier_id', label: pick('fSupplier'), type: 'select', options: sup, required: true },
        { key: 'measured_qty', label: pick('fQty'), type: 'number', step: '0.01', required: true },
        { key: 'rate_aed', label: pick('fRate'), type: 'number', step: '0.01', required: true },
        { key: 'notes', label: pick('fNotes'), type: 'textarea', rows: 2, full: true }
      ],
      onSubmit: function (values) {
        return create(values).then(function (res) {
          if (res && !res.ok) throw new Error((res.error && res.error.message) || String(res.error));
          if (UI.toast) UI.toast(pick('savedOk'), 'ok');
        });
      }
    });
  }
  function bind(el) {
    function on(selector, handler) {
      Array.prototype.forEach.call(el.querySelectorAll(selector), function (node) {
        node.addEventListener('click', function (ev) {
          try { handler(node, ev); } catch (e) { if (UI && UI.toast) UI.toast(pick('failed') + ': ' + ((e && e.message) || 'error'), 'bad'); }
        });
      });
    }
    on('[data-sf-action]', function (node) {
      var action = node.getAttribute('data-sf-action');
      var id = node.getAttribute('data-sf-id');
      if (action === 'new') openCreateForm();
      else if (action === 'retry') { MOD.stale = true; startRender(MOD.el); }
      else if (action === 'certify' && id) {
        certify(id).then(function (res) {
          if (res && res.ok) { if (UI.toast) UI.toast(pick('certifiedOk'), 'ok'); }
          else if (UI.toast) UI.toast((res && res.error && res.error.message) || pick('failed'), 'bad');
        });
      }
      else if (action === 'genpay' && id) {
        generatePaymentRequest(id).then(function (res) {
          if (res && res.ok) { if (UI.toast) UI.toast(pick('payReqOk'), 'ok'); }
          else if (UI.toast) UI.toast((res && res.error && res.error.message) || pick('failed'), 'bad');
        });
      }
    });
  }
  function paint(el) {
    if (!el || !el.querySelector) return;
    if (!el.querySelector('[data-sf-subs]')) return;
    try {
      el.innerHTML = buildView();
      bind(el);
    } catch (e) {
      try { el.innerHTML = errorHTML(e); } catch (e2) { /* never throw out of render */ }
    }
  }
  function startRender(el) {
    if (!el || typeof el.innerHTML !== 'string') return;
    MOD.el = el;
    var pid = projectId();
    if (!pid) { el.innerHTML = noProjectHTML(); return; }
    el.innerHTML = loadingHTML();
    var token = ++MOD.token;
    fetchCerts(pid).then(function (res) {
      if (token !== MOD.token) return;
      MOD.rows = (res && res.rows) || [];
      MOD.error = (res && res.error) || null;
      MOD.loaded = true;
      MOD.stale = false;
      paint(el);
    }).catch(function (e) {
      if (token !== MOD.token) return;
      MOD.error = e;
      MOD.loaded = true;
      MOD.stale = false;
      paint(el);
    });
  }

  /* ------------------------------------------------------------------ */
  /* View registration                                                   */
  /* ------------------------------------------------------------------ */
  S.registerView({
    id: MODULE_ID,
    nav: { section: 'project', icon: '📏', label: 'Measurement & Certificates', labelAr: 'شهادات المقاولين' },
    roles: ['director', 'controller'],
    render: function (el) {
      try {
        MOD.el = el;
        if (MOD.loaded && !MOD.stale) {
          el.innerHTML = '<div data-sf-subs="list"></div>';
          paint(el);
          return;
        }
        startRender(el);
      } catch (e) {
        try { el.innerHTML = errorHTML(e); } catch (e2) { /* never throw out of render */ }
      }
    }
  });
})();
