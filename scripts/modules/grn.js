/* ============================================================================
 * SiteForge module: Receiving / GRN (project-scoped Goods Received Notes)
 * ----------------------------------------------------------------------------
 * Project-level register of goods received against approved POs (materials).
 * Managers (director / controller) and supervisors list, record, edit and
 * delete Goods Received Notes, each linked to a material (PO) with an auto
 * reference GRN-0001…GRN-9999 (next number per project). The list shows the
 * received quantity against the ordered quantity with a ✓/⚠ match badge
 * (matched = sum(qty_received) >= material.qty).
 *
 * Owned by: grn-module. Contract: docs/modules/CONTRACT.md + phase2-plan.md.
 * Table + RLS: supabase/migrations/202611050002_phase2_workflow.sql
 *   (public.goods_received_notes).
 * Docs: docs/modules/grn.md. Checks: tools/checks/grn.mjs.
 *
 * The module never edits scripts/app.js. It only uses the window.SF bridge and
 * registers the "grn" view. A small pure/defensive API is exposed on
 * window.SF_modules.grn = { list, receivedQty, add, remove, matched }.
 * ========================================================================== */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db;
  var UI = S.ui;

  var MODULE_ID = 'grn';
  var TABLE = 'goods_received_notes';
  var MIGRATION = 'supabase/migrations/202611050002_phase2_workflow.sql';
  var REF_PREFIX = 'GRN-';
  var REF_WIDTH = 4;
  var STATUSES = { received: true, pending: true, cancelled: true, rejected: true };

  /* ------------------------------------------------------------------ */
  /* Number / escaping helpers (H fallbacks so the file stays tolerant)  */
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
  function fmtDate(v) {
    if (H.fmtDate) return H.fmtDate(v);
    if (v === null || v === undefined || v === '') return '—';
    var d = new Date(String(v));
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
  }
  function todayStr() {
    if (H.today) return H.today();
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ------------------------------------------------------------------ */
  /* i18n (EN + AR; real Arabic, never machine transliteration)          */
  /* ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Receiving / GRN',
      subtitle: 'Goods received notes for this project',
      newBtn: '+ Record receipt',
      loading: 'Loading receiving notes…',
      empty: 'No goods received yet.',
      emptyHint: 'Record the first receipt against an approved PO.',
      countLabel: 'notes',
      migrationTitle: 'Database update required',
      migrationBody: 'Receiving / GRN needs the goods_received_notes table before it can list or record receipts.',
      migrationRun: 'Run',
      migrationRunAfter: 'in the Supabase SQL editor, then reload this page.',
      retry: 'Retry',
      colRef: 'Reference',
      colMaterial: 'PO / Material',
      colSupplier: 'Supplier',
      colDate: 'Received',
      colQty: 'Qty received / ordered',
      colBy: 'Received by',
      colStatus: 'Status',
      colActions: 'Actions',
      matched: 'Matched',
      notMatched: 'Not matched',
      edit: 'Edit',
      delete: 'Delete',
      close: 'Close',
      createTitle: 'Record receipt',
      editTitle: 'Edit receipt',
      fMaterial: 'Material (approved PO)',
      fQty: 'Qty received',
      fDate: 'Received date',
      fBy: 'Received by',
      fNotes: 'Notes',
      deleteConfirm: 'Delete receipt',
      deleteConfirmBody: 'This removes the goods received note.',
      saving: 'Saving…',
      savedOk: 'Saved ✓',
      deletedOk: 'Deleted',
      failed: 'Failed',
      noPermission: 'Access denied',
      materialRequired: 'Material is required',
      qtyRequired: 'Qty received is required',
      qtyNonNegative: 'Qty received must be zero or more',
      noApprovedMaterials: 'No approved materials to receive against yet.',
      noProject: 'Select a project first',
      receivedSoFar: 'Received so far',
      receivedOf: '{received} of {ordered} {unit}',
      statusReceived: 'Received',
      statusPending: 'Pending',
      statusCancelled: 'Cancelled',
      statusRejected: 'Rejected'
    },
    ar: {
      title: 'استلام البضاعة',
      subtitle: 'سندات استلام البضاعة لهذا المشروع',
      newBtn: '+ تسجيل استلام',
      loading: 'جارٍ تحميل سندات الاستلام…',
      empty: 'لا توجد بضاعة مستلمة بعد.',
      emptyHint: 'سجّل أول استلام مقابل أمر شراء معتمد.',
      countLabel: 'سنداً',
      migrationTitle: 'يلزم تحديث قاعدة البيانات',
      migrationBody: 'يتطلب قسم استلام البضاعة جدول goods_received_notes قبل أن يتمكن من عرض أو تسجيل الاستلامات.',
      migrationRun: 'شغّل',
      migrationRunAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      retry: 'إعادة المحاولة',
      colRef: 'المرجع',
      colMaterial: 'أمر الشراء / المادة',
      colSupplier: 'المورد',
      colDate: 'تاريخ الاستلام',
      colQty: 'الكمية المستلمة / المطلوبة',
      colBy: 'استلمها',
      colStatus: 'الحالة',
      colActions: 'إجراءات',
      matched: 'مطابق',
      notMatched: 'غير مطابق',
      edit: 'تعديل',
      delete: 'حذف',
      close: 'إغلاق',
      createTitle: 'تسجيل استلام',
      editTitle: 'تعديل استلام',
      fMaterial: 'المادة (أمر شراء معتمد)',
      fQty: 'الكمية المستلمة',
      fDate: 'تاريخ الاستلام',
      fBy: 'استلمها',
      fNotes: 'ملاحظات',
      deleteConfirm: 'حذف سند الاستلام',
      deleteConfirmBody: 'سيؤدي هذا إلى حذف سند استلام البضاعة.',
      saving: 'جارٍ الحفظ…',
      savedOk: 'تم الحفظ ✓',
      deletedOk: 'تم الحذف',
      failed: 'فشل',
      noPermission: 'الوصول مرفوض',
      materialRequired: 'المادة مطلوبة',
      qtyRequired: 'الكمية المستلمة مطلوبة',
      qtyNonNegative: 'يجب أن تكون الكمية صفراً أو أكثر',
      noApprovedMaterials: 'لا توجد مواد معتمدة للاستلام مقابلها بعد.',
      noProject: 'اختر مشروعاً أولاً',
      receivedSoFar: 'المستلم حتى الآن',
      receivedOf: '{received} من {ordered} {unit}',
      statusReceived: 'مستلم',
      statusPending: 'معلق',
      statusCancelled: 'ملغى',
      statusRejected: 'مرفوض'
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
  function client() {
    try {
      if (DB && typeof DB.client === 'function') return DB.client();
    } catch (e) { /* ignore */ }
    return null;
  }
  function projectId() {
    try { return S.currentProjectId || null; } catch (e) { return null; }
  }
  function projectName() {
    try {
      var p = S.currentProject;
      if (p) return (p.code ? p.code + ' · ' : '') + (p.name || '');
    } catch (e) { /* ignore */ }
    return null;
  }
  function currentUserName() {
    try { return (S.user && S.user.name) || null; } catch (e) { return null; }
  }
  function materialsState() {
    try { return (S.data && S.data.state && S.data.state.materials) || []; } catch (e) { return []; }
  }
  function suppliersState() {
    try { return (S.data && S.data.state && S.data.state.suppliers) || []; } catch (e) { return []; }
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
  function fetchRows() {
    if (!DB || typeof DB.selectStrict !== 'function') {
      return Promise.resolve({ rows: [], error: new Error('SiteForge bridge is not ready') });
    }
    var pid = projectId();
    if (!pid) return Promise.resolve({ rows: [], error: null });
    return Promise.resolve()
      .then(function () { return DB.selectStrict(TABLE, { project_id: pid }, 'received_date', false); })
      .then(function (r) { return { rows: (r && r.rows) || [], error: (r && r.error) || null }; })
      .catch(function (e) { return { rows: [], error: e }; });
  }

  /* ------------------------------------------------------------------ */
  /* Lookups (materials / suppliers from live state)                     */
  /* ------------------------------------------------------------------ */
  function materialById(id) {
    if (!id) return null;
    var mats = materialsState();
    for (var i = 0; i < mats.length; i++) {
      if (mats[i] && String(mats[i].id) === String(id)) return mats[i];
    }
    return null;
  }
  function approvedMaterials() {
    return materialsState().filter(function (m) {
      return m && (m.status || 'approved') === 'approved';
    });
  }
  function supplierIdForName(name) {
    var q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    var sups = suppliersState();
    for (var i = 0; i < sups.length; i++) {
      var s = sups[i];
      if (s && String(s.name || '').trim().toLowerCase() === q) return s.id || null;
    }
    return null;
  }
  function supplierNameForId(id) {
    if (!id) return null;
    var sups = suppliersState();
    for (var i = 0; i < sups.length; i++) {
      if (sups[i] && String(sups[i].id) === String(id)) return sups[i].name || null;
    }
    return null;
  }
  function materialOptionLabel(m) {
    var po = m && m.po;
    var desc = m && (m.desc || m.id);
    return (po ? po + ' · ' : '') + (desc || '');
  }
  function materialOptions(extraId) {
    var opts = approvedMaterials().map(function (m) {
      return { value: m.id, label: materialOptionLabel(m) };
    });
    if (extraId) {
      var has = opts.some(function (o) { return String(o.value) === String(extraId); });
      if (!has) {
        var m = materialById(extraId);
        if (m) opts.unshift({ value: m.id, label: materialOptionLabel(m) });
      }
    }
    return opts;
  }

  /* ------------------------------------------------------------------ */
  /* Reference generation (GRN-0001 … per project, next number)          */
  /* ------------------------------------------------------------------ */
  function nextReference() {
    var max = 0;
    (MOD.rows || []).forEach(function (r) {
      var m = String((r && r.reference) || '').match(/^GRN-(\d+)$/i);
      if (m) {
        var n = parseInt(m[1], 10);
        if (isFinite(n) && n > max) max = n;
      }
    });
    return REF_PREFIX + String(max + 1).padStart(REF_WIDTH, '0');
  }

  /* ------------------------------------------------------------------ */
  /* Pure / defensive public API (never throws)                          */
  /* ------------------------------------------------------------------ */
  function list() {
    return (MOD.rows || []).slice();
  }
  function receivedQty(materialId) {
    if (!materialId) return 0;
    var sum = 0;
    (MOD.rows || []).forEach(function (r) {
      if (r && String(r.material_id) === String(materialId)) sum += num(r.qty_received);
    });
    return round2(sum);
  }
  function matched(materialId) {
    var mat = materialById(materialId);
    if (!mat) return false;
    return receivedQty(materialId) >= (Number(mat.qty) || 0);
  }
  function add(materialId, qtyReceived, opts) {
    opts = opts || {};
    var pid = projectId();
    if (!pid) return Promise.resolve({ data: null, error: new Error('No project selected') });
    if (!materialId) return Promise.resolve({ data: null, error: new Error('materialId is required') });
    var qty = num(qtyReceived);
    if (qty < 0) return Promise.resolve({ data: null, error: new Error('qty_received must be >= 0') });
    if (!DB || typeof DB.insert !== 'function') return Promise.resolve({ data: null, error: new Error('SiteForge bridge is not ready') });
    var mat = materialById(materialId);
    var payload = {
      project_id: pid,
      material_id: materialId,
      supplier_id: mat ? supplierIdForName(mat.supplier) : null,
      reference: nextReference(),
      received_date: opts.received_date || todayStr(),
      qty_received: qty,
      received_by: opts.received_by != null ? opts.received_by : currentUserName(),
      notes: opts.notes || null,
      status: opts.status || 'received'
    };
    return Promise.resolve()
      .then(function () { return DB.insert(TABLE, payload); })
      .then(function (row) { MOD.stale = true; return { data: row, error: null }; })
      .catch(function (e) { return { data: null, error: e }; });
  }
  function remove(id) {
    if (!id) return Promise.resolve({ data: null, error: new Error('id is required') });
    if (!DB || typeof DB.remove !== 'function') return Promise.resolve({ data: null, error: new Error('SiteForge bridge is not ready') });
    return Promise.resolve()
      .then(function () { return DB.remove(TABLE, id); })
      .then(function (res) { MOD.stale = true; return { data: res, error: null }; })
      .catch(function (e) { return { data: null, error: e }; });
  }

  /* Expose the API before view registration so consumers (and the Node
   * checks) can reach it as soon as the module loads. */
  window.SF_modules = window.SF_modules || {};
  window.SF_modules[MODULE_ID] = {
    list: list,
    receivedQty: receivedQty,
    matched: matched,
    add: add,
    remove: remove,
    version: 1
  };

  /* ------------------------------------------------------------------ */
  /* Presentation helpers                                                */
  /* ------------------------------------------------------------------ */
  function rowById(id) {
    for (var i = 0; i < MOD.rows.length; i++) {
      if (MOD.rows[i] && String(MOD.rows[i].id) === String(id)) return MOD.rows[i];
    }
    return null;
  }
  function statusTag(status) {
    var s = String(status || 'received').toLowerCase();
    var cls = s === 'received' ? 'ok' : (s === 'pending' ? 'warn' : (s === 'cancelled' || s === 'rejected' ? 'bad' : 'info'));
    var label = s === 'pending' ? pick('statusPending') : (s === 'cancelled' ? pick('statusCancelled') : (s === 'rejected' ? pick('statusRejected') : pick('statusReceived')));
    return '<span class="tag ' + cls + '">' + esc(label) + '</span>';
  }
  function matchBadge(mat) {
    if (!mat) return '';
    var ok = matched(mat.id);
    return ' <span class="tag ' + (ok ? 'ok' : 'warn') + '" title="' + esc(ok ? pick('matched') : pick('notMatched')) + '">' + (ok ? '✓' : '⚠') + '</span>';
  }
  function tableHTML(headers, rowsHtml, emptyText) {
    return '<div style="overflow-x:auto"><table><thead><tr>' +
      headers.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + esc(h.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="' + headers.length + '" class="empty">' + esc(emptyText || pick('empty')) + '</td></tr>') +
      '</tbody></table></div>';
  }
  function actionBtn(action, label, icon, title, cls, id) {
    return '<button type="button" class="btn ghost sm ' + (cls || '') + '" data-sf-action="' + esc(action) + '"' +
      (id ? ' data-id="' + esc(id) + '"' : '') +
      (title ? ' title="' + esc(title) + '"' : '') + '>' + (icon ? icon + ' ' : '') + esc(label) + '</button>';
  }

  function rowHtml(r) {
    var mat = materialById(r.material_id);
    var poDesc = mat ? ((mat.po ? mat.po + ' · ' : '') + (mat.desc || '—')) : (r.material_id ? String(r.material_id) : '—');
    var supplier = supplierNameForId(r.supplier_id) || (mat && mat.supplier) || '—';
    var ordered = mat ? (Number(mat.qty) || 0) : null;
    var received = round2(r.qty_received);
    var qtyCell = '<span class="mono">' + received + '</span>' +
      (ordered !== null ? ' <span class="mutc mono">/ ' + ordered + ' ' + esc(mat.unit || '') + '</span>' : '') +
      matchBadge(mat);
    var actions = [
      actionBtn('edit', pick('edit'), '✎', pick('edit'), '', r.id),
      actionBtn('delete', pick('delete'), '🗑', pick('delete'), 'badc', r.id)
    ].join(' ');

    return '<tr>' +
      '<td><b class="mono" style="color:var(--accent)">' + esc(r.reference || '—') + '</b></td>' +
      '<td>' + esc(poDesc) + '</td>' +
      '<td>' + esc(supplier) + '</td>' +
      '<td>' + esc(fmtDate(r.received_date)) + '</td>' +
      '<td class="tright nowrap">' + qtyCell + '</td>' +
      '<td>' + esc(r.received_by || '—') + '</td>' +
      '<td>' + statusTag(r.status) + '</td>' +
      '<td class="nowrap">' + actions + '</td>' +
      '</tr>';
  }

  function tableCard() {
    var rows = MOD.rows;
    if (!rows.length) {
      return '<div class="card"><div class="empty"><div class="big">📦</div>' + esc(pick('empty')) +
        '<div class="mutc" style="font-size:11px;margin-top:6px">' + esc(pick('emptyHint')) + '</div></div></div>';
    }
    var headers = [
      { label: pick('colRef') }, { label: pick('colMaterial') }, { label: pick('colSupplier') },
      { label: pick('colDate') }, { label: pick('colQty') }, { label: pick('colBy') },
      { label: pick('colStatus') }, { label: pick('colActions') }
    ];
    return '<div class="card"><h3>📦 ' + esc(pick('title')) + '</h3>' +
      tableHTML(headers, rows.map(rowHtml), pick('empty')) + '</div>';
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

  function noProjectCard() {
    return '<div class="card"><div class="empty"><div class="big">📦</div>' + esc(pick('noProject')) + '</div></div>';
  }

  function buildView() {
    var pname = projectName() || '—';
    var head = '<h2 class="vt">📦 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pname) + ' · ' + MOD.rows.length + ' ' + esc(pick('countLabel')) +
      ' · ' + esc(pick('subtitle')) +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn" data-sf-action="new">➕ ' + esc(pick('newBtn')) + '</button></div>';
    var body;
    if (MOD.error) body = migrationCard(MOD.error);
    else if (!projectId()) body = noProjectCard();
    else body = tableCard();
    return '<div data-sf-grn="list">' + head + body + '</div>';
  }

  function loadingHTML() {
    return '<div data-sf-grn="loading"><h2 class="vt">📦 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>' +
      '<div class="card"><div class="empty"><div class="big">📦</div>' + esc(pick('loading')) + '</div></div></div>';
  }
  function errorHTML(e) {
    var msg = (e && e.message) || String(e) || 'Unexpected error';
    return '<div data-sf-grn="error"><h2 class="vt">📦 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><h3>⚠ ' + esc(pick('failed')) + '</h3>' +
      '<p class="badc">' + esc(msg) + '</p></div></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  function bind(el) {
    function on(selector, handler) {
      Array.prototype.forEach.call(el.querySelectorAll(selector), function (node) {
        node.addEventListener('click', function (ev) {
          try { handler(node, ev); } catch (e) { UI.toast(pick('failed') + ': ' + ((e && e.message) || 'error'), 'bad'); }
        });
      });
    }
    on('[data-sf-action]', function (node) {
      var action = node.getAttribute('data-sf-action');
      var id = node.getAttribute('data-id');
      var row = id ? rowById(id) : null;
      if (action === 'new') openForm(null);
      else if (action === 'retry') { MOD.stale = true; startRender(MOD.el); }
      else if (action === 'edit' && row) openForm(row);
      else if (action === 'delete' && row) removeRow(row);
    });
  }

  function paint(el) {
    if (!el || !el.querySelector) return;
    if (!el.querySelector('[data-sf-grn]')) return; /* view changed under us */
    try {
      el.innerHTML = buildView();
      bind(el);
    } catch (e) {
      el.innerHTML = errorHTML(e);
    }
  }

  function startRender(el) {
    if (!el || typeof el.innerHTML !== 'string') return;
    MOD.el = el;
    el.innerHTML = loadingHTML();
    var token = ++MOD.token;
    fetchRows().then(function (res) {
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
  /* Actions: create / edit / delete                                     */
  /* ------------------------------------------------------------------ */
  function openForm(row) {
    if (!UI.openFormModal) { UI.toast(pick('failed'), 'bad'); return; }
    var isEdit = !!row;
    if (!isEdit && !approvedMaterials().length) { UI.toast(pick('noApprovedMaterials'), 'bad'); return; }
    var v = row || {};
    var opts = materialOptions(isEdit ? v.material_id : null);
    UI.openFormModal({
      title: (isEdit ? '✎ ' + pick('editTitle') : '➕ ' + pick('createTitle')) + (isEdit && v.reference ? ' — ' + esc(v.reference) : ''),
      wide: true,
      values: {
        material_id: v.material_id || '',
        qty_received: (v.qty_received !== null && v.qty_received !== undefined) ? v.qty_received : '',
        received_date: v.received_date || todayStr(),
        received_by: v.received_by != null ? v.received_by : currentUserName(),
        notes: v.notes || ''
      },
      fields: [
        { key: 'material_id', label: pick('fMaterial'), type: 'select', options: opts, required: true },
        { key: 'qty_received', label: pick('fQty'), type: 'number', step: '0.01', min: 0, required: true },
        { key: 'received_date', label: pick('fDate'), type: 'date', required: true },
        { key: 'received_by', label: pick('fBy') },
        { key: 'notes', label: pick('fNotes'), type: 'textarea', rows: 2, full: true }
      ],
      onSubmit: function (values) {
        if (!values.material_id) throw new Error(pick('materialRequired'));
        if (values.qty_received === null || values.qty_received === undefined || values.qty_received === '') throw new Error(pick('qtyRequired'));
        if (Number(values.qty_received) < 0) throw new Error(pick('qtyNonNegative'));
        if (isEdit) {
          var payload = {
            material_id: values.material_id,
            supplier_id: supplierIdForName((materialById(values.material_id) || {}).supplier) || null,
            qty_received: num(values.qty_received),
            received_date: values.received_date || todayStr(),
            received_by: values.received_by || null,
            notes: values.notes || null
          };
          return Promise.resolve(DB.update(TABLE, v.id, payload)).then(function () {
            UI.toast(pick('savedOk'), 'ok');
            MOD.stale = true;
            if (MOD.el) startRender(MOD.el);
          }).catch(function (e) { throw new Error((e && e.message) || String(e)); });
        }
        return add(values.material_id, values.qty_received, {
          received_date: values.received_date,
          received_by: values.received_by,
          notes: values.notes
        }).then(function (res) {
          if (res && res.error) throw new Error((res.error.message) || String(res.error));
          UI.toast(pick('savedOk'), 'ok');
          MOD.stale = true;
          if (MOD.el) startRender(MOD.el);
        });
      }
    });
  }

  function removeRow(row) {
    if (!row) return;
    var ok = false;
    try { ok = window.confirm(pick('deleteConfirm') + ' — ' + (row.reference || '') + '?\n' + pick('deleteConfirmBody')); } catch (e) { ok = false; }
    if (!ok) return;
    remove(row.id).then(function (res) {
      if (res && res.error) { UI.toast(pick('failed') + ': ' + ((res.error.message) || String(res.error)), 'bad'); return; }
      UI.toast(pick('deletedOk'), 'ok');
      MOD.stale = true;
      if (MOD.el) startRender(MOD.el);
    });
  }

  /* ------------------------------------------------------------------ */
  /* View registration                                                   */
  /* ------------------------------------------------------------------ */
  S.registerView({
    id: MODULE_ID,
    nav: { section: 'project', icon: '📦', label: 'Receiving / GRN', labelAr: 'استلام البضاعة' },
    roles: ['director', 'controller', 'super'],
    render: function (el) {
      try {
        MOD.el = el;
        if (MOD.loaded && !MOD.stale) {
          el.innerHTML = '<div data-sf-grn="list"></div>';
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
