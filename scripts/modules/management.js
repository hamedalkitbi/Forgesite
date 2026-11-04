/* ============================================================================
 * SiteForge module: Management Exceptions (company-level dashboard)
 * ----------------------------------------------------------------------------
 * A company-wide "management by exception" dashboard for Directors and
 * Financial Controllers. It aggregates across all projects (no project filter)
 * and surfaces five risk indicators:
 *
 *   1. Overdue approvals            — pending items older than the approval SLA
 *   2. Unlinked material cost       — materials with no BOQ link
 *   3. Duplicate supplier invoices  — repeated invoice_no in `payments`
 *   4. Committed-but-undelivered POs— materials still Ordered / In Transit
 *   5. Open retention               — certified+paid retention minus releases
 *
 * Owned by: modules3. Contract: docs/modules/CONTRACT.md.
 * Tables + RLS: supabase/migrations/202611050003_phase3.sql (retention_releases)
 *   plus the core `materials` / `payments` / `progress_billings` tables.
 * Docs: docs/modules/management.md. Checks: tools/checks/management.mjs.
 *
 * The module never edits scripts/app.js. It only uses the window.SF bridge and
 * registers the "management" view. A small pure/defensive API is exposed on
 * window.SF_modules.management = { unlinkedMaterialCost, duplicateSupplierInvoices,
 * committedUndeliveredPos, openRetentionTotal, overdueApprovals, metrics }.
 * ========================================================================== */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db;
  var UI = S.ui;

  var MODULE_ID = 'management';
  var MIGRATION = 'supabase/migrations/202611050003_phase3.sql';
  var CORE_TABLES = ['materials', 'payments', 'progress_billings'];
  var OPTIONAL_TABLES = ['retention_releases'];
  var ACCRUED_STAGES = { 'Delivered': true, 'Inspected': true, 'Installed': true };
  var COMMITTED_STAGES = { 'Ordered': true, 'In Transit': true };

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
  function money0(n) {
    if (H.money0) return H.money0(round2(n));
    var v = round2(n);
    return (v < 0 ? '-AED ' : 'AED ') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function money(n) {
    if (H.money) return H.money(round2(n));
    var v = round2(n);
    return (v < 0 ? '-AED ' : 'AED ') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(v) {
    if (H.fmtDate) return H.fmtDate(v);
    if (v === null || v === undefined || v === '') return '—';
    var s = String(v).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '—';
  }
  function toLocalDate(v) {
    if (H.toLocalDate) { try { var d = H.toLocalDate(v); if (d) return d; } catch (e) { /* fall through */ } }
    if (v === null || v === undefined || v === '') return null;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  }
  function daysSince(v, nowValue) {
    var d = toLocalDate(v);
    if (!d) return null;
    var now = nowValue ? toLocalDate(nowValue) : null;
    if (!now) { now = new Date(); now = new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
    return Math.round((now - d) / 86400000);
  }

  /* ------------------------------------------------------------------ */
  /* i18n (EN + AR; real Arabic, never machine transliteration)          */
  /* ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Management Exceptions',
      subtitle: 'Company-wide management by exception',
      loading: 'Loading management exceptions…',
      retry: 'Retry',
      migrationTitle: 'Database update required',
      migrationBody: 'Management Exceptions needs the retention_releases table for the open-retention metric.',
      migrationRun: 'Run',
      migrationRunAfter: 'in the Supabase SQL editor, then reload this page.',
      failed: 'Failed',
      noData: 'No exceptions to report.',
      kpiOverdue: 'Overdue approvals',
      kpiUnlinked: 'Unlinked material cost',
      kpiDupInvoice: 'Duplicate supplier invoices',
      kpiCommitted: 'Committed · undelivered POs',
      kpiRetention: 'Open retention',
      overdueTitle: 'Overdue approvals',
      unlinkedTitle: 'Materials not linked to BOQ',
      dupTitle: 'Duplicate supplier invoice numbers',
      committedTitle: 'Committed POs not yet delivered',
      retentionTitle: 'Retention by project',
      colType: 'Type',
      colItem: 'Item',
      colProject: 'Project',
      colAge: 'Age',
      colAmount: 'Amount',
      colSupplier: 'Supplier',
      colPo: 'PO',
      colDesc: 'Description',
      colCost: 'Cost',
      colStage: 'Stage',
      colQty: 'Qty',
      colInvoice: 'Invoice #',
      colCount: 'Count',
      colRetained: 'Retained',
      colReleased: 'Released',
      colOpen: 'Open',
      overdueSub: 'items overdue',
      exposure: 'exposure',
      materials: 'materials',
      pos: 'POs',
      invoices: 'invoices',
      retainedSub: 'retained',
      releasedSub: 'released',
      slaDays: 'SLA',
      days: 'd'
    },
    ar: {
      title: 'مؤشرات الإدارة',
      subtitle: 'إدارة الاستثناءات على مستوى الشركة',
      loading: 'جارٍ تحميل مؤشرات الإدارة…',
      retry: 'إعادة المحاولة',
      migrationTitle: 'يلزم تحديث قاعدة البيانات',
      migrationBody: 'يتطلب قسم مؤشرات الإدارة جدول retention_releases لحساب مؤشر الاستحقاق المفتوح.',
      migrationRun: 'شغّل',
      migrationRunAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      failed: 'فشل',
      noData: 'لا توجد استثناءات لعرضها.',
      kpiOverdue: 'اعتمادات متأخرة',
      kpiUnlinked: 'تكلفة مواد غير مربوطة',
      kpiDupInvoice: 'فواتير موردين مكررة',
      kpiCommitted: 'أوامر شراء ملتزم بها غير مسلّمة',
      kpiRetention: 'الاستحقاق المفتوح',
      overdueTitle: 'الاعتمادات المتأخرة',
      unlinkedTitle: 'مواد غير مربوطة بجدول الكميات',
      dupTitle: 'أرقام فواتير موردين مكررة',
      committedTitle: 'أوامر شراء ملتزم بها لم تُسلَّم بعد',
      retentionTitle: 'الاستحقاق حسب المشروع',
      colType: 'النوع',
      colItem: 'البند',
      colProject: 'المشروع',
      colAge: 'العمر',
      colAmount: 'المبلغ',
      colSupplier: 'المورد',
      colPo: 'أمر الشراء',
      colDesc: 'الوصف',
      colCost: 'التكلفة',
      colStage: 'المرحلة',
      colQty: 'الكمية',
      colInvoice: 'رقم الفاتورة',
      colCount: 'العدد',
      colRetained: 'المحتجز',
      colReleased: 'المُحرَّر',
      colOpen: 'المفتوح',
      overdueSub: 'بند متأخر',
      exposure: 'التعرض',
      materials: 'مواد',
      pos: 'أوامر شراء',
      invoices: 'فواتير',
      retainedSub: 'المحتجز',
      releasedSub: 'المُحرَّر',
      slaDays: 'مهلة الاعتماد',
      days: 'يوم'
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
  function state() {
    try { return (S.data && S.data.state) || {}; } catch (e) { return {}; }
  }
  function projectsState() {
    try { return (state().projects) || []; } catch (e) { return []; }
  }
  function projectNameOf(pid) {
    if (!pid) return '—';
    var projs = projectsState();
    for (var i = 0; i < projs.length; i++) {
      if (projs[i] && String(projs[i].id) === String(pid)) {
        return (projs[i].code ? projs[i].code + ' · ' : '') + (projs[i].name || pid);
      }
    }
    return String(pid);
  }

  /* ------------------------------------------------------------------ */
  /* Normalisers (raw snake_case rows → the same camelCase shape app.js  */
  /* maps into SF.data.state, so the metric logic reads cleanly)         */
  /* ------------------------------------------------------------------ */
  function mapMaterial(x) {
    return {
      id: x.id, project_id: x.project_id,
      boq_item_id: x.boq_item_id || null, po: x.po_number || '', invoiceNo: x.invoice_no || '',
      supplier: x.supplier || '', trade: x.trade || '', desc: x.description || '',
      qty: num(x.quantity), unit: x.unit || '', unitCost: num(x.unit_cost_aed),
      stage: x.stage || '', date: x.invoice_date || null, status: x.status || 'approved'
    };
  }
  function mapPayment(x) {
    return {
      id: x.id, project_id: x.project_id, type: x.payment_type || '',
      invoiceNo: x.invoice_no || '', desc: x.description || '',
      amount: num(x.amount), dueDate: x.due_date || null, paidDate: x.paid_date || null,
      status: x.status || '', method: x.payment_method || ''
    };
  }
  function mapBilling(x) {
    return {
      id: x.id, project_id: x.project_id, billingNo: x.billing_no || '',
      status: x.status || '', retentionAmount: num(x.retention_amount),
      totalClaim: num(x.total_claim)
    };
  }

  /* ------------------------------------------------------------------ */
  /* Pure metric functions (exposed; each takes data as an argument)     */
  /* ------------------------------------------------------------------ */
  function unlinkedMaterialCost(materials) {
    var rows = (Array.isArray(materials) ? materials : []).filter(function (m) { return m && !m.boq_item_id; });
    var value = round2(rows.reduce(function (s, m) { return s + num(m.qty) * num(m.unitCost); }, 0));
    return { count: rows.length, value: value, rows: rows };
  }
  function duplicateSupplierInvoices(payments) {
    var byNo = {};
    (Array.isArray(payments) ? payments : []).forEach(function (p) {
      var key = String(p && p.invoiceNo ? p.invoiceNo : '').trim().toLowerCase();
      if (!key) return;
      (byNo[key] = byNo[key] || []).push(p);
    });
    var dups = Object.keys(byNo).filter(function (k) { return byNo[k].length > 1; }).map(function (k) {
      var rows = byNo[k];
      var value = round2(rows.reduce(function (s, p) { return s + num(p.amount); }, 0));
      return { invoiceNo: (rows[0] && rows[0].invoiceNo) || k, count: rows.length, value: value, rows: rows };
    });
    var value = round2(dups.reduce(function (s, d) { return s + d.value; }, 0));
    return { count: dups.length, value: value, rows: dups };
  }
  function committedUndeliveredPos(materials) {
    var rows = (Array.isArray(materials) ? materials : []).filter(function (m) {
      return m && COMMITTED_STAGES[String(m.stage || '')];
    });
    var value = round2(rows.reduce(function (s, m) { return s + num(m.qty) * num(m.unitCost); }, 0));
    return { count: rows.length, value: value, rows: rows };
  }
  function openRetentionTotal(billings, releases) {
    var retained = round2((Array.isArray(billings) ? billings : []).filter(function (b) {
      return b && (b.status === 'certified' || b.status === 'paid');
    }).reduce(function (s, b) { return s + num(b.retentionAmount); }, 0));
    var released = round2((Array.isArray(releases) ? releases : []).reduce(function (s, r) { return s + num(r && r.amount_aed); }, 0));
    var byProject = {};
    (Array.isArray(billings) ? billings : []).forEach(function (b) {
      if (!b || (b.status !== 'certified' && b.status !== 'paid')) return;
      var pid = b.project_id || '—';
      byProject[pid] = byProject[pid] || { project_id: pid, retained: 0, released: 0 };
      byProject[pid].retained = round2(byProject[pid].retained + num(b.retentionAmount));
    });
    (Array.isArray(releases) ? releases : []).forEach(function (r) {
      if (!r) return;
      var pid = r.project_id || '—';
      byProject[pid] = byProject[pid] || { project_id: pid, retained: 0, released: 0 };
      byProject[pid].released = round2(byProject[pid].released + num(r.amount_aed));
    });
    var breakdown = Object.keys(byProject).map(function (k) {
      var p = byProject[k];
      return { project_id: p.project_id, retained: p.retained, released: p.released, open: round2(p.retained - p.released) };
    });
    return { totalRetained: retained, released: released, open: round2(retained - released), breakdown: breakdown };
  }
  function overdueApprovals(items, slaDays, todayValue) {
    var sla = (slaDays === undefined || slaDays === null || slaDays === '') ? 3 : num(slaDays);
    var list = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      var age = daysSince(it && it.createdAt, todayValue);
      if (age === null || age === undefined) return;
      if (age > sla) {
        list.push({ type: it.type || it.cat || 'Item', label: it.label || '', project: it.project || '—', ageDays: age, amount: num(it.amount) });
      }
    });
    var value = round2(list.reduce(function (s, r) { return s + r.amount; }, 0));
    return { count: list.length, value: value, rows: list };
  }

  /* ------------------------------------------------------------------ */
  /* Pending-items source (prefer the selftest bridge, else reconstruct) */
  /* ------------------------------------------------------------------ */
  function collectFromState() {
    var st = state();
    var items = [];
    function push(it) { if (it) items.push(it); }
    (st.boq || []).forEach(function (i) {
      if ((i.status || 'approved') === 'pending') push({ type: 'BOQ', cat: 'BOQ', id: i.id, table: 'boq_items', label: ((i.code || '') + ' ' + (i.desc || '')).trim().slice(0, 80), amount: num(i.qty) * num(i.rate), project: st.currentProject ? st.currentProject.code : '—', createdAt: i.created_at || null });
    });
    (st.timesheets || []).forEach(function (x) {
      if (x.status === 'pending') push({ type: 'Labor', cat: 'Labor', id: x.id, table: 'timesheets', label: (x.name || '') + ' · ' + (x.date || ''), amount: num(x.cost), project: st.currentProject ? st.currentProject.code : '—', createdAt: x.created_at || x.date || null });
    });
    (st.expenses || []).forEach(function (e) {
      if ((e.status || 'approved') === 'pending') push({ type: 'Expense', cat: 'Expenses', id: e.id, table: 'company_expenses', label: e.description || e.category || 'Expense', amount: num(e.amount), project: 'Company', createdAt: e.created_at || e.expense_date || null });
    });
    (st.materials || []).forEach(function (m) {
      if ((m.status || 'approved') === 'pending') push({ type: 'PO', cat: 'POs', id: m.id, table: 'materials', label: (m.po || '') + ' · ' + (m.desc || '').slice(0, 40), amount: num(m.qty) * num(m.unitCost), project: st.currentProject ? st.currentProject.code : '—', createdAt: m.created_at || m.date || null });
    });
    (st.changeOrders || []).forEach(function (co) {
      if (co.status === 'pending') push({ type: 'CO', cat: 'Change Orders', id: co.id, table: 'change_orders', label: (co.coNumber || '') + ' · ' + (co.desc || '').slice(0, 40), amount: num(co.amount), project: st.currentProject ? st.currentProject.code : '—', createdAt: co.created_at || null });
    });
    var gp = st.globalPending || {};
    (gp.boq || []).forEach(function (x) {
      push({ type: 'BOQ', cat: 'BOQ', id: x.id, table: 'boq_items', label: ((x.code || '') + ' ' + (x.description || '')).trim().slice(0, 80), amount: num(x.quantity) * num(x.rate), project: x._projCode || '—', createdAt: x.created_at || null });
    });
    (gp.ts || []).forEach(function (x) {
      push({ type: 'Labor', cat: 'Labor', id: x.id, table: 'timesheets', label: (x.employee_name || '') + ' · ' + (x.work_date || ''), amount: num(x.total_cost_aed), project: x._projCode || '—', createdAt: x.created_at || null });
    });
    (gp.mat || []).forEach(function (x) {
      push({ type: 'PO', cat: 'POs', id: x.id, table: 'materials', label: (x.po_number || '') + ' · ' + (x.description || '').slice(0, 40), amount: num(x.quantity) * num(x.unit_cost_aed), project: x._projCode || '—', createdAt: x.created_at || null });
    });
    (gp.co || []).forEach(function (x) {
      push({ type: 'CO', cat: 'Change Orders', id: x.id, table: 'change_orders', label: (x.co_number || '') + ' · ' + (x.description || '').slice(0, 40), amount: num(x.amount), project: x._projCode || '—', createdAt: x.created_at || null });
    });
    (gp.exp || []).forEach(function (x) {
      push({ type: 'Expense', cat: 'Expenses', id: x.id, table: 'company_expenses', label: x.description || x.category || 'Expense', amount: num(x.amount), project: 'Company', createdAt: x.created_at || null });
    });
    return items;
  }
  function pendingItems() {
    if (typeof window !== 'undefined' && window.__sf && typeof window.__sf.collectPendingItems === 'function') {
      try { var r = window.__sf.collectPendingItems('all'); if (Array.isArray(r)) return r; } catch (e) { /* fall through */ }
    }
    return collectFromState();
  }
  function slaDays() {
    if (S.sla && typeof S.sla.days === 'function') {
      try { var d = S.sla.days(); if (isFinite(d)) return d; } catch (e) { /* fall through */ }
    }
    return 3;
  }

  /* ------------------------------------------------------------------ */
  /* Data loading (cross-project, no filter)                             */
  /* ------------------------------------------------------------------ */
  function isMissingTable(err) {
    var msg = String((err && err.message) || err || '').toLowerCase();
    return msg.indexOf('does not exist') >= 0 || msg.indexOf('schema cache') >= 0 ||
      msg.indexOf('could not find the table') >= 0 || msg.indexOf('42p01') >= 0 ||
      msg.indexOf('relation "') >= 0 || msg.indexOf('not found') >= 0;
  }
  function loadTable(name) {
    try {
      return Promise.resolve(DB.selectStrict(name, null, null, false)).then(function (r) {
        return r || { rows: [], error: new Error('No response') };
      }).catch(function (e) { return { rows: [], error: e }; });
    } catch (e) {
      return Promise.resolve({ rows: [], error: e });
    }
  }
  function loadData() {
    var specs = CORE_TABLES.concat(OPTIONAL_TABLES);
    return Promise.all(specs.map(loadTable)).then(function (results) {
      var byTable = {};
      specs.forEach(function (name, i) { byTable[name] = results[i] || { rows: [], error: null }; });
      var coreError = null;
      CORE_TABLES.forEach(function (name) {
        if (!coreError && byTable[name] && byTable[name].error) coreError = byTable[name].error;
      });
      var releasesError = byTable.retention_releases && byTable.retention_releases.error;
      var releasesMissing = releasesError ? isMissingTable(releasesError) : false;
      var data = {
        materials: (byTable.materials && !byTable.materials.error ? byTable.materials.rows : []).map(mapMaterial),
        payments: (byTable.payments && !byTable.payments.error ? byTable.payments.rows : []).map(mapPayment),
        billings: (byTable.progress_billings && !byTable.progress_billings.error ? byTable.progress_billings.rows : []).map(mapBilling),
        releases: (byTable.retention_releases && !byTable.retention_releases.error ? byTable.retention_releases.rows : [])
      };
      return { data: data, coreError: coreError, releasesMissing: releasesMissing, releasesError: releasesError };
    });
  }

  /* ------------------------------------------------------------------ */
  /* Module state                                                        */
  /* ------------------------------------------------------------------ */
  var MOD = {
    data: null,
    coreError: null,
    releasesMissing: false,
    releasesError: null,
    loaded: false,
    stale: true,
    token: 0,
    el: null
  };

  function metrics() {
    var d = MOD.data || { materials: [], payments: [], billings: [], releases: [] };
    return {
      overdue: overdueApprovals(pendingItems(), slaDays()),
      unlinked: unlinkedMaterialCost(d.materials),
      dupInvoice: duplicateSupplierInvoices(d.payments),
      committed: committedUndeliveredPos(d.materials),
      retention: openRetentionTotal(d.billings, d.releases)
    };
  }
  function refresh() {
    MOD.stale = true;
    if (MOD.el) startRender(MOD.el);
    return Promise.resolve();
  }

  /* Expose the API before view registration. */
  window.SF_modules = window.SF_modules || {};
  window.SF_modules[MODULE_ID] = {
    unlinkedMaterialCost: unlinkedMaterialCost,
    duplicateSupplierInvoices: duplicateSupplierInvoices,
    committedUndeliveredPos: committedUndeliveredPos,
    openRetentionTotal: openRetentionTotal,
    overdueApprovals: overdueApprovals,
    pendingItems: pendingItems,
    metrics: metrics,
    refresh: refresh,
    version: 1
  };

  /* ------------------------------------------------------------------ */
  /* Presentation helpers                                                */
  /* ------------------------------------------------------------------ */
  function kpi(cls, label, value, sub) {
    return '<div class="kpi ' + cls + '"><div class="lbl">' + esc(label) + '</div>' +
      '<div class="val">' + esc(value) + '</div>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function tableHTML(headers, rowsHtml, emptyText) {
    return '<div style="overflow-x:auto"><table><thead><tr>' +
      headers.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + esc(h.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="' + headers.length + '" class="empty">' + esc(emptyText || pick('noData')) + '</td></tr>') +
      '</tbody></table></div>';
  }

  function overdueCard(m) {
    var headers = [
      { label: pick('colType') }, { label: pick('colItem') }, { label: pick('colProject') },
      { label: pick('colAge'), cls: 'tright' }, { label: pick('colAmount'), cls: 'tright' }
    ];
    var rows = (m.rows || []).map(function (r) {
      return '<tr><td><span class="tag warn">' + esc(r.type) + '</span></td>' +
        '<td>' + esc(r.label) + '</td>' +
        '<td class="mutc">' + esc(r.project) + '</td>' +
        '<td class="tright mono badc">' + r.ageDays + ' ' + esc(pick('days')) + '</td>' +
        '<td class="tright mono">' + esc(money(r.amount)) + '</td></tr>';
    });
    return '<div class="card"><h3>⏰ ' + esc(pick('overdueTitle')) + '</h3>' +
      tableHTML(headers, rows, pick('noData')) + '</div>';
  }
  function unlinkedCard(m) {
    var headers = [
      { label: pick('colSupplier') }, { label: pick('colPo'), cls: 'tright' },
      { label: pick('colDesc') }, { label: pick('colCost'), cls: 'tright' }
    ];
    var rows = (m.rows || []).map(function (r) {
      return '<tr><td><b>' + esc(r.supplier || '—') + '</b></td>' +
        '<td class="mono">' + esc(r.po || '—') + '</td>' +
        '<td>' + esc(r.desc || '—') + '</td>' +
        '<td class="tright mono">' + esc(money(num(r.qty) * num(r.unitCost))) + '</td></tr>';
    });
    return '<div class="card"><h3>🔗 ' + esc(pick('unlinkedTitle')) + '</h3>' +
      tableHTML(headers, rows, pick('noData')) + '</div>';
  }
  function dupCard(m) {
    var headers = [
      { label: pick('colInvoice') }, { label: pick('colCount'), cls: 'tright' },
      { label: pick('colAmount'), cls: 'tright' }
    ];
    var rows = (m.rows || []).map(function (r) {
      return '<tr><td class="mono" style="color:var(--bad)">' + esc(r.invoiceNo) + '</td>' +
        '<td class="tright mono">' + r.count + '</td>' +
        '<td class="tright mono">' + esc(money(r.value)) + '</td></tr>';
    });
    return '<div class="card"><h3>🧾 ' + esc(pick('dupTitle')) + '</h3>' +
      tableHTML(headers, rows, pick('noData')) + '</div>';
  }
  function committedCard(m) {
    var headers = [
      { label: pick('colPo') }, { label: pick('colSupplier') }, { label: pick('colStage') },
      { label: pick('colQty'), cls: 'tright' }, { label: pick('colCost'), cls: 'tright' }
    ];
    var rows = (m.rows || []).map(function (r) {
      return '<tr><td class="mono">' + esc(r.po || '—') + '</td>' +
        '<td><b>' + esc(r.supplier || '—') + '</b></td>' +
        '<td><span class="tag info">' + esc(r.stage || '—') + '</span></td>' +
        '<td class="tright mono">' + esc(num(r.qty)) + ' ' + esc(r.unit || '') + '</td>' +
        '<td class="tright mono">' + esc(money(num(r.qty) * num(r.unitCost))) + '</td></tr>';
    });
    return '<div class="card"><h3>🚚 ' + esc(pick('committedTitle')) + '</h3>' +
      tableHTML(headers, rows, pick('noData')) + '</div>';
  }
  function retentionCard(m) {
    var headers = [
      { label: pick('colProject') }, { label: pick('colRetained'), cls: 'tright' },
      { label: pick('colReleased'), cls: 'tright' }, { label: pick('colOpen'), cls: 'tright' }
    ];
    var rows = (m.breakdown || []).map(function (r) {
      return '<tr><td><b>' + esc(projectNameOf(r.project_id)) + '</b></td>' +
        '<td class="tright mono">' + esc(money(r.retained)) + '</td>' +
        '<td class="tright mono">' + esc(money(r.released)) + '</td>' +
        '<td class="tright mono"><b>' + esc(money(r.open)) + '</b></td></tr>';
    });
    return '<div class="card"><h3>💠 ' + esc(pick('retentionTitle')) + '</h3>' +
      tableHTML(headers, rows, pick('noData')) + '</div>';
  }
  function migrationNote() {
    if (!MOD.releasesMissing) return '';
    var msg = (MOD.releasesError && MOD.releasesError.message) || '';
    return '<div class="card" style="border-color:rgba(210,153,34,.45);margin-bottom:14px">' +
      '<h3>⚠ ' + esc(pick('migrationTitle')) + '</h3>' +
      '<p class="warnc" style="margin-bottom:8px">' + esc(pick('migrationBody')) + '</p>' +
      '<p class="mutc" style="margin-bottom:8px">' + esc(pick('migrationRun')) +
      ' <code style="direction:ltr;unicode-bidi:embed">' + esc(MIGRATION) + '</code> ' +
      esc(pick('migrationRunAfter')) + '</p>' +
      (msg ? '<p class="mutc mono" style="font-size:11px;white-space:pre-wrap;direction:ltr;unicode-bidi:embed">' + esc(msg) + '</p>' : '') +
      '</div>';
  }
  function kpisHtml(m) {
    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px">' +
      kpi(m.overdue.count ? 'r' : 'g', pick('kpiOverdue'), String(m.overdue.count), money0(m.overdue.value) + ' ' + esc(pick('exposure'))) +
      kpi(m.unlinked.count ? 'y' : 'g', pick('kpiUnlinked'), money0(m.unlinked.value), m.unlinked.count + ' ' + esc(pick('materials'))) +
      kpi(m.dupInvoice.count ? 'r' : 'g', pick('kpiDupInvoice'), String(m.dupInvoice.count), money0(m.dupInvoice.value)) +
      kpi(m.committed.count ? 'y' : 'g', pick('kpiCommitted'), money0(m.committed.value), m.committed.count + ' ' + esc(pick('pos'))) +
      kpi('b', pick('kpiRetention'), money0(m.retention.open), esc(pick('retainedSub')) + ' ' + money0(m.retention.totalRetained) + ' · ' + esc(pick('releasedSub')) + ' ' + money0(m.retention.released)) +
      '</div>';
  }
  function buildView() {
    var m = metrics();
    var head = '<h2 class="vt">📊 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>';
    var body = migrationNote() + kpisHtml(m) +
      overdueCard(m.overdue) + unlinkedCard(m.unlinked) + dupCard(m.dupInvoice) +
      committedCard(m.committed) + retentionCard(m.retention);
    return '<div data-sf-mgmt="list">' + head + body + '</div>';
  }
  function loadingHTML() {
    return '<div data-sf-mgmt="loading"><h2 class="vt">📊 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>' +
      '<div class="card"><div class="empty"><div class="big">📊</div>' + esc(pick('loading')) + '</div></div></div>';
  }
  function errorHTML(e) {
    var msg = (e && e.message) || String(e) || 'Unexpected error';
    return '<div data-sf-mgmt="error"><h2 class="vt">📊 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><h3>⚠ ' + esc(pick('failed')) + '</h3>' +
      '<p class="badc">' + esc(msg) + '</p>' +
      '<button type="button" class="btn ghost sm" data-sf-action="retry" style="margin-top:10px">' + esc(pick('retry')) + '</button></div></div>';
  }
  function bind(el) {
    Array.prototype.forEach.call(el.querySelectorAll('[data-sf-action]'), function (node) {
      node.addEventListener('click', function () {
        try { MOD.stale = true; startRender(MOD.el); } catch (e) { if (UI && UI.toast) UI.toast(pick('failed'), 'bad'); }
      });
    });
  }
  function paint(el) {
    if (!el || !el.querySelector) return;
    if (!el.querySelector('[data-sf-mgmt]')) return;
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
    el.innerHTML = loadingHTML();
    var token = ++MOD.token;
    loadData().then(function (res) {
      if (token !== MOD.token) return;
      MOD.data = res.data;
      MOD.coreError = res.coreError;
      MOD.releasesMissing = res.releasesMissing;
      MOD.releasesError = res.releasesError;
      MOD.loaded = true;
      MOD.stale = false;
      if (MOD.coreError) {
        try { el.innerHTML = errorHTML(MOD.coreError); bind(el); } catch (e) {}
        return;
      }
      paint(el);
    }).catch(function (e) {
      if (token !== MOD.token) return;
      MOD.coreError = e;
      MOD.loaded = true;
      MOD.stale = false;
      try { el.innerHTML = errorHTML(e); bind(el); } catch (e2) {}
    });
  }

  /* ------------------------------------------------------------------ */
  /* View registration                                                   */
  /* ------------------------------------------------------------------ */
  S.registerView({
    id: MODULE_ID,
    nav: { section: 'company', icon: '📊', label: 'Management Exceptions', labelAr: 'مؤشرات الإدارة' },
    roles: ['director', 'controller'],
    render: function (el) {
      try {
        MOD.el = el;
        if (MOD.loaded && !MOD.stale) {
          el.innerHTML = '<div data-sf-mgmt="list"></div>';
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
