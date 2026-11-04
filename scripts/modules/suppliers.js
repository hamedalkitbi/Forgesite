/* ============================================================================
 * SiteForge module: Suppliers & Contractors (company-level directory)
 * ----------------------------------------------------------------------------
 * A company-wide master directory of suppliers and subcontractors, reused across
 * projects, parties, POs and payment requests. Managers (director / controller)
 * list, add, edit, deactivate and delete suppliers, and link each supplier to
 * projects with a per-project contract amount + reference.
 *
 * Owned by: suppliers-dev. Contract: docs/modules/CONTRACT.md.
 * Table + RLS: supabase/migrations/202611050001_phase1_accountability.sql
 *   (public.suppliers + public.project_suppliers).
 * Docs: docs/modules/suppliers.md. Checks: tools/checks/suppliers.mjs.
 *
 * The module never edits scripts/app.js. It only uses the window.SF bridge and
 * registers the "suppliers" view. A small pure/defensive API is exposed on
 * window.SF_modules.suppliers = { list, lookup, linkToProject, unlink, active }.
 * ========================================================================== */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db;
  var UI = S.ui;

  var MODULE_ID = 'suppliers';
  var TABLE = 'suppliers';
  var LINK_TABLE = 'project_suppliers';
  var MIGRATION = 'supabase/migrations/202611050001_phase1_accountability.sql';
  var KINDS = ['supplier', 'subcontractor', 'both'];
  var STATUSES = ['active', 'inactive', 'blocked'];

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
  function money0(n) {
    if (H.money0) return H.money0(round2(n));
    var v = round2(n);
    return (v < 0 ? '-AED ' : 'AED ') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  /* ------------------------------------------------------------------ */
  /* i18n (EN + AR; real Arabic, never machine transliteration)          */
  /* ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Suppliers & Contractors',
      subtitle: 'Company-wide supplier and contractor directory',
      newBtn: '+ New supplier',
      loading: 'Loading suppliers…',
      empty: 'No suppliers yet.',
      emptyHint: 'Add your first supplier to reuse them across projects.',
      countLabel: 'records',
      migrationTitle: 'Database update required',
      migrationBody: 'Suppliers & Contractors needs the suppliers table before it can list or save suppliers.',
      migrationRun: 'Run',
      migrationRunAfter: 'in the Supabase SQL editor, then reload this page.',
      retry: 'Retry',
      colName: 'Name',
      colKind: 'Kind',
      colTrade: 'Trade',
      colTrn: 'TRN',
      colContact: 'Contact',
      colTerms: 'Payment terms',
      colStatus: 'Status',
      colActions: 'Actions',
      kindSupplier: 'Supplier',
      kindSubcontractor: 'Subcontractor',
      kindBoth: 'Supplier & Subcontractor',
      statusActive: 'Active',
      statusInactive: 'Inactive',
      statusBlocked: 'Blocked',
      edit: 'Edit',
      deactivate: 'Deactivate',
      activate: 'Activate',
      delete: 'Delete',
      linkedProjects: 'Linked projects',
      noLinks: 'No projects linked yet.',
      addProject: '+ Add project',
      remove: 'Remove',
      contractAmount: 'Contract amount (AED)',
      reference: 'Reference',
      notes: 'Notes',
      project: 'Project',
      close: 'Close',
      createTitle: 'New supplier',
      editTitle: 'Edit supplier',
      fName: 'Name',
      fKind: 'Kind',
      fTrade: 'Trade',
      fTrn: 'TRN',
      fContact: 'Contact person',
      fPhone: 'Phone',
      fEmail: 'Email',
      fAddress: 'Address',
      fBank: 'Bank name',
      fIban: 'IBAN',
      fAccountNo: 'Account no.',
      fTerms: 'Payment terms (days)',
      fVat: 'VAT %',
      fStatus: 'Status',
      deleteConfirm: 'Delete supplier',
      deleteConfirmBody: 'This removes the supplier and its project links.',
      deactivateConfirm: 'Deactivate supplier',
      deactivateConfirmBody: 'Mark this supplier as inactive?',
      activateConfirm: 'Activate supplier',
      saving: 'Saving…',
      savedOk: 'Saved ✓',
      deletedOk: 'Deleted',
      deactivatedOk: 'Supplier deactivated',
      activatedOk: 'Supplier activated',
      linkedOk: 'Project linked ✓',
      unlinkedOk: 'Project unlinked',
      failed: 'Failed',
      noPermission: 'Access denied',
      nameRequired: 'Name is required',
      noUnlinkedProjects: 'All projects are already linked.',
      unknownProject: 'Unknown project',
      loadingLinks: 'Loading project links…',
      netTerms: 'Net {n} days'
    },
    ar: {
      title: 'الموردون والمقاولون',
      subtitle: 'دليل الموردين والمقاولين على مستوى الشركة',
      newBtn: '+ مورد جديد',
      loading: 'جارٍ تحميل الموردين…',
      empty: 'لا يوجد موردون بعد.',
      emptyHint: 'أضف أول مورد لإعادة استخدامه عبر المشاريع.',
      countLabel: 'سجلاً',
      migrationTitle: 'يلزم تحديث قاعدة البيانات',
      migrationBody: 'يتطلب قسم الموردين والمقاولين جدول suppliers قبل أن يتمكن من عرض الموردين أو حفظهم.',
      migrationRun: 'شغّل',
      migrationRunAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      retry: 'إعادة المحاولة',
      colName: 'الاسم',
      colKind: 'النوع',
      colTrade: 'التخصص',
      colTrn: 'الرقم الضريبي',
      colContact: 'جهة الاتصال',
      colTerms: 'شروط الدفع',
      colStatus: 'الحالة',
      colActions: 'إجراءات',
      kindSupplier: 'مورد',
      kindSubcontractor: 'مقاول باطن',
      kindBoth: 'مورد ومقاول',
      statusActive: 'نشط',
      statusInactive: 'غير نشط',
      statusBlocked: 'محظور',
      edit: 'تعديل',
      deactivate: 'إيقاف',
      activate: 'تفعيل',
      delete: 'حذف',
      linkedProjects: 'المشاريع المرتبطة',
      noLinks: 'لا توجد مشاريع مرتبطة بعد.',
      addProject: '+ إضافة مشروع',
      remove: 'إزالة',
      contractAmount: 'قيمة العقد (درهم)',
      reference: 'المرجع',
      notes: 'ملاحظات',
      project: 'المشروع',
      close: 'إغلاق',
      createTitle: 'مورد جديد',
      editTitle: 'تعديل مورد',
      fName: 'الاسم',
      fKind: 'النوع',
      fTrade: 'التخصص',
      fTrn: 'الرقم الضريبي TRN',
      fContact: 'الشخص المسؤول',
      fPhone: 'الهاتف',
      fEmail: 'البريد الإلكتروني',
      fAddress: 'العنوان',
      fBank: 'اسم البنك',
      fIban: 'IBAN',
      fAccountNo: 'رقم الحساب',
      fTerms: 'شروط الدفع (أيام)',
      fVat: 'نسبة ضريبة القيمة المضافة %',
      fStatus: 'الحالة',
      deleteConfirm: 'حذف مورد',
      deleteConfirmBody: 'سيؤدي هذا إلى حذف المورد وروابط مشاريعه.',
      deactivateConfirm: 'إيقاف مورد',
      deactivateConfirmBody: 'هل تريد وضع علامة غير نشط على هذا المورد؟',
      activateConfirm: 'تفعيل مورد',
      saving: 'جارٍ الحفظ…',
      savedOk: 'تم الحفظ ✓',
      deletedOk: 'تم الحذف',
      deactivatedOk: 'تم إيقاف المورد',
      activatedOk: 'تم تفعيل المورد',
      linkedOk: 'تم ربط المشروع ✓',
      unlinkedOk: 'تم إلغاء ربط المشروع',
      failed: 'فشل',
      noPermission: 'الوصول مرفوض',
      nameRequired: 'الاسم مطلوب',
      noUnlinkedProjects: 'جميع المشاريع مرتبطة بالفعل.',
      unknownProject: 'مشروع غير معروف',
      loadingLinks: 'جارٍ تحميل روابط المشاريع…',
      netTerms: 'صافي {n} يوماً'
    }
  };
  function currentLang() { return (S.language === 'ar') ? 'ar' : 'en'; }
  function labelFor(lang, k) {
    var dict = L[lang] || L.en;
    return dict[k] != null ? dict[k] : (L.en[k] != null ? L.en[k] : k);
  }
  function pick(k) { return labelFor(currentLang(), k); }
  function termsText(days) {
    if (days === null || days === undefined || days === '') return '—';
    var n = num(days);
    return labelFor(currentLang(), 'netTerms').replace('{n}', String(n));
  }

  /* ------------------------------------------------------------------ */
  /* Bridge accessors (all null-safe)                                    */
  /* ------------------------------------------------------------------ */
  function client() {
    try {
      if (DB && typeof DB.client === 'function') return DB.client();
    } catch (e) { /* ignore */ }
    return null;
  }
  function companyId() {
    try { return (S.company && S.company.id) || null; } catch (e) { return null; }
  }
  function projectsState() {
    try { return (S.data && S.data.state && S.data.state.projects) || []; } catch (e) { return []; }
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
    return Promise.resolve()
      .then(function () { return DB.selectStrict(TABLE, { company_id: companyId() }, 'name', true); })
      .then(function (r) { return { rows: (r && r.rows) || [], error: (r && r.error) || null }; })
      .catch(function (e) { return { rows: [], error: e }; });
  }
  function loadLinks(supplierId) {
    var c = client();
    if (!c) return Promise.resolve([]);
    return Promise.resolve()
      .then(function () { return c.from(LINK_TABLE).select('*').eq('supplier_id', supplierId); })
      .then(function (r) { return (r && r.data) || []; })
      .catch(function () { return []; });
  }

  /* ------------------------------------------------------------------ */
  /* Pure / defensive public API (never throws)                          */
  /* ------------------------------------------------------------------ */
  function list() {
    return (MOD.rows || []).slice();
  }
  function active() {
    return list().filter(function (r) { return r && r.status === 'active'; });
  }
  function lookup(name) {
    var q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    var rows = MOD.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && String(r.name || '').trim().toLowerCase() === q) return r;
    }
    return null;
  }
  function linkToProject(supplierId, projectId, opts) {
    opts = opts || {};
    if (!supplierId || !projectId) {
      return Promise.resolve({ data: null, error: new Error('supplierId and projectId are required') });
    }
    var c = client();
    if (!c) return Promise.resolve({ data: null, error: new Error('Supabase client not ready') });
    var payload = {
      project_id: projectId,
      supplier_id: supplierId,
      contract_amount_aed: (opts.contract_amount_aed === null || opts.contract_amount_aed === undefined || opts.contract_amount_aed === '') ? null : round2(opts.contract_amount_aed),
      reference: opts.reference || null,
      notes: opts.notes || null
    };
    return Promise.resolve()
      .then(function () {
        return c.from(LINK_TABLE).upsert(payload, { onConflict: 'project_id,supplier_id' });
      })
      .then(function (r) { return { data: (r && r.data) || null, error: (r && r.error) || null }; })
      .catch(function (e) { return { data: null, error: e }; });
  }
  function unlink(projectId, supplierId) {
    if (!projectId || !supplierId) {
      return Promise.resolve({ data: null, error: new Error('projectId and supplierId are required') });
    }
    var c = client();
    if (!c) return Promise.resolve({ data: null, error: new Error('Supabase client not ready') });
    return Promise.resolve()
      .then(function () {
        return c.from(LINK_TABLE).delete().eq('project_id', projectId).eq('supplier_id', supplierId);
      })
      .then(function (r) { return { data: (r && r.data) || null, error: (r && r.error) || null }; })
      .catch(function (e) { return { data: null, error: e }; });
  }

  /* Expose the API. It is written before view registration so datalist
   * consumers (and the Node checks) can reach it as soon as the module loads. */
  window.SF_modules = window.SF_modules || {};
  window.SF_modules[MODULE_ID] = {
    list: list,
    lookup: lookup,
    linkToProject: linkToProject,
    unlink: unlink,
    active: active,
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
  function projectNameOf(pid) {
    var projs = projectsState();
    for (var i = 0; i < projs.length; i++) {
      if (projs[i] && projs[i].id === pid) {
        return (projs[i].code ? projs[i].code + ' · ' : '') + (projs[i].name || pid);
      }
    }
    return pid ? String(pid) : pick('unknownProject');
  }
  function kindTag(kind) {
    var k = String(kind || 'supplier').toLowerCase();
    var cls = k === 'subcontractor' ? 'pur' : (k === 'both' ? 'mut' : 'info');
    var label = k === 'subcontractor' ? pick('kindSubcontractor') : (k === 'both' ? pick('kindBoth') : pick('kindSupplier'));
    return '<span class="tag ' + cls + '">' + esc(label) + '</span>';
  }
  function statusTag(status) {
    var s = String(status || 'active').toLowerCase();
    var cls = s === 'active' ? 'ok' : (s === 'blocked' ? 'bad' : 'warn');
    var label = s === 'blocked' ? pick('statusBlocked') : (s === 'inactive' ? pick('statusInactive') : pick('statusActive'));
    return '<span class="tag ' + cls + '">' + esc(label) + '</span>';
  }
  function tableHTML(headers, rowsHtml, emptyText) {
    return '<div style="overflow-x:auto"><table><thead><tr>' +
      headers.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + esc(h.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="' + headers.length + '" class="empty">' + esc(emptyText || pick('empty')) + '</td></tr>') +
      '</tbody></table></div>';
  }
  function actionBtn(action, label, icon, title, cls) {
    return '<button type="button" class="btn ghost sm ' + (cls || '') + '" data-sf-action="' + esc(action) + '"' +
      (title ? ' title="' + esc(title) + '"' : '') + '>' + (icon ? icon + ' ' : '') + esc(label) + '</button>';
  }

  function rowHtml(r) {
    var contactParts = [];
    if (r.contact_person) contactParts.push(r.contact_person);
    if (r.phone) contactParts.push(r.phone);
    if (r.email) contactParts.push(r.email);
    var contact = contactParts.join(' · ');
    var terms = termsText(r.payment_terms_days);
    var vatNote = (r.vat_pct !== null && r.vat_pct !== undefined && r.vat_pct !== '') ? ('VAT ' + round2(r.vat_pct) + '%') : '';
    var actions = [];
    actions.push(actionBtn('links', pick('linkedProjects'), '🔗', pick('linkedProjects')));
    actions.push(actionBtn('edit', pick('edit'), '✎', pick('edit')));
    if (String(r.status || '').toLowerCase() === 'active') {
      actions.push(actionBtn('toggle', pick('deactivate'), '⏸', pick('deactivate')));
    } else {
      actions.push(actionBtn('toggle', pick('activate'), '▶', pick('activate')));
    }
    actions.push(actionBtn('delete', pick('delete'), '🗑', pick('delete'), 'badc'));

    return '<tr>' +
      '<td><b>' + esc(r.name || '—') + '</b>' +
        (vatNote ? '<div class="mutc mono" style="font-size:10.5px">' + esc(vatNote) + '</div>' : '') + '</td>' +
      '<td>' + kindTag(r.kind) + '</td>' +
      '<td>' + esc(r.trade || '—') + '</td>' +
      '<td class="mono">' + esc(r.trn || '—') + '</td>' +
      '<td>' + (contact ? esc(contact) : '—') + '</td>' +
      '<td class="mono">' + esc(terms) + '</td>' +
      '<td>' + statusTag(r.status) + '</td>' +
      '<td class="nowrap">' + actions.join(' ') + '</td>' +
      '</tr>';
  }

  function tableCard() {
    var rows = MOD.rows;
    if (!rows.length) {
      return '<div class="card"><div class="empty"><div class="big">🏢</div>' + esc(pick('empty')) +
        '<div class="mutc" style="font-size:11px;margin-top:6px">' + esc(pick('emptyHint')) + '</div></div></div>';
    }
    var headers = [
      { label: pick('colName') }, { label: pick('colKind') }, { label: pick('colTrade') },
      { label: pick('colTrn') }, { label: pick('colContact') }, { label: pick('colTerms') },
      { label: pick('colStatus') }, { label: pick('colActions') }
    ];
    return '<div class="card"><h3>🏢 ' + esc(pick('title')) + '</h3>' +
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

  function buildView() {
    var companyName = (S.company && S.company.name) || '—';
    var head = '<h2 class="vt">🏢 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(companyName) + ' · ' + MOD.rows.length + ' ' + esc(pick('countLabel')) +
      ' · ' + esc(pick('subtitle')) +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn" data-sf-action="new">➕ ' + esc(pick('newBtn')) + '</button></div>';
    var body = MOD.error ? migrationCard(MOD.error) : tableCard();
    return '<div data-sf-suppliers="list">' + head + body + '</div>';
  }

  function loadingHTML() {
    return '<div data-sf-suppliers="loading"><h2 class="vt">🏢 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>' +
      '<div class="card"><div class="empty"><div class="big">🏢</div>' + esc(pick('loading')) + '</div></div></div>';
  }
  function errorHTML(e) {
    var msg = (e && e.message) || String(e) || 'Unexpected error';
    return '<div data-sf-suppliers="error"><h2 class="vt">🏢 ' + esc(pick('title')) + '</h2>' +
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
      if (action === 'new') openSupplierForm(null);
      else if (action === 'retry') { MOD.stale = true; startRender(MOD.el); }
      else if (action === 'edit' && row) openSupplierForm(row);
      else if (action === 'toggle' && row) toggleStatus(row);
      else if (action === 'delete' && row) removeSupplier(row);
      else if (action === 'links' && row) openLinkedProjects(row);
    });
  }

  function paint(el) {
    if (!el || !el.querySelector) return;
    if (!el.querySelector('[data-sf-suppliers]')) return; /* view changed under us */
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
  /* Actions: create / edit / toggle / delete                            */
  /* ------------------------------------------------------------------ */
  function kindOptions() {
    return [
      { value: 'supplier', label: pick('kindSupplier') },
      { value: 'subcontractor', label: pick('kindSubcontractor') },
      { value: 'both', label: pick('kindBoth') }
    ];
  }
  function statusOptions() {
    return [
      { value: 'active', label: pick('statusActive') },
      { value: 'inactive', label: pick('statusInactive') },
      { value: 'blocked', label: pick('statusBlocked') }
    ];
  }

  function openSupplierForm(row) {
    if (!UI.openFormModal) { UI.toast(pick('failed'), 'bad'); return; }
    var isEdit = !!row;
    var v = row || {};
    UI.openFormModal({
      title: (isEdit ? '✎ ' + pick('editTitle') : '➕ ' + pick('createTitle')) + (isEdit ? ' — ' + esc(v.name || '') : ''),
      wide: true,
      values: {
        name: v.name || '',
        kind: v.kind || 'supplier',
        trade: v.trade || '',
        trn: v.trn || '',
        contact_person: v.contact_person || '',
        phone: v.phone || '',
        email: v.email || '',
        address: v.address || '',
        bank_name: v.bank_name || '',
        iban: v.iban || '',
        account_no: v.account_no || '',
        payment_terms_days: (v.payment_terms_days !== null && v.payment_terms_days !== undefined) ? v.payment_terms_days : 30,
        vat_pct: (v.vat_pct !== null && v.vat_pct !== undefined) ? v.vat_pct : 5,
        status: v.status || 'active'
      },
      fields: [
        { key: 'name', label: pick('fName'), required: true },
        { key: 'kind', label: pick('fKind'), type: 'select', options: kindOptions(), required: true },
        { key: 'trade', label: pick('fTrade') },
        { key: 'trn', label: pick('fTrn') },
        { key: 'contact_person', label: pick('fContact') },
        { key: 'phone', label: pick('fPhone') },
        { key: 'email', label: pick('fEmail'), type: 'email' },
        { key: 'address', label: pick('fAddress'), full: true },
        { key: 'bank_name', label: pick('fBank') },
        { key: 'iban', label: pick('fIban') },
        { key: 'account_no', label: pick('fAccountNo') },
        { key: 'payment_terms_days', label: pick('fTerms'), type: 'number', step: '1' },
        { key: 'vat_pct', label: pick('fVat'), type: 'number', step: '0.01' },
        { key: 'status', label: pick('fStatus'), type: 'select', options: statusOptions() }
      ],
      onSubmit: function (values) {
        var payload = {
          company_id: companyId(),
          name: String(values.name || '').trim(),
          kind: values.kind || 'supplier',
          trade: values.trade || null,
          trn: values.trn || null,
          contact_person: values.contact_person || null,
          phone: values.phone || null,
          email: values.email || null,
          address: values.address || null,
          bank_name: values.bank_name || null,
          iban: values.iban || null,
          account_no: values.account_no || null,
          payment_terms_days: num(values.payment_terms_days),
          vat_pct: num(values.vat_pct),
          status: values.status || 'active',
          created_by: (S.user && S.user.name) || null
        };
        if (!payload.name) throw new Error(pick('nameRequired'));
        var write = isEdit ? DB.update(TABLE, v.id, payload) : DB.insert(TABLE, payload);
        return Promise.resolve(write).then(function () {
          UI.toast(pick('savedOk'), 'ok');
          MOD.stale = true;
          if (MOD.el) startRender(MOD.el);
        }).catch(function (e) {
          throw new Error((e && e.message) || String(e));
        });
      }
    });
  }

  function toggleStatus(row) {
    if (!row) return;
    var current = String(row.status || '').toLowerCase();
    var next = current === 'active' ? 'inactive' : 'active';
    var msg = current === 'active' ? pick('deactivateConfirm') : pick('activateConfirm');
    var ok = false;
    try { ok = window.confirm(msg + ' — ' + (row.name || '')); } catch (e) { ok = false; }
    if (!ok) return;
    Promise.resolve(DB.update(TABLE, row.id, { status: next })).then(function () {
      UI.toast(next === 'active' ? pick('activatedOk') : pick('deactivatedOk'), 'ok');
      MOD.stale = true;
      if (MOD.el) startRender(MOD.el);
    }).catch(function (e) {
      UI.toast(pick('failed') + ': ' + ((e && e.message) || 'error'), 'bad');
    });
  }

  function removeSupplier(row) {
    if (!row) return;
    var ok = false;
    try { ok = window.confirm(pick('deleteConfirm') + ' — ' + (row.name || '') + '?\n' + pick('deleteConfirmBody')); } catch (e) { ok = false; }
    if (!ok) return;
    Promise.resolve(DB.remove(TABLE, row.id)).then(function () {
      UI.toast(pick('deletedOk'), 'ok');
      MOD.stale = true;
      if (MOD.el) startRender(MOD.el);
    }).catch(function (e) {
      UI.toast(pick('failed') + ': ' + ((e && e.message) || 'error'), 'bad');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Linked projects modal                                               */
  /* ------------------------------------------------------------------ */
  function linksBodyHtml(supplier, links) {
    var rows = [];
    (links || []).forEach(function (l) {
      var amount = (l.contract_amount_aed !== null && l.contract_amount_aed !== undefined && l.contract_amount_aed !== '') ? money0(l.contract_amount_aed) : '—';
      rows.push(
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)">' +
        '<div style="min-width:0"><b style="font-size:13px">' + esc(projectNameOf(l.project_id)) + '</b>' +
        (l.reference ? '<div class="mutc mono" style="font-size:10.5px">' + esc(l.reference) + '</div>' : '') +
        (l.notes ? '<div class="mutc" style="font-size:11px">' + esc(l.notes) + '</div>' : '') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0">' +
        '<b class="mono">' + amount + '</b>' +
        '<button type="button" class="btn ghost sm badc" data-sf-link-action="remove" data-project="' + esc(l.project_id) + '" title="' + esc(pick('remove')) + '">✕</button>' +
        '</div></div>'
      );
    });
    if (!rows.length) {
      rows.push('<div class="empty"><div class="big">🔗</div>' + esc(pick('noLinks')) + '</div>');
    }
    return rows.join('');
  }

  function linkModalFooter() {
    return '<button type="button" class="btn ghost" data-sf-link-action="close">' + esc(pick('close')) + '</button>' +
      '<button type="button" class="btn" data-sf-link-action="add">➕ ' + esc(pick('addProject')) + '</button>';
  }

  /* One delegated listener per opened modal; dynamically re-rendered remove
   * buttons are handled without re-binding (which would double-fire add/close). */
  function bindLinkActions(supplier) {
    var root = document.getElementById('modalRoot');
    if (!root) return;
    root.addEventListener('click', function (ev) {
      var t = ev.target;
      var btn = t && t.closest ? t.closest('[data-sf-link-action]') : null;
      if (!btn || !root.contains(btn)) return;
      var action = btn.getAttribute('data-sf-link-action');
      if (action === 'close') { try { UI.closeModal(); } catch (e) {} return; }
      if (action === 'add') openLinkForm(supplier);
      else if (action === 'remove') removeLink(supplier, btn.getAttribute('data-project'));
    });
  }

  function openLinkedProjects(supplier) {
    if (!supplier || !UI.openModal) return;
    var sid = supplier.id;
    if (!sid) return;
    UI.openModal('🔗 ' + pick('linkedProjects') + ' — ' + esc(supplier.name || ''), loadingLinksHtml(), linkModalFooter(), { wide: true });
    bindLinkActions(supplier);
    loadLinks(sid).then(function (links) {
      var body = document.querySelector('#modalRoot .mbody');
      if (!body) return;
      body.innerHTML = linksBodyHtml(supplier, links);
    }).catch(function () {
      var body = document.querySelector('#modalRoot .mbody');
      if (body) body.innerHTML = '<div class="empty">' + esc(pick('failed')) + '</div>';
    });
  }

  function loadingLinksHtml() {
    return '<div class="empty"><div class="big">🔗</div>' + esc(pick('loadingLinks')) + '</div>';
  }

  function reloadLinkBody(supplier) {
    loadLinks(supplier.id).then(function (links) {
      var body = document.querySelector('#modalRoot .mbody');
      if (!body) return;
      body.innerHTML = linksBodyHtml(supplier, links);
    }).catch(function () {});
  }

  function removeLink(supplier, projectId) {
    if (!projectId) return;
    unlink(projectId, supplier.id).then(function (res) {
      if (res && res.error) {
        UI.toast(pick('failed') + ': ' + ((res.error.message) || String(res.error)), 'bad');
        return;
      }
      UI.toast(pick('unlinkedOk'), 'ok');
      reloadLinkBody(supplier);
    });
  }

  function openLinkForm(supplier) {
    if (!UI.openFormModal) { UI.toast(pick('failed'), 'bad'); return; }
    loadLinks(supplier.id).then(function (links) {
      var linked = {};
      (links || []).forEach(function (l) { if (l.project_id) linked[l.project_id] = true; });
      var options = projectsState().filter(function (p) {
        return p && p.id && !linked[p.id];
      }).map(function (p) {
        return { value: p.id, label: (p.code ? p.code + ' · ' : '') + (p.name || p.id) };
      });
      if (!options.length) { UI.toast(pick('noUnlinkedProjects'), 'bad'); return; }
      UI.openFormModal({
        title: '🔗 ' + pick('addProject') + ' — ' + esc(supplier.name || ''),
        wide: true,
        values: { project_id: options[0].value, contract_amount_aed: 0, reference: '', notes: '' },
        fields: [
          { key: 'project_id', label: pick('project'), type: 'select', options: options, required: true },
          { key: 'contract_amount_aed', label: pick('contractAmount'), type: 'number', step: '0.01' },
          { key: 'reference', label: pick('reference') },
          { key: 'notes', label: pick('notes'), type: 'textarea', rows: 2, full: true }
        ],
        onSubmit: function (values) {
          return linkToProject(supplier.id, values.project_id, {
            contract_amount_aed: values.contract_amount_aed,
            reference: values.reference || null,
            notes: values.notes || null
          }).then(function (res) {
            if (res && res.error) throw new Error((res.error.message) || String(res.error));
            UI.toast(pick('linkedOk'), 'ok');
            reloadLinkBody(supplier);
          });
        }
      });
    }).catch(function () { UI.toast(pick('failed'), 'bad'); });
  }

  /* ------------------------------------------------------------------ */
  /* View registration                                                   */
  /* ------------------------------------------------------------------ */
  S.registerView({
    id: MODULE_ID,
    nav: { section: 'company', icon: '🏢', label: 'Suppliers & Contractors', labelAr: 'الموردون والمقاولون' },
    roles: ['director', 'controller'],
    render: function (el) {
      try {
        MOD.el = el;
        if (MOD.loaded && !MOD.stale) {
          el.innerHTML = '<div data-sf-suppliers="list"></div>';
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
