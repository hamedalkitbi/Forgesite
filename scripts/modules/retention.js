/* ============================================================================
 * SiteForge module: Retention (project-level retention releases)
 * ----------------------------------------------------------------------------
 * Retention is withheld from each certified/paid progress billing. This view
 * shows the per-project position — total retained, released to date and the
 * open (unreleased) balance — and lets a Project Director record a retention
 * release (partial or full) with a mandatory reason. Controllers can view the
 * position and history but only a Director may release.
 *
 * Owned by: modules3. Contract: docs/modules/CONTRACT.md.
 * Table + RLS: supabase/migrations/202611050003_phase3.sql
 *   (public.retention_releases + public.subcontractor_certificates + RPC).
 * Docs: docs/modules/retention.md. Checks: tools/checks/retention.mjs.
 *
 * The module never edits scripts/app.js. It only uses the window.SF bridge and
 * registers the "retention" view. A small pure/defensive API is exposed on
 * window.SF_modules.retention = { open, released, release, list, totalRetained }.
 *
 * Math (mirrors the migration RPC sf_retention_open):
 *   total_retained = Σ progress_billings.retention_amount for status certified|paid
 *   released       = Σ retention_releases.amount_aed for the project
 *   open           = total_retained − released
 * ========================================================================== */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db;
  var UI = S.ui;

  var MODULE_ID = 'retention';
  var TABLE = 'retention_releases';
  var MIGRATION = 'supabase/migrations/202611050003_phase3.sql';

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

  /* ------------------------------------------------------------------ */
  /* i18n (EN + AR; real Arabic, never machine transliteration)          */
  /* ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Retention',
      subtitle: 'Retention withheld vs. released, per project',
      kpiRetained: 'Total retained',
      kpiReleased: 'Released to date',
      kpiOpen: 'Open (unreleased)',
      releaseBtn: '+ Record release',
      loading: 'Loading retention position…',
      empty: 'No retention releases recorded yet.',
      emptyHint: 'Record a release when the client returns withheld retention.',
      migrationTitle: 'Database update required',
      migrationBody: 'Retention needs the retention_releases table before it can list or record releases.',
      migrationRun: 'Run',
      migrationRunAfter: 'in the Supabase SQL editor, then reload this page.',
      retry: 'Retry',
      historyTitle: 'Release history',
      colDate: 'Date',
      colAmount: 'Amount',
      colBy: 'Released by',
      colReason: 'Reason',
      fAmount: 'Amount (AED)',
      fReason: 'Reason',
      reasonPh: 'Why is this retention being released? e.g. DLP certificate issued…',
      releaseTitle: 'Record retention release',
      amountPositive: 'Amount must be greater than zero.',
      reasonRequired: 'A reason is required.',
      overOpen: 'Release cannot exceed the open retention of',
      directorOnly: 'Only a Project Director may record a retention release.',
      bridgeNotReady: 'SiteForge bridge is not ready.',
      savedOk: 'Release recorded ✓',
      failed: 'Failed',
      noProject: 'Select a project to see its retention position.',
      close: 'Close',
      perProject: 'certificates',
      retainedHint: 'certified + paid billings'
    },
    ar: {
      title: 'الاستحقاقات',
      subtitle: 'الاستحقاق المحتجز مقابل المُحرَّر، لكل مشروع',
      kpiRetained: 'إجمالي المحتجز',
      kpiReleased: 'المُحرَّر حتى تاريخه',
      kpiOpen: 'المفتوح (غير المُحرَّر)',
      releaseBtn: '+ تسجيل إفراج',
      loading: 'جارٍ تحميل مركز الاستحقاق…',
      empty: 'لم تُسجَّل أي عمليات إفراج استحقاق بعد.',
      emptyHint: 'سجّل عملية إفراج عندما يعيد العميل الاستحقاق المحتجز.',
      migrationTitle: 'يلزم تحديث قاعدة البيانات',
      migrationBody: 'يتطلب قسم الاستحقاقات جدول retention_releases قبل أن يتمكن من عرض أو تسجيل الإفراجات.',
      migrationRun: 'شغّل',
      migrationRunAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      retry: 'إعادة المحاولة',
      historyTitle: 'سجل الإفراجات',
      colDate: 'التاريخ',
      colAmount: 'المبلغ',
      colBy: 'أفرج عنه',
      colReason: 'السبب',
      fAmount: 'المبلغ (درهم)',
      fReason: 'السبب',
      reasonPh: 'لماذا يُفرَج عن هذا الاستحقاق؟ مثال: صدرت شهادة فترة الضمان…',
      releaseTitle: 'تسجيل إفراج استحقاق',
      amountPositive: 'يجب أن يكون المبلغ أكبر من صفر.',
      reasonRequired: 'السبب مطلوب.',
      overOpen: 'لا يمكن أن يتجاوز الإفراج الاستحقاق المفتوح البالغ',
      directorOnly: 'لا يجوز تسجيل إفراج الاستحقاق إلا لمدير المشروع.',
      bridgeNotReady: 'جسر SiteForge غير جاهز.',
      savedOk: 'تم تسجيل الإفراج ✓',
      failed: 'فشل',
      noProject: 'اختر مشروعاً لعرض مركز الاستحقاق الخاص به.',
      close: 'إغلاق',
      perProject: 'شهادات',
      retainedHint: 'فواتير معتمدة ومدفوعة'
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
  function billings() {
    try { return (S.data && S.data.state && S.data.state.billings) || []; } catch (e) { return []; }
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
  /* Retention math                                                      */
  /* ------------------------------------------------------------------ */
  function totalRetained() {
    return round2(billings().filter(function (b) {
      return b && (b.status === 'certified' || b.status === 'paid');
    }).reduce(function (s, b) { return s + num(b.retentionAmount); }, 0));
  }
  function releasedTotal() {
    return round2((MOD.rows || []).reduce(function (s, r) { return s + num(r && r.amount_aed); }, 0));
  }
  function openAmount() {
    return round2(totalRetained() - releasedTotal());
  }

  /* ------------------------------------------------------------------ */
  /* Data loading                                                        */
  /* ------------------------------------------------------------------ */
  function fetchReleases(pid) {
    if (!DB || typeof DB.selectStrict !== 'function') {
      return Promise.resolve({ rows: [], error: new Error(pick('bridgeNotReady')) });
    }
    return Promise.resolve()
      .then(function () { return DB.selectStrict(TABLE, { project_id: pid }, 'release_date', false); })
      .then(function (r) { return { rows: (r && r.rows) || [], error: (r && r.error) || null }; })
      .catch(function (e) { return { rows: [], error: e }; });
  }

  /* ------------------------------------------------------------------ */
  /* Pure / defensive public API (never throws synchronously)            */
  /* ------------------------------------------------------------------ */
  function list() {
    return (MOD.rows || []).slice();
  }
  function open() {
    return openAmount();
  }
  function released() {
    return releasedTotal();
  }
  /* release(amount, reason) → Promise<{ ok, row | error }>
     Validates 0 < amount <= open and requires a non-empty reason. Director only.
     Re-fetches releases first so the open check is against the latest rows. */
  function release(amount, reason) {
    var pid = projectId();
    return Promise.resolve().then(function () {
      if (!isDirector()) return { ok: false, error: new Error(pick('directorOnly')) };
      if (!pid) return { ok: false, error: new Error(pick('noProject')) };
      var amt = round2(amount);
      var rs = String(reason === null || reason === undefined ? '' : reason).trim();
      if (!(amt > 0)) return { ok: false, error: new Error(pick('amountPositive')) };
      if (!rs) return { ok: false, error: new Error(pick('reasonRequired')) };
      if (!DB || typeof DB.selectStrict !== 'function') return { ok: false, error: new Error(pick('bridgeNotReady')) };
      return fetchReleases(pid).then(function (res) {
        if (res.error) return { ok: false, error: res.error };
        var rel = round2((res.rows || []).reduce(function (s, r) { return s + num(r && r.amount_aed); }, 0));
        var openAmt = round2(totalRetained() - rel);
        if (amt > openAmt) {
          return { ok: false, error: new Error(pick('overOpen') + ' ' + money(openAmt)) };
        }
        var payload = {
          project_id: pid,
          amount_aed: amt,
          release_date: todayStr(),
          released_by: userName() || null,
          reason: rs
        };
        return Promise.resolve(DB.insert(TABLE, payload)).then(function (row) {
          if (row) MOD.rows = (MOD.rows || []).concat([row]);
          MOD.stale = true;
          if (MOD.el) startRender(MOD.el);
          return { ok: true, row: row };
        }).catch(function (e) { return { ok: false, error: e }; });
      });
    }).catch(function (e) { return { ok: false, error: e }; });
  }

  /* Expose the API before view registration so consumers (and the Node
   * checks) can reach it as soon as the module loads. */
  window.SF_modules = window.SF_modules || {};
  window.SF_modules[MODULE_ID] = {
    open: open,
    released: released,
    release: release,
    list: list,
    totalRetained: totalRetained,
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
      (rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="' + headers.length + '" class="empty">' + esc(emptyText || pick('empty')) + '</td></tr>') +
      '</tbody></table></div>';
  }
  function releaseRowsHtml() {
    return (MOD.rows || []).slice().sort(function (a, b) {
      var av = a && a.release_date ? String(a.release_date) : '';
      var bv = b && b.release_date ? String(b.release_date) : '';
      return av < bv ? 1 : (av > bv ? -1 : 0);
    }).map(function (r) {
      return '<tr>' +
        '<td class="mono">' + esc(fmtDate(r && r.release_date)) + '</td>' +
        '<td class="tright mono"><b>' + esc(money(r && r.amount_aed)) + '</b></td>' +
        '<td>' + esc((r && r.released_by) || '—') + '</td>' +
        '<td>' + esc((r && r.reason) || '—') + '</td>' +
        '</tr>';
    });
  }
  function kpisHtml() {
    var retained = totalRetained();
    var rel = releasedTotal();
    var opn = openAmount();
    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px">' +
      kpi('b', pick('kpiRetained'), money0(retained), pick('retainedHint')) +
      kpi('g', pick('kpiReleased'), money0(rel), '') +
      kpi('y', pick('kpiOpen'), money0(opn), '') +
      '</div>';
  }
  function historyCard() {
    var headers = [
      { label: pick('colDate') }, { label: pick('colAmount'), cls: 'tright' },
      { label: pick('colBy') }, { label: pick('colReason') }
    ];
    return '<div class="card"><h3>💠 ' + esc(pick('historyTitle')) + '</h3>' +
      tableHTML(headers, releaseRowsHtml(), pick('empty')) + '</div>';
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
    var head = '<h2 class="vt">💠 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) +
      (projText ? ' · ' + esc(projText) : '') +
      '<span class="spacer"></span>' +
      (isDirector()
        ? '<button type="button" class="btn" data-sf-action="release">➕ ' + esc(pick('releaseBtn')) + '</button>'
        : '') + '</div>';
    var body = MOD.error ? migrationCard(MOD.error) : (kpisHtml() + historyCard());
    return '<div data-sf-retention="list">' + head + body + '</div>';
  }
  function loadingHTML() {
    return '<div data-sf-retention="loading"><h2 class="vt">💠 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>' +
      '<div class="card"><div class="empty"><div class="big">💠</div>' + esc(pick('loading')) + '</div></div></div>';
  }
  function noProjectHTML() {
    return '<div data-sf-retention="noproject"><h2 class="vt">💠 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><div class="empty"><div class="big">🏗</div>' + esc(pick('noProject')) + '</div></div></div>';
  }
  function errorHTML(e) {
    var msg = (e && e.message) || String(e) || 'Unexpected error';
    return '<div data-sf-retention="error"><h2 class="vt">💠 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><h3>⚠ ' + esc(pick('failed')) + '</h3>' +
      '<p class="badc">' + esc(msg) + '</p></div></div>';
  }

  /* ------------------------------------------------------------------ */
  /* Rendering + events                                                  */
  /* ------------------------------------------------------------------ */
  function openReleaseForm() {
    if (!UI || !UI.openFormModal) { if (UI && UI.toast) UI.toast(pick('failed'), 'bad'); return; }
    var opn = openAmount();
    UI.openFormModal({
      title: '💠 ' + esc(pick('releaseTitle')),
      wide: false,
      values: { amount: opn > 0 ? opn : '', reason: '' },
      fields: [
        { key: 'amount', label: pick('fAmount'), type: 'number', step: '0.01', required: true },
        { key: 'reason', label: pick('fReason'), type: 'textarea', rows: 2, placeholder: pick('reasonPh'), required: true, full: true }
      ],
      onSubmit: function (values) {
        return release(values.amount, values.reason).then(function (res) {
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
      if (action === 'release') openReleaseForm();
      else if (action === 'retry') { MOD.stale = true; startRender(MOD.el); }
    });
  }
  function paint(el) {
    if (!el || !el.querySelector) return;
    if (!el.querySelector('[data-sf-retention]')) return;
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
    fetchReleases(pid).then(function (res) {
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
    nav: { section: 'project', icon: '💠', label: 'Retention', labelAr: 'الاستحقاقات' },
    roles: ['director', 'controller'],
    render: function (el) {
      try {
        MOD.el = el;
        if (MOD.loaded && !MOD.stale) {
          el.innerHTML = '<div data-sf-retention="list"></div>';
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
