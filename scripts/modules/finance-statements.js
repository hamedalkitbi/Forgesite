/* SiteForge module: Financial Accounts — Receivables (AR), Payables (AP),
 * derived Balance Sheet and P&L / project profitability.
 *
 * Company-scoped: the module aggregates EVERY project (no project filter), so it
 * works from the company dashboard as well as while a project is selected.
 * Contract: docs/modules/CONTRACT.md — owner: finance teammate.
 *
 * Everything except opening balances is DERIVED from operational tables:
 *   progress_billings, payments, materials, timesheets, company_expenses,
 *   company_budget_lines, project_parties, projects, and payment_requests when
 *   that module's table exists. finance_settings is optional (defaults to 0).
 *
 * The pure statement maths are exported on window.SF_modules.finance so the
 * Node checks can call them with fixture rows (see tools/checks/finance.mjs):
 *   {ageing, arTotal, apTotal, balanceSheet, pnl, ...}
 */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db;
  var UI = S.ui;

  var DAY = 86400000;
  var BUCKET_KEYS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

  /* ---------------------------------------------------------------- numbers */
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function round2(v) {
    var n = num(v);
    return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function sum(list, fn) {
    var s = 0;
    for (var i = 0; i < list.length; i++) s += num(fn ? fn(list[i]) : list[i]);
    return s;
  }

  /* ------------------------------------------------------------------ dates */
  /* Calendar day index (UTC) for a date/ISO string. Date-only strings are exact;
   * timestamp strings use the calendar date written in the ISO string. Whole-day
   * differences are therefore stable across time zones and DST. */
  function dayIndex(v) {
    if (v === null || v === undefined || v === '') return null;
    var ms;
    if (typeof v === 'number') ms = v;
    else if (v instanceof Date) ms = v.getTime();
    else {
      var s = String(v).trim();
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      else { var d = new Date(s); if (isNaN(d.getTime())) return null; ms = d.getTime(); }
    }
    if (!isFinite(ms)) return null;
    return Math.floor(ms / DAY);
  }
  function isoToday() { return new Date().toISOString().slice(0, 10); }
  function todayStr() { return (H.today && H.today()) || isoToday(); }
  function fmtDate(v) {
    if (H.fmtDate) return H.fmtDate(v);
    var di = dayIndex(v);
    if (di === null) return '—';
    return new Date(di * DAY).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
  }

  /* -------------------------------------------------------------- money text */
  function localMoney(n, dp) {
    var v = num(n);
    var body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return (v < 0 ? '-AED ' : 'AED ') + body;
  }
  function money(n) { return H.money ? H.money(round2(n)) : localMoney(round2(n), 2); }
  function money0(n) { return H.money0 ? H.money0(round2(n)) : localMoney(round2(n), 0); }
  function pctText(v) { return num(v).toFixed(2) + '%'; }
  function esc(v) {
    if (H.esc) return H.esc(v);
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeImg(src) { return H.safeImgSrc ? H.safeImgSrc(src) : ''; }

  /* -------------------------------------------------------------------- i18n */
  var L = {
    en: {
      title: 'Financial Accounts',
      subtitle: 'Company-wide receivables, payables, balance sheet and profitability',
      loading: 'Loading statements…',
      asOf: 'As of',
      refresh: 'Refresh',
      exportCsv: 'Export CSV',
      print: 'Print / PDF',
      printAll: 'Print full pack',
      tab_ar: 'Receivables',
      tab_ap: 'Payables',
      tab_bs: 'Balance Sheet',
      tab_pnl: 'Profit & Loss',
      receivables: 'Accounts Receivable',
      payables: 'Accounts Payable',
      balanceSheet: 'Balance Sheet',
      profitLoss: 'Profit & Loss',
      totalReceivables: 'Total receivables',
      certifiedNet: 'Certified net payable',
      receivedToDate: 'Received to date',
      outstandingInvoices: 'Certified (open) certificates',
      settlementRecon: 'Settlement reconciliation',
      paidSettled: 'Paid certificates settled by status',
      receiptsAppliedToPaid: 'Receipts applied to paid certificates',
      receiptsAppliedToCertified: 'Receipts applied to certified invoices',
      advanceReceipts: 'Unapplied receipts (client advances)',
      arRule: 'Paid certificates are settled by status; recorded receipts are applied to paid certificates first, then to open certified invoices oldest-first.',
      overdue: 'Overdue',
      totalPayables: 'Total payables',
      approvedRequests: 'Approved payment requests',
      materialPayables: 'Material payables',
      pendingInvoices: 'Pending supplier invoices',
      cashPosition: 'Cash position',
      ageing: 'Ageing',
      bucket: 'Bucket',
      invoices: 'Items',
      amount: 'Amount',
      pctOfTotal: 'Share',
      total: 'Total',
      current: 'Current (not yet due)',
      days1_30: '1–30 days',
      days31_60: '31–60 days',
      days61_90: '61–90 days',
      days90plus: '90+ days',
      billingNo: 'IPC / Invoice #',
      project: 'Project',
      status: 'Status',
      dueDate: 'Due date',
      daysPastDue: 'Days past due',
      netPayable: 'Net payable',
      applied: 'Received applied',
      outstanding: 'Outstanding',
      customerReceivables: 'Receivable invoices',
      payableType: 'Type',
      reference: 'Reference',
      party: 'Party',
      paymentRequest: 'Payment request',
      supplierInvoice: 'Supplier invoice',
      materials: 'Materials / POs',
      companyExpenses: 'Company expenses',
      assets: 'Assets',
      liabilities: 'Liabilities',
      equity: 'Equity',
      cashAndEquivalents: 'Cash and cash equivalents',
      accountsReceivable: 'Accounts receivable (AR)',
      accountsPayable: 'Accounts payable (AP)',
      retentionPayable: 'Retention payable',
      vatPayable: 'VAT payable',
      openingCash: 'Opening cash',
      openingEquity: 'Opening equity',
      currentPeriodResult: 'Current-period result (implied)',
      totalAssets: 'Total assets',
      totalLiabilities: 'Total liabilities',
      totalEquity: 'Total equity',
      balanced: 'Balanced ✓',
      imbalance: 'Imbalance',
      balanceIdentity: 'Assets − Liabilities − Equity',
      settings: 'Opening balances',
      fiscalYear: 'Fiscal year',
      notes: 'Notes',
      openingCashAed: 'Opening cash (AED)',
      openingEquityAed: 'Opening equity (AED)',
      editSettings: 'Edit opening balances',
      settingsNotInstalled: 'finance_settings is not installed — using AED 0 opening balances. Run supabase/migrations/202611031002_finance_statements.sql to persist them.',
      managerOnly: 'Only directors and controllers can edit opening balances.',
      savedOk: 'Saved ✓',
      failed: 'Failed',
      noData: 'No data',
      pnlRevenue: 'Revenue (certified, excl. VAT)',
      pnlMaterials: 'Materials',
      pnlLabour: 'Labour (approved timesheets)',
      directCost: 'Direct cost',
      grossProfit: 'Gross profit',
      grossMargin: 'Gross margin',
      overhead: 'Company overhead',
      netProfit: 'Net profit',
      netMargin: 'Net margin',
      vatExcludedNote: 'Revenue is certified claim value excluding VAT. VAT is tracked separately as VAT payable.',
      projectProfitability: 'Project profitability',
      budgetVsActual: 'Company overhead budget vs actual',
      budget: 'Budget',
      actual: 'Actual',
      variance: 'Variance',
      derivation: 'How these figures are derived',
      derivationNote: 'AR = open certified net payable − receipts not already consumed by paid certificates (a paid certificate is settled by status). AP = approved payment requests + approved materials (net of paid supplier invoices) + pending supplier invoices. Cash = opening cash + received − paid supplier invoices − company expenses − paid payment requests. Retention and VAT payable come from certified certificates. Equity is derived as Assets − Liabilities, so the sheet balances by construction.',
      popupBlocked: 'Allow pop-ups to print the statements.',
      cashMovement: 'Net cash movement',
      periodResult: 'This-period revenue (excl. VAT)',
      noPermission: 'Access denied',
      printTitle: 'Financial Statements',
      prepared: 'Prepared',
      retainedBy: 'Prepared by',
      approvedBy: 'Approved by'
    },
    ar: {
      title: 'الحسابات المالية',
      subtitle: 'المستحقات والالتزامات والميزانية العمومية والربحية على مستوى الشركة',
      loading: 'جارٍ تحميل القوائم…',
      asOf: 'كما في',
      refresh: 'تحديث',
      exportCsv: 'تصدير CSV',
      print: 'طباعة / PDF',
      printAll: 'طباعة الحزمة الكاملة',
      tab_ar: 'المستحقات',
      tab_ap: 'الالتزامات',
      tab_bs: 'الميزانية العمومية',
      tab_pnl: 'الأرباح والخسائر',
      receivables: 'الحسابات المدينة',
      payables: 'الحسابات الدائنة',
      balanceSheet: 'الميزانية العمومية',
      profitLoss: 'الأرباح والخسائر',
      totalReceivables: 'إجمالي المستحقات',
      certifiedNet: 'الصافي المعتمد المستحق',
      receivedToDate: 'المحصّل حتى تاريخه',
      outstandingInvoices: 'الفواتير المعتمدة (المفتوحة)',
      settlementRecon: 'تسوية التحصيل',
      paidSettled: 'مستخلصات مدفوعة مسوّاة بالحالة',
      receiptsAppliedToPaid: 'المحصّل المخصص للمستخلصات المدفوعة',
      receiptsAppliedToCertified: 'المحصّل المخصص للفواتير المعتمدة',
      advanceReceipts: 'مبالغ محصّلة غير مخصصة (دفعات مقدمة من العميل)',
      arRule: 'المستخلص المدفوع يُعد مسوّى بحالته؛ ويُخصص المحصّل أولاً للمستخلصات المدفوعة ثم للفواتير المعتمدة المفتوحة من الأقدم إلى الأحدث.',
      overdue: 'المتأخرة',
      totalPayables: 'إجمالي الالتزامات',
      approvedRequests: 'طلبات دفع معتمدة',
      materialPayables: 'التزامات المواد',
      pendingInvoices: 'فواتير موردين معلقة',
      cashPosition: 'المركز النقدي',
      ageing: 'أعمار الديون',
      bucket: 'الفئة',
      invoices: 'العدد',
      amount: 'المبلغ',
      pctOfTotal: 'النسبة',
      total: 'الإجمالي',
      current: 'جارٍ (غير مستحق)',
      days1_30: '1–30 يوم',
      days31_60: '31–60 يوم',
      days61_90: '61–90 يوم',
      days90plus: 'أكثر من 90 يوم',
      billingNo: 'رقم الفاتورة / المستخلص',
      project: 'المشروع',
      status: 'الحالة',
      dueDate: 'تاريخ الاستحقاق',
      daysPastDue: 'أيام التأخير',
      netPayable: 'الصافي المستحق',
      applied: 'المخصص من المحصّل',
      outstanding: 'المتبقي',
      customerReceivables: 'الفواتير المستحقة',
      payableType: 'النوع',
      reference: 'المرجع',
      party: 'الطرف',
      paymentRequest: 'طلب دفع',
      supplierInvoice: 'فاتورة مورد',
      materials: 'المواد / أوامر الشراء',
      companyExpenses: 'مصروفات الشركة',
      assets: 'الأصول',
      liabilities: 'الالتزامات',
      equity: 'حقوق الملكية',
      cashAndEquivalents: 'النقد وما يعادله',
      accountsReceivable: 'الحسابات المدينة',
      accountsPayable: 'الحسابات الدائنة',
      retentionPayable: 'المحتجز المستحق',
      vatPayable: 'ضريبة القيمة المضافة المستحقة',
      openingCash: 'النقد الافتتاحي',
      openingEquity: 'حقوق الملكية الافتتاحية',
      currentPeriodResult: 'نتيجة الفترة الحالية (المستنتجة)',
      totalAssets: 'إجمالي الأصول',
      totalLiabilities: 'إجمالي الالتزامات',
      totalEquity: 'إجمالي حقوق الملكية',
      balanced: 'متوازنة ✓',
      imbalance: 'غير متوازنة',
      balanceIdentity: 'الأصول − الالتزامات − حقوق الملكية',
      settings: 'الأرصدة الافتتاحية',
      fiscalYear: 'السنة المالية',
      notes: 'ملاحظات',
      openingCashAed: 'النقد الافتتاحي (درهم)',
      openingEquityAed: 'حقوق الملكية الافتتاحية (درهم)',
      editSettings: 'تعديل الأرصدة الافتتاحية',
      settingsNotInstalled: 'جدول finance_settings غير مثبت — يتم استخدام أرصدة افتتاحية صفر. نفّذ supabase/migrations/202611031002_finance_statements.sql لحفظها.',
      managerOnly: 'تعديل الأرصدة الافتتاحية متاح للمدير والمحاسب فقط.',
      savedOk: 'تم الحفظ ✓',
      failed: 'فشل',
      noData: 'لا توجد بيانات',
      pnlRevenue: 'الإيرادات (معتمدة، بدون ضريبة القيمة المضافة)',
      pnlMaterials: 'المواد',
      pnlLabour: 'العمالة (سجلات دوام معتمدة)',
      directCost: 'التكلفة المباشرة',
      grossProfit: 'الربح الإجمالي',
      grossMargin: 'هامش الربح الإجمالي',
      overhead: 'المصروفات العمومية للشركة',
      netProfit: 'الربح الصافي',
      netMargin: 'هامش الربح الصافي',
      vatExcludedNote: 'الإيرادات هي قيمة المستخلصات المعتمدة بدون ضريبة القيمة المضافة، وتُعرض الضريبة المستحقة بشكل منفصل.',
      projectProfitability: 'ربحية المشاريع',
      budgetVsActual: 'موازنة المصروفات العمومية مقابل الفعلي',
      budget: 'الموازنة',
      actual: 'الفعلي',
      variance: 'الفرق',
      derivation: 'كيفية احتساب هذه الأرقام',
      derivationNote: 'المستحقات = صافي المستخلصات المعتمدة المفتوحة − المبالغ المحصّلة غير المستخدمة في المستخلصات المدفوعة (المستخلص المدفوع مسوّى بحالته). الالتزامات = طلبات الدفع المعتمدة + المواد المعتمدة (بعد خصم فواتير الموردين المدفوعة) + فواتير الموردين المعلقة. النقد = النقد الافتتاحي + المحصّل − فواتير الموردين المدفوعة − مصروفات الشركة − طلبات الدفع المدفوعة. المحتجز والضريبة المستحقة من المستخلصات المعتمدة. حقوق الملكية = الأصول − الالتزامات، لذا تتوازن الميزانية بطريقة البناء.',
      popupBlocked: 'اسمح بالنوافذ المنبثقة لطباعة القوائم.',
      cashMovement: 'صافي الحركة النقدية',
      periodResult: 'إيرادات الفترة الحالية (بدون ضريبة)',
      noPermission: 'الوصول مرفوض',
      printTitle: 'القوائم المالية',
      prepared: 'أُعدت في',
      retainedBy: 'أعدها',
      approvedBy: 'اعتمدها'
    }
  };
  function currentLang() { return (S.language === 'ar') ? 'ar' : 'en'; }
  function labelFor(lang, k) {
    var dict = L[lang] || L.en;
    return dict[k] || L.en[k] || k;
  }
  function pick(k) { return labelFor(currentLang(), k); }

  /* ==========================================================================
     NORMALISATION — raw Supabase rows (snake_case) -> stable camelCase shapes.
     Mappers are tolerant (accept mapped input too) and never throw.
     ========================================================================== */
  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return undefined;
  }
  function mapPayment(r) {
    r = r || {};
    return {
      id: r.id || null,
      type: String(firstDefined(r.payment_type, r.type) || ''),
      amount: num(r.amount),
      status: String(r.status || ''),
      due: firstDefined(r.due_date, r.dueDate, r.due) || null,
      paidDate: firstDefined(r.paid_date, r.paidDate, r.paid) || null,
      invoiceNo: String(firstDefined(r.invoice_no, r.invoiceNo) || ''),
      description: String(firstDefined(r.description, r.desc) || ''),
      projectId: firstDefined(r.project_id, r.projectId) || null,
      createdAt: firstDefined(r.created_at, r.createdAt) || null
    };
  }
  function mapBilling(r) {
    r = r || {};
    return {
      id: r.id || null,
      billingNo: String(firstDefined(r.billing_no, r.billingNo) || ''),
      status: String(r.status || '').toLowerCase(),
      totalClaim: num(firstDefined(r.total_claim, r.totalClaim)),
      netPayable: num(firstDefined(r.net_payable, r.netPayable)),
      retentionAmount: num(firstDefined(r.retention_amount, r.retentionAmount)),
      vatAmount: num(firstDefined(r.vat_amount, r.vatAmount)),
      currentNetExclVat: num(firstDefined(r.current_net_excl_vat, r.currentNetExclVat)),
      projectId: firstDefined(r.project_id, r.projectId) || null,
      due: firstDefined(r.due_date, r.dueDate, r.invoice_date, r.invoiceDate, r.period_to, r.periodTo, r.created_at, r.createdAt) || null,
      periodTo: firstDefined(r.period_to, r.periodTo) || null,
      createdAt: firstDefined(r.created_at, r.createdAt) || null
    };
  }
  function mapMaterial(r) {
    r = r || {};
    var qty = num(firstDefined(r.quantity, r.qty));
    var unitCost = num(firstDefined(r.unit_cost_aed, r.unit_cost, r.unitCost));
    return {
      id: r.id || null,
      po: String(firstDefined(r.po_number, r.po, r.invoice_no, r.invoiceNo) || ''),
      supplier: String(firstDefined(r.supplier, r.paid_to) || ''),
      description: String(firstDefined(r.description, r.desc) || ''),
      qty: qty,
      unitCost: unitCost,
      cost: round2(qty * unitCost),
      status: String(r.status || 'approved').toLowerCase(),
      date: firstDefined(r.invoice_date, r.invoiceDate, r.created_at, r.createdAt) || null,
      projectId: firstDefined(r.project_id, r.projectId) || null
    };
  }
  function mapTimesheet(r) {
    r = r || {};
    return {
      id: r.id || null,
      name: String(firstDefined(r.employee_name, r.name) || ''),
      cost: num(firstDefined(r.total_cost_aed, r.cost, r.totalCost)),
      status: String(r.status || '').toLowerCase(),
      date: firstDefined(r.work_date, r.date, r.created_at, r.createdAt) || null,
      projectId: firstDefined(r.project_id, r.projectId) || null
    };
  }
  function mapExpense(r) {
    r = r || {};
    return {
      id: r.id || null,
      category: String(r.category || ''),
      description: String(firstDefined(r.description, r.desc) || ''),
      amount: num(r.amount),
      status: String(r.status || 'approved').toLowerCase(),
      date: firstDefined(r.expense_date, r.expenseDate, r.date, r.created_at, r.createdAt) || null,
      paidTo: String(firstDefined(r.paid_to, r.paidTo) || ''),
      projectId: firstDefined(r.project_id, r.projectId) || null
    };
  }
  function mapBudgetLine(r) {
    r = r || {};
    return {
      id: r.id || null,
      category: String(r.category || ''),
      description: String(firstDefined(r.description, r.desc) || ''),
      budget: num(firstDefined(r.budget_aed, r.budget)),
      actual: num(firstDefined(r.actual_aed, r.actual))
    };
  }
  function mapParty(r) {
    r = r || {};
    return {
      id: r.id || null,
      type: String(firstDefined(r.party_type, r.type) || ''),
      name: String(firstDefined(r.name, r.company_name, r.companyName) || ''),
      companyName: String(firstDefined(r.company_name, r.companyName) || ''),
      projectId: firstDefined(r.project_id, r.projectId) || null
    };
  }
  function mapPaymentRequest(r) {
    r = r || {};
    var amount = num(firstDefined(r.amount_aed, r.amount));
    var retention = num(firstDefined(r.retention_aed, r.retentionAmount));
    var net = firstDefined(r.net_aed, r.netAed, r.net);
    return {
      id: r.id || null,
      reference: String(firstDefined(r.reference, r.request_no, r.requestNo) || ''),
      requestType: String(firstDefined(r.request_type, r.requestType) || ''),
      description: String(firstDefined(r.description, r.desc) || ''),
      amount: amount,
      retention: retention,
      net: net === undefined ? round2(amount - retention) : num(net),
      status: String(r.status || '').toLowerCase(),
      due: firstDefined(r.due_date, r.dueDate, r.created_at, r.createdAt) || null,
      partyId: firstDefined(r.party_id, r.partyId) || null,
      projectId: firstDefined(r.project_id, r.projectId) || null
    };
  }
  function mapProject(r) {
    r = r || {};
    return {
      id: r.id || null,
      code: String(r.code || ''),
      name: String(r.name || ''),
      contractValue: num(firstDefined(r.contract_value_aed, r.contractValue)),
      status: String(r.status || '')
    };
  }
  function mapCompany(r) {
    r = r || {};
    return {
      id: r.id || null,
      name: String(r.name || ''),
      address: String(r.address || ''),
      taxId: String(firstDefined(r.tax_id, r.trn, r.taxId) || ''),
      phone: String(r.phone || ''),
      email: String(r.email || ''),
      logo: firstDefined(r.logo_data, r.logoData, r.logo) || ''
    };
  }
  function mapSettings(r) {
    r = r || {};
    var fy = firstDefined(r.fiscal_year, r.fiscalYear);
    return {
      id: r.id || null,
      companyId: firstDefined(r.company_id, r.companyId) || null,
      fiscalYear: fy === undefined ? null : Number(fy),
      openingCash: num(firstDefined(r.opening_cash_aed, r.openingCash)),
      openingEquity: num(firstDefined(r.opening_equity_aed, r.openingEquity)),
      notes: String(r.notes || '')
    };
  }

  /* Normalise a bag of raw table arrays into one deterministic data object. */
  function normData(data) {
    data = data || {};
    return {
      payments: arr(data.payments).map(mapPayment),
      billings: arr(firstDefined(data.billings, data.progress_billings, data.progressBillings)).map(mapBilling),
      materials: arr(data.materials).map(mapMaterial),
      timesheets: arr(data.timesheets).map(mapTimesheet),
      expenses: arr(firstDefined(data.expenses, data.company_expenses, data.companyExpenses)).map(mapExpense),
      budgetLines: arr(firstDefined(data.budgetLines, data.company_budget_lines, data.companyBudgetLines)).map(mapBudgetLine),
      parties: arr(firstDefined(data.parties, data.project_parties, data.projectParties)).map(mapParty),
      paymentRequests: arr(firstDefined(data.paymentRequests, data.payment_requests)).map(mapPaymentRequest),
      retentionReleases: arr(firstDefined(data.retentionReleases, data.retention_releases)).map(function (r) { r = r || {}; return { id: r.id || null, projectId: firstDefined(r.project_id, r.projectId) || null, amount: num(firstDefined(r.amount_aed, r.amount)) }; }),
      projects: arr(data.projects).map(mapProject),
      companies: arr(data.companies).map(mapCompany),
      settings: mapSettings(firstDefined(data.settings, data.finance_settings, data.financeSettings))
    };
  }

  /* ==========================================================================
     PURE STATEMENT MATHS (deterministic; no DOM, no global app state)
     ========================================================================== */

  /* A certificate counts as receivable once certified, and stays in AR after
   * payment until a received payment offsets it (paid != settled). */
  function certifiedBillings(d) {
    return d.billings.filter(function (b) { return b.status === 'certified' || b.status === 'paid'; });
  }
  function approvedMaterials(d) {
    return d.materials.filter(function (m) { return m.status === 'approved'; });
  }
  function approvedTimesheets(d) {
    return d.timesheets.filter(function (t) { return t.status === 'approved'; });
  }
  function countedExpenses(d) {
    return d.expenses.filter(function (e) { return e.status !== 'rejected'; });
  }
  function supplierPayments(d, paid) {
    return d.payments.filter(function (p) {
      var outgoing = p.type === 'pending' || p.type === 'invoice';
      if (!outgoing) return false;
      if (paid) return p.status === 'paid';
      return p.status !== 'paid' && p.status !== 'cancelled';
    });
  }
  function receivedPayments(d) {
    return d.payments.filter(function (p) { return p.type === 'received' && p.status !== 'cancelled'; });
  }
  function sumAmounts(rows) { return round2(sum(rows, function (r) { return r.amount; })); }

  /* ---- Ageing --------------------------------------------------------------
   * Whole-day difference from due date to the "as of" date:
   *   daysPastDue = dayIndex(asOf) - dayIndex(dueDate)
   * Buckets (inclusive ranges, documented in docs/modules/finance.md):
   *   current  daysPastDue <= 0   (not yet due; due today counts as current)
   *   1–30     1..30
   *   31–60    31..60
   *   61–90    61..90
   *   90+      daysPastDue > 90  (i.e. 91 or more)
   * A row with no usable date is treated as current (0 days past due); invoice
   * date / period end is used as the fallback when due_date is null.
   */
  function bucketFor(dpd) {
    if (dpd <= 0) return 'current';
    if (dpd <= 30) return 'd1_30';
    if (dpd <= 60) return 'd31_60';
    if (dpd <= 90) return 'd61_90';
    return 'd90plus';
  }
  function rowAmount(r) {
    r = r || {};
    var keys = ['amount', 'net_payable', 'netPayable', 'net_aed', 'netAed', 'outstanding', 'net'];
    for (var i = 0; i < keys.length; i++) {
      var v = r[keys[i]];
      if (v !== null && v !== undefined && v !== '') return num(v);
    }
    return 0;
  }
  function rowDue(r) {
    r = r || {};
    var keys = ['due_date', 'dueDate', 'due', 'invoice_date', 'invoiceDate', 'period_to', 'periodTo', 'date', 'created_at', 'createdAt'];
    for (var i = 0; i < keys.length; i++) {
      var v = r[keys[i]];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  }
  function ageing(rows, opts) {
    opts = opts || {};
    var asOf = opts.today || opts.asOf || isoToday();
    var asOfIdx = dayIndex(asOf);
    var out = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0, buckets: [], rows: [], asOf: asOf };
    var counts = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    arr(rows).forEach(function (r) {
      var amount = rowAmount(r);
      if (!amount) return;
      var due = rowDue(r);
      var dueIdx = dayIndex(due);
      var dpd = (asOfIdx === null || dueIdx === null) ? 0 : asOfIdx - dueIdx;
      var key = bucketFor(dpd);
      out[key] = round2(out[key] + amount);
      out.total = round2(out.total + amount);
      counts[key] += 1;
      out.rows.push({ source: r, amount: amount, due: due, daysPastDue: dpd, bucket: key });
    });
    out.buckets = BUCKET_KEYS.map(function (k) {
      return { key: k, amount: out[k], count: counts[k] };
    });
    return out;
  }
  function overdueAmount(age) {
    return round2(age.d1_30 + age.d31_60 + age.d61_90 + age.d90plus);
  }

  /* ---- AR -----------------------------------------------------------------
   * Settlement rule (P2 review — see docs/modules/finance.md §2.1):
   *   1. A certificate with status 'paid' is SETTLED BY STATUS: it is never an
   *      outstanding receivable, never appears in the AR ageing and never
   *      inflates the Overdue KPI (the app's IPC list already shows it as paid).
   *   2. Receipts recorded in `payments` (type 'received') are first treated as
   *      applied to paid certificates, up to their net payable. Any remaining
   *      receipts are FIFO-allocated to open certified certificates (oldest due
   *      date first).
   *   3. Receipts left after every paid + certified certificate is covered are
   *      unapplied client advances: AR is negative and they form a current-
   *      bucket credit row so the ageing total always equals AR.
   *
   *   AR = Σ net_payable(status='certified')
   *        − max(0, receipts − Σ net_payable(status='paid'))
   *
   * This removes the double count that occurred when an IPC was flipped to
   * 'paid' AND the client receipt was also recorded in `payments`.
   */
  function arSettlement(d, opts) {
    opts = opts || {};
    var certified = d.billings.filter(function (b) { return b.status === 'certified'; });
    var paid = d.billings.filter(function (b) { return b.status === 'paid'; });
    var certifiedNet = round2(sum(certified, function (b) { return b.netPayable; }));
    var paidNet = round2(sum(paid, function (b) { return b.netPayable; }));
    var receipts = sumAmounts(receivedPayments(d));
    var receiptsAppliedToPaid = round2(Math.min(receipts, paidNet));
    var pool = round2(receipts - receiptsAppliedToPaid);
    var sorted = certified.slice().sort(function (a, b) {
      var da = dayIndex(a.due), db = dayIndex(b.due);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
    var remaining = pool;
    var rows = [];
    sorted.forEach(function (b) {
      var outstanding = round2(b.netPayable);
      var applied = 0;
      if (remaining > 0) {
        applied = Math.min(remaining, Math.max(0, outstanding));
        outstanding = round2(outstanding - applied);
        remaining = round2(remaining - applied);
      }
      rows.push({
        type: 'billing', id: b.id, reference: b.billingNo || '—', projectId: b.projectId,
        status: 'certified', amount: outstanding, total: b.netPayable,
        applied: round2(applied), due: b.due
      });
    });
    var advance = round2(Math.max(0, remaining));
    if (advance > 0.004) {
      rows.push({
        type: 'credit', id: null, reference: labelFor(opts.lang || 'en', 'receivedToDate'), projectId: null,
        status: 'credit', amount: round2(-advance), total: 0, applied: 0, due: opts.today || isoToday()
      });
    }
    return {
      ar: round2(sum(rows, function (r) { return r.amount; })),
      certifiedNet: certifiedNet,
      paidNet: paidNet,
      receipts: receipts,
      receiptsAppliedToPaid: receiptsAppliedToPaid,
      receiptsAppliedToCertified: round2(pool - advance),
      advance: advance,
      certifiedCount: certified.length,
      paidCount: paid.length,
      rows: rows
    };
  }
  function arTotals(d) {
    var s = arSettlement(d);
    return {
      ar: s.ar,
      certifiedNet: s.certifiedNet,
      paidNet: s.paidNet,
      paidCount: s.paidCount,
      received: s.receipts,
      receiptsAppliedToPaid: s.receiptsAppliedToPaid,
      receiptsAppliedToCertified: s.receiptsAppliedToCertified,
      advance: s.advance,
      count: s.certifiedCount
    };
  }
  function arTotal(data, opts) {
    return arTotals(normData(data));
  }
  function arAgeingOf(d, opts) {
    opts = opts || {};
    var s = arSettlement(d, opts);
    var out = decorateAgeing(ageing(s.rows, opts));
    out.certifiedNet = s.certifiedNet;
    out.paidNet = s.paidNet;
    out.receipts = s.receipts;
    out.receiptsAppliedToPaid = s.receiptsAppliedToPaid;
    out.receiptsAppliedToCertified = s.receiptsAppliedToCertified;
    out.advance = s.advance;
    out.certifiedCount = s.certifiedCount;
    out.paidCount = s.paidCount;
    return out;
  }
  function decorateAgeing(age) {
    var annotated = age.rows.map(function (x) {
      var src = x.source || {};
      return {
        type: src.type || 'row',
        id: src.id || null,
        reference: src.reference || '—',
        party: src.party || '',
        projectId: src.projectId || null,
        status: src.status || '',
        amount: x.amount,
        total: src.total || 0,
        applied: src.applied || 0,
        due: x.due,
        daysPastDue: x.daysPastDue,
        bucket: x.bucket
      };
    });
    return {
      current: age.current, d1_30: age.d1_30, d31_60: age.d31_60, d61_90: age.d61_90, d90plus: age.d90plus,
      total: age.total, buckets: age.buckets, rows: annotated, asOf: age.asOf
    };
  }

  /* ---- AP ----------------------------------------------------------------- */
  function apTotals(d) {
    var requests = d.paymentRequests.filter(function (r) { return r.status === 'approved'; });
    var paymentRequests = round2(sum(requests, function (r) { return r.net; }));
    var materialsTotal = round2(sum(approvedMaterials(d), function (m) { return m.cost; }));
    var paidSupplier = sumAmounts(supplierPayments(d, true));
    var materialAp = round2(Math.max(0, materialsTotal - paidSupplier));
    var unpaid = supplierPayments(d, false);
    var payments = sumAmounts(unpaid);
    return {
      ap: round2(paymentRequests + materialAp + payments),
      paymentRequests: paymentRequests,
      requestCount: requests.length,
      materials: materialAp,
      materialsTotal: materialsTotal,
      paidSupplier: paidSupplier,
      payments: payments,
      paymentCount: unpaid.length
    };
  }
  function apTotal(data, opts) {
    return apTotals(normData(data));
  }

  /* Party display names for payment-request drill-down. */
  function partyNameOf(d, id) {
    if (!id) return '';
    for (var i = 0; i < d.parties.length; i++) {
      if (d.parties[i].id === id) return d.parties[i].companyName || d.parties[i].name;
    }
    return '';
  }
  function apAgeingOf(d, opts) {
    opts = opts || {};
    var rows = [];
    d.paymentRequests.filter(function (r) { return r.status === 'approved'; }).forEach(function (r) {
      rows.push({
        type: 'payment_request', id: r.id, reference: r.reference || '—', party: partyNameOf(d, r.partyId),
        projectId: r.projectId, status: r.status, amount: r.net, due: r.due
      });
    });
    /* Material payables: FIFO-offset paid supplier invoices against approved
     * material costs (oldest invoice date first); residual rows are aged. */
    var paid = sumAmounts(supplierPayments(d, true));
    var mats = approvedMaterials(d).slice().sort(function (a, b) {
      var da = dayIndex(a.date), db = dayIndex(b.date);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
    mats.forEach(function (m) {
      var outstanding = round2(m.cost);
      if (paid > 0) {
        var applied = Math.min(paid, Math.max(0, outstanding));
        outstanding = round2(outstanding - applied);
        paid = round2(paid - applied);
      }
      if (outstanding > 0.004) {
        rows.push({
          type: 'material', id: m.id, reference: m.po || m.description || 'Materials',
          party: m.supplier, projectId: m.projectId, status: m.status,
          amount: outstanding, due: m.date
        });
      }
    });
    supplierPayments(d, false).forEach(function (p) {
      rows.push({
        type: 'payment', id: p.id, reference: p.invoiceNo || p.description || 'Supplier invoice',
        party: '', projectId: p.projectId, status: p.status, amount: p.amount, due: p.due
      });
    });
    return decorateAgeing(ageing(rows, opts));
  }

  /* ---- Cash --------------------------------------------------------------- */
  function cashFlowOf(d) {
    var received = sumAmounts(receivedPayments(d));
    var paidSuppliers = sumAmounts(supplierPayments(d, true));
    var expenses = round2(sum(countedExpenses(d), function (e) { return e.amount; }));
    var paidPaymentRequests = round2(sum(d.paymentRequests.filter(function (r) { return r.status === 'paid'; }), function (r) { return r.net; }));
    var outflow = round2(paidSuppliers + expenses + paidPaymentRequests);
    return {
      received: received,
      paidSuppliers: paidSuppliers,
      expenses: expenses,
      paidPaymentRequests: paidPaymentRequests,
      outflow: outflow,
      movement: round2(received - outflow)
    };
  }

  function settingsFor(d, opts) {
    var o = (opts && opts.settings) || null;
    if (o) return mapSettings(o);
    return d.settings || mapSettings({});
  }

  /* ---- Balance sheet ------------------------------------------------------
   * Assets      = cash (opening + movement) + AR
   * Liabilities = AP + retention payable + VAT payable
   * Equity      = Assets - Liabilities                     (by construction)
   * current-period result = equity - opening equity        (disclosure)
   * The identity row is Assets - Liabilities - Equity and is always 0.00; the
   * module only renders the imbalance badge if the arithmetic check fails. */
  function balanceSheetOf(d, opts) {
    opts = opts || {};
    var asOf = opts.today || opts.asOf || isoToday();
    var settings = settingsFor(d, opts);
    var ar = arTotals(d);
    var ap = apTotals(d);
    var cf = cashFlowOf(d);
    var certified = certifiedBillings(d);
    var releasedRetention = Number(opts.releasedRetention != null ? opts.releasedRetention : sum(d.retentionReleases, function (r) { return r.amount; })) || 0;
    var retentionPayable = round2(Math.max(0, sum(certified, function (b) { return b.retentionAmount; }) - releasedRetention));
    var vatPayable = round2(sum(certified, function (b) { return b.vatAmount; }));
    var openingCash = round2(settings.openingCash);
    var openingEquity = round2(settings.openingEquity);
    var cash = round2(openingCash + cf.movement);
    var assets = round2(cash + ar.ar);
    var liabilities = round2(ap.ap + retentionPayable + vatPayable);
    var equity = round2(assets - liabilities);
    var currentResult = round2(equity - openingEquity);
    var diff = round2(round2(assets - liabilities) - equity);
    return {
      asOf: asOf,
      settings: settings,
      openingCash: openingCash,
      openingEquity: openingEquity,
      cash: cash,
      cashMovement: cf.movement,
      cashFlow: cf,
      ar: ar.ar,
      certifiedNet: ar.certifiedNet,
      received: ar.received,
      assets: assets,
      ap: ap.ap,
      apBreakdown: ap,
      retentionPayable: retentionPayable,
      vatPayable: vatPayable,
      liabilities: liabilities,
      equity: equity,
      currentResult: currentResult,
      diff: diff,
      balanced: Math.abs(diff) <= 0.01
    };
  }
  function balanceSheet(data, opts) {
    return balanceSheetOf(normData(data), opts);
  }

  /* ---- P&L / project profitability ---------------------------------------
   * Revenue = sum(total_claim) of certified/paid certificates (VAT excluded:
   * total_claim is the gross valuation, VAT is a separate vat_amount column).
   * Direct cost = approved materials + approved timesheets.
   * Overhead = company_expenses not rejected.
   * Gross profit = revenue - direct cost; Net profit = revenue - total cost. */
  function pnlOf(d, opts) {
    opts = opts || {};
    var certified = certifiedBillings(d);
    var revenue = round2(sum(certified, function (b) { return b.totalClaim; }));
    var revenueThisPeriod = round2(sum(certified, function (b) { return b.currentNetExclVat; }));
    var vatOnRevenue = round2(sum(certified, function (b) { return b.vatAmount; }));
    var mats = approvedMaterials(d);
    var materials = round2(sum(mats, function (m) { return m.cost; }));
    var labour = round2(sum(approvedTimesheets(d), function (t) { return t.cost; }));
    var exp = countedExpenses(d);
    var expenses = round2(sum(exp, function (e) { return e.amount; }));
    var directCost = round2(materials + labour);
    var totalCost = round2(directCost + expenses);
    var grossProfit = round2(revenue - directCost);
    var netProfit = round2(revenue - totalCost);
    var grossMargin = revenue > 0 ? round2((grossProfit / revenue) * 100) : 0;
    var netMargin = revenue > 0 ? round2((netProfit / revenue) * 100) : 0;

    /* Project profitability: revenue, materials + labour by project; expenses
     * with a project_id are allocated, company-level expenses stay overhead. */
    var byId = {};
    function projectRow(pid) {
      if (!byId[pid]) byId[pid] = { projectId: pid, revenue: 0, materials: 0, labour: 0, expenses: 0 };
      return byId[pid];
    }
    certified.forEach(function (b) { projectRow(b.projectId).revenue += b.totalClaim; });
    mats.forEach(function (m) { projectRow(m.projectId).materials += m.cost; });
    approvedTimesheets(d).forEach(function (t) { projectRow(t.projectId).labour += t.cost; });
    exp.forEach(function (e) { if (e.projectId) projectRow(e.projectId).expenses += e.amount; });
    d.projects.forEach(function (p) { projectRow(p.id); });
    var projectByKey = {};
    d.projects.forEach(function (p) { projectByKey[p.id] = p; });
    var projects = Object.keys(byId).map(function (pid) {
      var row = byId[pid];
      var p = projectByKey[pid] || {};
      var rev = round2(row.revenue), mat = round2(row.materials), lab = round2(row.labour), oxp = round2(row.expenses);
      var cost = round2(mat + lab + oxp);
      var profit = round2(rev - cost);
      return {
        projectId: pid,
        code: p.code || '',
        name: p.name || (pid ? String(pid).slice(0, 8) : '—'),
        revenue: rev, materials: mat, labour: lab, expenses: oxp, cost: cost, profit: profit,
        margin: rev > 0 ? round2((profit / rev) * 100) : 0
      };
    }).filter(function (r) { return r.revenue || r.cost; })
      .sort(function (a, b) { return b.revenue - a.revenue || b.cost - a.cost; });

    return {
      revenue: revenue,
      revenueThisPeriod: revenueThisPeriod,
      vatOnRevenue: vatOnRevenue,
      vatExcluded: true,
      materials: materials,
      labour: labour,
      expenses: expenses,
      directCost: directCost,
      totalCost: totalCost,
      grossProfit: grossProfit,
      grossMargin: grossMargin,
      netProfit: netProfit,
      netMargin: netMargin,
      projects: projects
    };
  }
  function pnl(data, opts) {
    return pnlOf(normData(data), opts);
  }

  /* One-shot computation used by the UI / print / CSV paths. */
  function computeFromNorm(d, opts) {
    opts = opts || {};
    var asOf = opts.today || opts.asOf || isoToday();
    return {
      asOf: asOf,
      settings: settingsFor(d, opts),
      ar: arTotals(d),
      ap: apTotals(d),
      arAgeing: arAgeingOf(d, { today: asOf, lang: opts.lang }),
      apAgeing: apAgeingOf(d, { today: asOf }),
      bs: balanceSheetOf(d, { today: asOf, settings: opts.settings }),
      pnl: pnlOf(d, opts),
      data: d
    };
  }
  function compute(data, opts) {
    return computeFromNorm(normData(data), opts);
  }

  /* ==========================================================================
     CSV — spreadsheet-safe values (formula injection), UTF-8 BOM download.
     ========================================================================== */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    var s = String(v);
    /* Prefix formula-leading values so Excel/Sheets never evaluate them. */
    if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
    return s;
  }
  function csvRow(cells) {
    return (cells || []).map(function (c) {
      var s = String(csvCell(c));
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }
  function buildCSV(rows) { return (rows || []).map(csvRow).join('\r\n'); }
  function downloadCSV(filename, rows) {
    var blob = new Blob(['\uFEFF' + buildCSV(rows)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1500);
  }

  /* ==========================================================================
     CSV ROWS PER STATEMENT
     ========================================================================== */
  function lab(lang, k) { return labelFor(lang, k); }
  function projectCodeOf(fx, pid) {
    if (!pid) return '—';
    for (var i = 0; i < fx.data.projects.length; i++) {
      if (fx.data.projects[i].id === pid) return fx.data.projects[i].code || fx.data.projects[i].name;
    }
    return '—';
  }
  function projectNameOf(fx, pid) {
    if (!pid) return '—';
    for (var i = 0; i < fx.data.projects.length; i++) {
      if (fx.data.projects[i].id === pid) return fx.data.projects[i].name || fx.data.projects[i].code;
    }
    return '—';
  }
  function bucketLabelFor(lang, key) {
    var map = { current: 'current', d1_30: 'days1_30', d31_60: 'days31_60', d61_90: 'days61_90', d90plus: 'days90plus' };
    return lab(lang, map[key] || key);
  }
  function csvRowsFor(tab, fx, lang) {
    var rows = [];
    function push() { rows.push(Array.prototype.slice.call(arguments)); }
    var title = lab(lang, 'title') + ' — ' + lab(lang, tab === 'ar' ? 'tab_ar' : tab === 'ap' ? 'tab_ap' : tab === 'bs' ? 'tab_bs' : 'tab_pnl');
    push(title);
    push(lab(lang, 'asOf'), fx.asOf);
    push([]);
    if (tab === 'ar') {
      push(lab(lang, 'ageing'));
      push(lab(lang, 'bucket'), lab(lang, 'invoices'), lab(lang, 'amount'));
      fx.arAgeing.buckets.forEach(function (b) { push(bucketLabelFor(lang, b.key), b.count, b.amount); });
      push(lab(lang, 'total'), fx.arAgeing.buckets.reduce(function (s, b) { return s + b.count; }, 0), fx.ar.total);
      push([]);
      push(lab(lang, 'customerReceivables'));
      push(lab(lang, 'billingNo'), lab(lang, 'project'), lab(lang, 'status'), lab(lang, 'dueDate'), lab(lang, 'daysPastDue'), lab(lang, 'bucket'), lab(lang, 'netPayable'), lab(lang, 'applied'), lab(lang, 'outstanding'));
      fx.arAgeing.rows.forEach(function (r) {
        push(r.reference, projectCodeOf(fx, r.projectId), r.status, r.due || '', r.daysPastDue,
          bucketLabelFor(lang, r.bucket), r.total || '', r.applied, r.amount);
      });
      push([]);
      push(lab(lang, 'settlementRecon'));
      push(lab(lang, 'certifiedNet'), fx.ar.certifiedNet);
      push(lab(lang, 'paidSettled'), fx.ar.paidNet, fx.ar.paidCount);
      push(lab(lang, 'receiptsAppliedToPaid'), fx.ar.receiptsAppliedToPaid);
      push(lab(lang, 'receiptsAppliedToCertified'), fx.ar.receiptsAppliedToCertified);
      push(lab(lang, 'advanceReceipts'), fx.ar.advance);
      push(lab(lang, 'totalReceivables'), fx.ar.ar);
    } else if (tab === 'ap') {
      push(lab(lang, 'ageing'));
      push(lab(lang, 'bucket'), lab(lang, 'invoices'), lab(lang, 'amount'));
      fx.apAgeing.buckets.forEach(function (b) { push(bucketLabelFor(lang, b.key), b.count, b.amount); });
      push(lab(lang, 'total'), fx.apAgeing.buckets.reduce(function (s, b) { return s + b.count; }, 0), fx.ap.ap);
      push([]);
      push(lab(lang, 'payables'));
      push(lab(lang, 'payableType'), lab(lang, 'reference'), lab(lang, 'party'), lab(lang, 'project'), lab(lang, 'dueDate'), lab(lang, 'daysPastDue'), lab(lang, 'bucket'), lab(lang, 'amount'), lab(lang, 'status'));
      fx.apAgeing.rows.forEach(function (r) {
        var typeLabel = r.type === 'payment_request' ? lab(lang, 'paymentRequest') : r.type === 'material' ? lab(lang, 'materials') : lab(lang, 'supplierInvoice');
        push(typeLabel, r.reference, r.party || '', projectCodeOf(fx, r.projectId), r.due || '', r.daysPastDue,
          bucketLabelFor(lang, r.bucket), r.amount, r.status);
      });
      push([]);
      push(lab(lang, 'approvedRequests'), fx.ap.paymentRequests);
      push(lab(lang, 'materialPayables'), fx.ap.materials);
      push(lab(lang, 'pendingInvoices'), fx.ap.payments);
      push(lab(lang, 'totalPayables'), fx.ap.ap);
    } else if (tab === 'bs') {
      push(lab(lang, 'assets'));
      push(lab(lang, 'cashAndEquivalents'), fx.bs.cash);
      push(lab(lang, 'accountsReceivable'), fx.bs.ar);
      push(lab(lang, 'totalAssets'), fx.bs.assets);
      push([]);
      push(lab(lang, 'liabilities'));
      push(lab(lang, 'accountsPayable'), fx.bs.ap);
      push(lab(lang, 'retentionPayable'), fx.bs.retentionPayable);
      push(lab(lang, 'vatPayable'), fx.bs.vatPayable);
      push(lab(lang, 'totalLiabilities'), fx.bs.liabilities);
      push([]);
      push(lab(lang, 'equity'));
      push(lab(lang, 'openingEquity'), fx.bs.openingEquity);
      push(lab(lang, 'currentPeriodResult'), fx.bs.currentResult);
      push(lab(lang, 'totalEquity'), fx.bs.equity);
      push([]);
      push(lab(lang, 'balanceIdentity'), fx.bs.diff, fx.bs.balanced ? lab(lang, 'balanced') : lab(lang, 'imbalance'));
      push(lab(lang, 'openingCash'), fx.bs.openingCash);
      push(lab(lang, 'cashMovement'), fx.bs.cashMovement);
    } else {
      push(lab(lang, 'profitLoss'));
      push(lab(lang, 'pnlRevenue'), fx.pnl.revenue);
      push(lab(lang, 'pnlMaterials'), fx.pnl.materials);
      push(lab(lang, 'pnlLabour'), fx.pnl.labour);
      push(lab(lang, 'directCost'), fx.pnl.directCost);
      push(lab(lang, 'grossProfit'), fx.pnl.grossProfit);
      push(lab(lang, 'grossMargin'), fx.pnl.grossMargin);
      push(lab(lang, 'overhead'), fx.pnl.expenses);
      push(lab(lang, 'netProfit'), fx.pnl.netProfit);
      push(lab(lang, 'netMargin'), fx.pnl.netMargin);
      push([]);
      push(lab(lang, 'projectProfitability'));
      push(lab(lang, 'project'), lab(lang, 'pnlRevenue'), lab(lang, 'pnlMaterials'), lab(lang, 'pnlLabour'), lab(lang, 'overhead'), lab(lang, 'directCost'), lab(lang, 'netProfit'), lab(lang, 'netMargin'));
      fx.pnl.projects.forEach(function (p) {
        push((p.code ? p.code + ' · ' : '') + p.name, p.revenue, p.materials, p.labour, p.expenses, p.cost, p.profit, p.margin);
      });
    }
    return rows;
  }

  /* ==========================================================================
     PRINT / PDF PACK — company-branded, dir-aware, all values escaped.
     ========================================================================== */
  function printStyles() {
    return 'body{font-family:Arial,Helvetica,sans-serif;padding:32px;max-width:860px;margin:auto;color:#111}' +
      'h1{font-size:20px;margin:0}h2{font-size:14px;margin:22px 0 8px;border-bottom:1px solid #111;padding-bottom:4px}' +
      'table{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:12px}' +
      'th{text-align:left;background:#f2f2f2;padding:6px 8px;border-bottom:2px solid #111;font-size:10.5px;text-transform:uppercase}' +
      'td{padding:5px 8px;border-bottom:1px solid #ddd}.right{text-align:right}' +
      'html[dir="rtl"] th{text-align:right}html[dir="rtl"] .right{text-align:left}' +
      '.total td{font-weight:800;background:#fafafa;border-top:1px solid #111}' +
      '.brand{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:12px}' +
      '.brand img{height:60px;max-width:180px;object-fit:contain}' +
      '.meta{font-size:11px;color:#444;line-height:1.55}' +
      '.muted{color:#666;font-size:10.5px;line-height:1.55;margin-top:18px}' +
      '.sig{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:44px}' +
      '.sig-line{border-bottom:1px solid #111;height:34px}.sig-lbl{font-size:9.5px;text-transform:uppercase;font-weight:800;margin-top:4px}' +
      '@media print{body{padding:0}}';
  }
  function printTable(columns, rows, totals) {
    var head = '<tr>' + columns.map(function (c) { return '<th' + (c.align === 'r' ? ' class="right"' : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr>';
    var body = rows.length ? rows.map(function (r) {
      return '<tr>' + r.map(function (cell, i) {
        var c = columns[i] || {};
        return '<td' + (c.align === 'r' ? ' class="right"' : '') + '>' + esc(cell) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + columns.length + '">' + esc(labelFor(currentLang(), 'noData')) + '</td></tr>';
    var foot = totals ? '<tr class="total">' + totals.map(function (cell, i) {
      var c = columns[i] || {};
      return '<td' + (c.align === 'r' ? ' class="right"' : '') + '>' + esc(cell) + '</td>';
    }).join('') + '</tr>' : '';
    return '<table><thead>' + head + '</thead><tbody>' + body + foot + '</tbody></table>';
  }
  function moneyColumn(label) { return { label: label, align: 'r' }; }
  function printHTML(tab, data, opts) {
    opts = opts || {};
    var d = normData(data);
    var lang = opts.lang || currentLang();
    var isAr = lang === 'ar';
    var fx = computeFromNorm(d, { today: opts.today || isoToday(), settings: opts.settings, lang: lang });
    var company = mapCompany(opts.company || {});
    var labk = function (k) { return labelFor(lang, k); };
    var sections = [];

    if (tab === 'all' || tab === 'ar') {
      var arHead = [{ label: labk('bucket') }, { label: labk('invoices'), align: 'r' }, moneyColumn(labk('amount')), { label: labk('pctOfTotal'), align: 'r' }];
      var arAgeRows = fx.arAgeing.buckets.map(function (b) {
        return [bucketLabelFor(lang, b.key), b.count, money(b.amount), fx.ar.total ? pctText((b.amount / fx.ar.total) * 100) : '0.00%'];
      });
      var arDrill = fx.arAgeing.rows.map(function (r) {
        return [r.reference, projectCodeOf(fx, r.projectId), r.status, r.due ? fmtDate(r.due) : '—', r.daysPastDue, bucketLabelFor(lang, r.bucket), money(r.total), money(r.applied), money(r.amount)];
      });
      sections.push('<h2>' + esc(labk('receivables')) + '</h2>' +
        printTable(arHead, arAgeRows, [labk('total'), fx.arAgeing.buckets.reduce(function (s, b) { return s + b.count; }, 0), money(fx.ar.total), '100.00%']) +
        printTable([{ label: labk('billingNo') }, { label: labk('project') }, { label: labk('status') }, { label: labk('dueDate') }, { label: labk('daysPastDue'), align: 'r' }, { label: labk('bucket') }, moneyColumn(labk('netPayable')), moneyColumn(labk('applied')), moneyColumn(labk('outstanding'))], arDrill) +
        '<div class="meta">' + esc(labk('settlementRecon')) + ': ' +
        esc(labk('paidSettled')) + ' ' + money(fx.ar.paidNet) + ' (' + fx.ar.paidCount + ') · ' +
        esc(labk('receiptsAppliedToPaid')) + ' ' + money(fx.ar.receiptsAppliedToPaid) + ' · ' +
        esc(labk('receiptsAppliedToCertified')) + ' ' + money(fx.ar.receiptsAppliedToCertified) + ' · ' +
        esc(labk('advanceReceipts')) + ' ' + money(fx.ar.advance) + '</div>');
    }
    if (tab === 'all' || tab === 'ap') {
      var apHead = [{ label: labk('bucket') }, { label: labk('invoices'), align: 'r' }, moneyColumn(labk('amount')), { label: labk('pctOfTotal'), align: 'r' }];
      var apAgeRows = fx.apAgeing.buckets.map(function (b) {
        return [bucketLabelFor(lang, b.key), b.count, money(b.amount), fx.ap.ap ? pctText((b.amount / fx.ap.ap) * 100) : '0.00%'];
      });
      var apDrill = fx.apAgeing.rows.map(function (r) {
        var typeLabel = r.type === 'payment_request' ? labk('paymentRequest') : r.type === 'material' ? labk('materials') : labk('supplierInvoice');
        return [typeLabel, r.reference, r.party || '', projectCodeOf(fx, r.projectId), r.due ? fmtDate(r.due) : '—', r.daysPastDue, bucketLabelFor(lang, r.bucket), money(r.amount), r.status];
      });
      sections.push('<h2>' + esc(labk('payables')) + '</h2>' +
        printTable(apHead, apAgeRows, [labk('total'), fx.apAgeing.buckets.reduce(function (s, b) { return s + b.count; }, 0), money(fx.ap.ap), '100.00%']) +
        printTable([{ label: labk('payableType') }, { label: labk('reference') }, { label: labk('party') }, { label: labk('project') }, { label: labk('dueDate') }, { label: labk('daysPastDue'), align: 'r' }, { label: labk('bucket') }, moneyColumn(labk('amount')), { label: labk('status') }], apDrill) +
        printTable([{ label: labk('approvedRequests') }, moneyColumn(labk('amount'))],
          [[labk('approvedRequests'), money(fx.ap.paymentRequests)], [labk('materialPayables'), money(fx.ap.materials)], [labk('pendingInvoices'), money(fx.ap.payments)]],
          [labk('totalPayables'), money(fx.ap.ap)]));
    }
    if (tab === 'all' || tab === 'bs') {
      var bs = fx.bs;
      var bsCols = [{ label: labk('balanceSheet') }, moneyColumn(labk('amount'))];
      var bsRows = [
        [labk('assets'), ''],
        ['  ' + labk('cashAndEquivalents'), money(bs.cash)],
        ['  ' + labk('accountsReceivable'), money(bs.ar)],
        [labk('totalAssets'), money(bs.assets)],
        ['', ''],
        [labk('liabilities'), ''],
        ['  ' + labk('accountsPayable'), money(bs.ap)],
        ['  ' + labk('retentionPayable'), money(bs.retentionPayable)],
        ['  ' + labk('vatPayable'), money(bs.vatPayable)],
        [labk('totalLiabilities'), money(bs.liabilities)],
        ['', ''],
        [labk('equity'), ''],
        ['  ' + labk('openingEquity'), money(bs.openingEquity)],
        ['  ' + labk('currentPeriodResult'), money(bs.currentResult)],
        [labk('totalEquity'), money(bs.equity)],
        ['', ''],
        [labk('balanceIdentity'), money(bs.diff)]
      ];
      sections.push('<h2>' + esc(labk('balanceSheet')) + '</h2>' + printTable(bsCols, bsRows) +
        '<div class="meta">' + esc(labk('balanceIdentity')) + ': ' + money(bs.diff) + ' — <b>' + esc(bs.balanced ? labk('balanced') : labk('imbalance')) + '</b></div>');
    }
    if (tab === 'all' || tab === 'pnl') {
      var p = fx.pnl;
      var pnlRows = [
        [labk('pnlRevenue'), money(p.revenue)],
        [labk('pnlMaterials'), money(p.materials)],
        [labk('pnlLabour'), money(p.labour)],
        [labk('directCost'), money(p.directCost)],
        [labk('grossProfit'), money(p.grossProfit)],
        [labk('grossMargin'), pctText(p.grossMargin)],
        [labk('overhead'), money(p.expenses)],
        [labk('netProfit'), money(p.netProfit)],
        [labk('netMargin'), pctText(p.netMargin)]
      ];
      var projRows = p.projects.map(function (x) {
        return [(x.code ? x.code + ' · ' : '') + x.name, money(x.revenue), money(x.materials), money(x.labour), money(x.expenses), money(x.cost), money(x.profit), pctText(x.margin)];
      });
      sections.push('<h2>' + esc(labk('profitLoss')) + '</h2>' +
        printTable([{ label: labk('profitLoss') }, moneyColumn(labk('amount'))], pnlRows) +
        printTable([{ label: labk('project') }, moneyColumn(labk('pnlRevenue')), moneyColumn(labk('pnlMaterials')), moneyColumn(labk('pnlLabour')), moneyColumn(labk('overhead')), moneyColumn(labk('directCost')), moneyColumn(labk('netProfit')), { label: labk('netMargin'), align: 'r' }], projRows) +
        '<div class="meta">' + esc(labk('vatExcludedNote')) + '</div>');
    }

    var logo = safeImg(company.logo);
    var brand = '<div class="brand"><div>' + (logo ? '<img src="' + logo + '" alt="">' : '') +
      '<h1>' + esc(company.name || 'SiteForge') + '</h1>' +
      '<div class="meta">' + esc(company.address || '') + (company.taxId ? '<br>TRN: ' + esc(company.taxId) : '') +
      (company.phone ? '<br>' + esc(company.phone) : '') + (company.email ? ' · ' + esc(company.email) : '') + '</div></div>' +
      '<div style="text-align:right"><h1 style="font-size:15px">' + esc(labk('printTitle')) + '</h1>' +
      '<div class="meta">' + esc(labk('asOf')) + ' ' + esc(fx.asOf) + '<br>' + esc(labk('prepared')) + ': ' + esc(fx.asOf) + '</div></div></div>';
    var sigs = '<div class="sig"><div><div class="sig-line"></div><div class="sig-lbl">' + esc(labk('retainedBy')) + '</div></div>' +
      '<div><div class="sig-line"></div><div class="sig-lbl">' + esc(labk('approvedBy')) + '</div></div></div>';
    var foot = '<div class="muted">' + esc(labk('derivationNote')) + '</div>';

    return '<!DOCTYPE html><html dir="' + (isAr ? 'rtl' : 'ltr') + '" lang="' + (isAr ? 'ar' : 'en') + '"><head><meta charset="utf-8"><title>' +
      esc(labk('printTitle')) + ' — ' + esc(fx.asOf) + '</title><style>' + printStyles() + '</style></head><body>' +
      brand + sections.join('') + sigs + foot + '</body></html>';
  }

  /* ==========================================================================
     DATA LOADING — no project filter; selectStrict distinguishes missing tables
     ========================================================================== */
  var CORE_TABLES = ['payments', 'progress_billings', 'materials', 'timesheets', 'company_expenses', 'company_budget_lines', 'project_parties', 'projects', 'companies'];
  var OPTIONAL_TABLES = ['payment_requests', 'finance_settings', 'retention_releases'];

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
  function pickSettingsRow(rows, companyId) {
    var list = arr(rows);
    if (!list.length) return null;
    var year = new Date().getFullYear();
    if (companyId) {
      var own = list.filter(function (r) { return r.company_id === companyId || !r.company_id; });
      if (own.length) list = own;
    }
    var exact = list.filter(function (r) { return Number(r.fiscal_year) === year; });
    if (exact.length) return exact[0];
    return list[0];
  }
  function loadData() {
    var specs = CORE_TABLES.concat(OPTIONAL_TABLES);
    return Promise.all(specs.map(loadTable)).then(function (results) {
      var byTable = {};
      specs.forEach(function (name, i) { byTable[name] = results[i] || { rows: [], error: null }; });
      var warnings = [];
      CORE_TABLES.forEach(function (name) {
        var r = byTable[name];
        if (r && r.error) warnings.push({ table: name, message: r.error.message || String(r.error), optional: false });
      });
      var settingsMissing = false;
      var settingsError = byTable.finance_settings && byTable.finance_settings.error;
      if (settingsError) {
        if (isMissingTable(settingsError)) settingsMissing = true;
        else warnings.push({ table: 'finance_settings', message: settingsError.message || String(settingsError), optional: false });
      }
      if (byTable.payment_requests && byTable.payment_requests.error) {
        /* The payment-requests module is optional; its table may not be deployed
         * yet. Treat it as empty instead of surfacing an error. */
        warnings.push({ table: 'payment_requests', message: 'excluded (table not installed)', optional: true });
      }
      var companies = arr(byTable.companies && byTable.companies.rows);
      var companyId = (S.company && S.company.id) || (companies[0] && companies[0].id) || null;
      var raw = {
        payments: arr(byTable.payments.rows),
        billings: arr(byTable.progress_billings.rows),
        materials: arr(byTable.materials.rows),
        timesheets: arr(byTable.timesheets.rows),
        expenses: arr(byTable.company_expenses.rows),
        budgetLines: arr(byTable.company_budget_lines.rows),
        parties: arr(byTable.project_parties.rows),
        paymentRequests: byTable.payment_requests && !byTable.payment_requests.error ? arr(byTable.payment_requests.rows) : [],
        retentionReleases: byTable.retention_releases && !byTable.retention_releases.error ? arr(byTable.retention_releases.rows) : [],
        projects: arr(byTable.projects.rows),
        companies: companies
      };
      var settingsRow = byTable.finance_settings && !byTable.finance_settings.error ? pickSettingsRow(byTable.finance_settings.rows, companyId) : null;
      return { data: raw, settingsRow: settingsRow, settingsMissing: settingsMissing, warnings: warnings };
    });
  }

  /* ==========================================================================
     UI
     ========================================================================== */
  var MOD = {
    tab: 'ar',
    data: null,
    settingsRow: null,
    settingsMissing: false,
    warnings: [],
    stale: true,
    token: 0,
    el: null,
    asOf: null
  };

  function canManage() {
    try { return !!(UI && typeof UI.canManage === 'function' && UI.canManage()); } catch (e) { return false; }
  }
  function kpi(cls, label, valueHtml, subHtml) {
    return '<div class="kpi ' + cls + '"><div class="lbl">' + esc(label) + '</div><div class="val">' + valueHtml + '</div>' +
      (subHtml ? '<div class="sub">' + subHtml + '</div>' : '') + '</div>';
  }
  function kpiGrid(items) {
    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(165px,1fr));margin-bottom:14px">' + items.join('') + '</div>';
  }
  function tableHTML(headers, rowsHtml, emptyText) {
    return '<div style="overflow-x:auto"><table><thead><tr>' +
      headers.map(function (h) { return '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + esc(h.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      (rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="' + headers.length + '" class="empty">' + esc(emptyText || pick('noData')) + '</td></tr>') +
      '</tbody></table></div>';
  }
  function tagForStatus(status) {
    var s = String(status || '').toLowerCase();
    var cls = (s === 'paid' || s === 'approved') ? 'ok' : (s === 'certified' || s === 'submitted') ? 'info' : (s === 'rejected' || s === 'overdue') ? 'bad' : 'warn';
    return '<span class="tag ' + cls + '">' + esc(status || '—') + '</span>';
  }
  function bucketTag(key) {
    var cls = key === 'current' ? 'ok' : key === 'd1_30' ? 'info' : key === 'd31_60' ? 'warn' : 'bad';
    return '<span class="tag ' + cls + '">' + esc(bucketLabelFor(currentLang(), key)) + '</span>';
  }
  function bucketLabel(key) { return bucketLabelFor(currentLang(), key); }
  function actionBtn(action, label, icon) {
    return '<button type="button" class="btn ghost sm" data-sf-action="' + esc(action) + '">' + (icon ? icon + ' ' : '') + esc(label) + '</button>';
  }
  function ageingCard(age, totalAmount) {
    var rows = age.buckets.map(function (b) {
      var share = totalAmount ? pctText((b.amount / totalAmount) * 100) : '0.00%';
      return '<tr><td>' + bucketTag(b.key) + '</td><td class="tright mono">' + b.count + '</td><td class="tright mono">' + money(b.amount) + '</td><td class="tright mono mutc">' + esc(share) + '</td></tr>';
    });
    rows.push('<tr style="background:var(--panel2);font-weight:800"><td>' + esc(pick('total')) + '</td><td class="tright mono">' +
      age.buckets.reduce(function (s, b) { return s + b.count; }, 0) + '</td><td class="tright mono">' + money(age.total) + '</td><td class="tright mono mutc">100.00%</td></tr>');
    return '<div class="card"><h3>' + esc(pick('ageing')) + '</h3>' +
      tableHTML([{ label: pick('bucket') }, { label: pick('invoices'), cls: 'tright' }, { label: pick('amount'), cls: 'tright' }, { label: pick('pctOfTotal'), cls: 'tright' }], rows) + '</div>';
  }

  function arTab(fx) {
    var ar = fx.ar, age = fx.arAgeing;
    var overdue = overdueAmount(age);
    var overdueCount = age.rows.filter(function (r) { return r.daysPastDue > 0; }).length;
    var kpis = kpiGrid([
      kpi('g', pick('totalReceivables'), money0(ar.ar), pick('certifiedNet') + ' ' + money0(ar.certifiedNet)),
      kpi('b', pick('outstandingInvoices'), String(ar.count), pick('receivedToDate') + ' ' + money0(ar.received)),
      kpi(overdue > 0 ? 'r' : 'g', pick('overdue'), money0(overdue), overdueCount + ' ' + pick('invoices').toLowerCase()),
      kpi('y', pick('cashPosition'), money0(fx.bs.cash), pick('cashMovement') + ' ' + money0(fx.bs.cashMovement))
    ]);
    var rows = age.rows.map(function (r) {
      return '<tr>' +
        '<td class="mono" style="color:var(--accent)">' + esc(r.reference) + '</td>' +
        '<td>' + esc(projectNameOf(fx, r.projectId)) + '</td>' +
        '<td>' + tagForStatus(r.status) + '</td>' +
        '<td class="mutc">' + (r.due ? fmtDate(r.due) : '—') + '</td>' +
        '<td class="tright mono ' + (r.daysPastDue > 0 ? 'badc' : 'mutc') + '">' + r.daysPastDue + '</td>' +
        '<td>' + bucketTag(r.bucket) + '</td>' +
        '<td class="tright mono">' + money(r.total) + '</td>' +
        '<td class="tright mono mutc">' + money(r.applied) + '</td>' +
        '<td class="tright mono"><b>' + money(r.amount) + '</b></td>' +
        '</tr>';
    });
    var recon = '<div class="mutc" style="font-size:11px;line-height:1.7;margin-top:10px">' +
      '<b>' + esc(pick('settlementRecon')) + '</b>: ' +
      esc(pick('paidSettled')) + ' ' + money0(ar.paidNet) + ' (' + ar.paidCount + ') · ' +
      esc(pick('receiptsAppliedToPaid')) + ' ' + money0(ar.receiptsAppliedToPaid) + ' · ' +
      esc(pick('receiptsAppliedToCertified')) + ' ' + money0(ar.receiptsAppliedToCertified) + ' · ' +
      esc(pick('advanceReceipts')) + ' ' + money0(ar.advance) +
      '<br>' + esc(pick('arRule')) + '</div>';
    return kpis + ageingCard(age, ar.ar) +
      '<div class="card" style="margin-top:14px"><h3>' + esc(pick('customerReceivables')) + '</h3>' +
      tableHTML([
        { label: pick('billingNo') }, { label: pick('project') }, { label: pick('status') }, { label: pick('dueDate') },
        { label: pick('daysPastDue'), cls: 'tright' }, { label: pick('bucket') }, { label: pick('netPayable'), cls: 'tright' },
        { label: pick('applied'), cls: 'tright' }, { label: pick('outstanding'), cls: 'tright' }
      ], rows, pick('noData')) + recon + '</div>';
  }

  function apTab(fx) {
    var ap = fx.ap, age = fx.apAgeing;
    var overdue = overdueAmount(age);
    var overdueCount = age.rows.filter(function (r) { return r.daysPastDue > 0; }).length;
    var kpis = kpiGrid([
      kpi('r', pick('totalPayables'), money0(ap.ap), pick('approvedRequests') + ' ' + money0(ap.paymentRequests)),
      kpi('y', pick('approvedRequests'), money0(ap.paymentRequests), ap.requestCount + ' ' + pick('invoices').toLowerCase()),
      kpi('b', pick('materialPayables'), money0(ap.materials), pick('pendingInvoices') + ' ' + money0(ap.payments)),
      kpi(overdue > 0 ? 'r' : 'g', pick('overdue'), money0(overdue), overdueCount + ' ' + pick('invoices').toLowerCase())
    ]);
    var rows = age.rows.map(function (r) {
      var typeLabel = r.type === 'payment_request' ? pick('paymentRequest') : r.type === 'material' ? pick('materials') : pick('supplierInvoice');
      var typeCls = r.type === 'payment_request' ? 'pur' : r.type === 'material' ? 'info' : 'mut';
      return '<tr>' +
        '<td><span class="tag ' + typeCls + '">' + esc(typeLabel) + '</span></td>' +
        '<td class="mono">' + esc(r.reference) + '</td>' +
        '<td>' + esc(r.party || '—') + '</td>' +
        '<td>' + esc(projectNameOf(fx, r.projectId)) + '</td>' +
        '<td class="mutc">' + (r.due ? fmtDate(r.due) : '—') + '</td>' +
        '<td class="tright mono ' + (r.daysPastDue > 0 ? 'badc' : 'mutc') + '">' + r.daysPastDue + '</td>' +
        '<td>' + bucketTag(r.bucket) + '</td>' +
        '<td class="tright mono"><b>' + money(r.amount) + '</b></td>' +
        '<td>' + tagForStatus(r.status) + '</td>' +
        '</tr>';
    });
    return kpis + ageingCard(age, ap.ap) +
      '<div class="card" style="margin-top:14px"><h3>' + esc(pick('payables')) + '</h3>' +
      tableHTML([
        { label: pick('payableType') }, { label: pick('reference') }, { label: pick('party') }, { label: pick('project') },
        { label: pick('dueDate') }, { label: pick('daysPastDue'), cls: 'tright' }, { label: pick('bucket') },
        { label: pick('amount'), cls: 'tright' }, { label: pick('status') }
      ], rows, pick('noData')) + '</div>';
  }

  function settingsCard(fx) {
    var st = fx.settings || {};
    var editable = canManage();
    var rows = [];
    function line(label, value) {
      rows.push('<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--line)"><span class="mutc">' + esc(label) + '</span><b class="mono">' + value + '</b></div>');
    }
    line(pick('fiscalYear'), esc(st.fiscalYear || '—'));
    line(pick('openingCash'), money(st.openingCash));
    line(pick('openingEquity'), money(st.openingEquity));
    if (st.notes) rows.push('<div class="mutc" style="margin-top:8px;font-size:11.5px">' + esc(st.notes) + '</div>');
    return '<div class="card"><h3>' + esc(pick('settings')) + '</h3>' + rows.join('') +
      (MOD.settingsMissing ? '<div class="mutc" style="font-size:11px;line-height:1.6;margin-top:8px;padding:8px;border:1px dashed var(--line);border-radius:8px">' + esc(pick('settingsNotInstalled')) + '</div>' : '') +
      (editable ? '<div style="margin-top:10px">' + actionBtn('edit-settings', pick('editSettings'), '✎') + '</div>' : '') + '</div>';
  }

  function bsTab(fx) {
    var bs = fx.bs;
    var kpis = kpiGrid([
      kpi('b', pick('totalAssets'), money0(bs.assets), pick('cashAndEquivalents') + ' ' + money0(bs.cash)),
      kpi('r', pick('totalLiabilities'), money0(bs.liabilities), pick('accountsPayable') + ' ' + money0(bs.ap)),
      kpi('g', pick('totalEquity'), money0(bs.equity), pick('currentPeriodResult') + ' ' + money0(bs.currentResult)),
      kpi(bs.balanced ? 'g' : 'r', pick('balanceIdentity'), money(bs.diff) + ' ' + (bs.balanced ? '✓' : '✗'),
        bs.balanced ? '<span class="tag ok">' + esc(pick('balanced')) + '</span>' : '<span class="tag bad">' + esc(pick('imbalance')) + '</span>')
    ]);
    function sectionRow(label) {
      return '<tr style="background:var(--panel2)"><td><b>' + esc(label) + '</b></td><td class="tright"></td></tr>';
    }
    function line(label, amount, cls) {
      return '<tr><td>' + esc(label) + '</td><td class="tright mono ' + (cls || '') + '">' + money(amount) + '</td></tr>';
    }
    function totalLine(label, amount, cls) {
      return '<tr style="font-weight:800"><td>' + esc(label) + '</td><td class="tright mono ' + (cls || '') + '">' + money(amount) + '</td></tr>';
    }
    var rows = [
      sectionRow(pick('assets')),
      line('  ' + pick('cashAndEquivalents'), bs.cash, 'okc'),
      line('  ' + pick('accountsReceivable'), bs.ar),
      totalLine(pick('totalAssets'), bs.assets, 'okc'),
      sectionRow(pick('liabilities')),
      line('  ' + pick('accountsPayable'), bs.ap),
      line('  ' + pick('retentionPayable'), bs.retentionPayable),
      line('  ' + pick('vatPayable'), bs.vatPayable),
      totalLine(pick('totalLiabilities'), bs.liabilities, 'badc'),
      sectionRow(pick('equity')),
      line('  ' + pick('openingEquity'), bs.openingEquity),
      line('  ' + pick('currentPeriodResult'), bs.currentResult),
      totalLine(pick('totalEquity'), bs.equity, 'okc'),
      '<tr><td>' + esc(pick('balanceIdentity')) + '</td><td class="tright">' + money(bs.diff) + ' ' +
        (bs.balanced ? '<span class="tag ok">' + esc(pick('balanced')) + '</span>' : '<span class="tag bad">' + esc(pick('imbalance')) + '</span>') + '</td></tr>'
    ];
    var cashRows = [
      line(pick('openingCash'), bs.openingCash),
      line(pick('cashMovement'), bs.cashMovement, bs.cashMovement >= 0 ? 'okc' : 'badc'),
      totalLine(pick('cashAndEquivalents'), bs.cash)
    ];
    return kpis +
      '<div class="grid" style="grid-template-columns:1fr 1fr">' +
      '<div class="card"><h3>' + esc(pick('balanceSheet')) + '</h3>' +
      tableHTML([{ label: pick('balanceSheet') }, { label: pick('amount'), cls: 'tright' }], rows, pick('noData')) + '</div>' +
      '<div>' + settingsCard(fx) +
      '<div class="card" style="margin-top:14px"><h3>' + esc(pick('cashPosition')) + '</h3>' +
      tableHTML([{ label: pick('cashAndEquivalents') }, { label: pick('amount'), cls: 'tright' }], cashRows, pick('noData')) +
      '<div style="margin-top:10px">' + actionBtn('print-all', pick('printAll'), '🖨') + '</div></div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:14px"><h3>' + esc(pick('derivation')) + '</h3>' +
      '<div class="mutc" style="font-size:11.5px;line-height:1.75">' + esc(pick('derivationNote')) + '</div></div>';
  }

  function pnlTab(fx) {
    var p = fx.pnl;
    var kpis = kpiGrid([
      kpi('g', pick('pnlRevenue'), money0(p.revenue), pick('periodResult') + ' ' + money0(p.revenueThisPeriod)),
      kpi('b', pick('directCost'), money0(p.directCost), pick('pnlMaterials') + ' ' + money0(p.materials) + ' · ' + pick('pnlLabour') + ' ' + money0(p.labour)),
      kpi(p.grossProfit >= 0 ? 'g' : 'r', pick('grossProfit'), money0(p.grossProfit), pick('grossMargin') + ' ' + pctText(p.grossMargin)),
      kpi('y', pick('overhead'), money0(p.expenses), ''),
      kpi(p.netProfit >= 0 ? 'g' : 'r', pick('netProfit'), money0(p.netProfit), pick('netMargin') + ' ' + pctText(p.netMargin))
    ]);
    function line(label, value, cls) {
      return '<tr><td>' + esc(label) + '</td><td class="tright mono ' + (cls || '') + '">' + value + '</td></tr>';
    }
    function total(label, value, cls) {
      return '<tr style="font-weight:800;background:var(--panel2)"><td>' + esc(label) + '</td><td class="tright mono ' + (cls || '') + '">' + value + '</td></tr>';
    }
    var rows = [
      total(pick('pnlRevenue'), money(p.revenue), 'okc'),
      line(pick('pnlMaterials'), money(p.materials)),
      line(pick('pnlLabour'), money(p.labour)),
      total(pick('directCost'), money(p.directCost)),
      line(pick('grossProfit'), money(p.grossProfit), p.grossProfit >= 0 ? 'okc' : 'badc'),
      line(pick('grossMargin'), pctText(p.grossMargin)),
      line(pick('overhead'), money(p.expenses)),
      total(pick('netProfit'), money(p.netProfit), p.netProfit >= 0 ? 'okc' : 'badc'),
      line(pick('netMargin'), pctText(p.netMargin)),
      line(pick('periodResult'), money(p.revenueThisPeriod))
    ];
    var projRows = p.projects.map(function (x) {
      return '<tr><td><b>' + esc((x.code ? x.code + ' · ' : '') + x.name) + '</b></td>' +
        '<td class="tright mono">' + money(x.revenue) + '</td>' +
        '<td class="tright mono mutc">' + money(x.materials) + '</td>' +
        '<td class="tright mono mutc">' + money(x.labour) + '</td>' +
        '<td class="tright mono mutc">' + money(x.expenses) + '</td>' +
        '<td class="tright mono">' + money(x.cost) + '</td>' +
        '<td class="tright mono ' + (x.profit >= 0 ? 'okc' : 'badc') + '"><b>' + money(x.profit) + '</b></td>' +
        '<td class="tright mono">' + pctText(x.margin) + '</td></tr>';
    });
    var budgetRows = (fx.data.budgetLines || []).map(function (b) {
      var v = round2(b.budget - b.actual);
      return '<tr><td><span class="tag mut">' + esc(b.category || '—') + '</span></td><td>' + esc(b.description || '—') + '</td>' +
        '<td class="tright mono">' + money(b.budget) + '</td><td class="tright mono">' + money(b.actual) + '</td>' +
        '<td class="tright mono ' + (v >= 0 ? 'okc' : 'badc') + '"><b>' + money(v) + '</b></td></tr>';
    });
    var budgetCard = budgetRows.length ? '<div class="card" style="margin-top:14px"><h3>' + esc(pick('budgetVsActual')) + '</h3>' +
      tableHTML([{ label: pick('budget') }, { label: '' }, { label: pick('budget'), cls: 'tright' }, { label: pick('actual'), cls: 'tright' }, { label: pick('variance'), cls: 'tright' }], budgetRows) + '</div>' : '';
    return kpis +
      '<div class="grid" style="grid-template-columns:1fr 1fr">' +
      '<div class="card"><h3>' + esc(pick('profitLoss')) + '</h3>' +
      tableHTML([{ label: pick('profitLoss') }, { label: pick('amount'), cls: 'tright' }], rows) + '</div>' +
      '<div class="card"><h3>' + esc(pick('projectProfitability')) + '</h3>' +
      tableHTML([
        { label: pick('project') }, { label: pick('pnlRevenue'), cls: 'tright' }, { label: pick('pnlMaterials'), cls: 'tright' },
        { label: pick('pnlLabour'), cls: 'tright' }, { label: pick('overhead'), cls: 'tright' }, { label: pick('directCost'), cls: 'tright' },
        { label: pick('netProfit'), cls: 'tright' }, { label: pick('netMargin'), cls: 'tright' }
      ], projRows, pick('noData')) +
      '<div class="mutc" style="font-size:11px;line-height:1.6;margin-top:10px">' + esc(pick('vatExcludedNote')) + '</div></div>' +
      '</div>' + budgetCard;
  }

  function warningsHTML() {
    if (!MOD.warnings || !MOD.warnings.length) return '';
    var hard = MOD.warnings.filter(function (w) { return !w.optional; });
    if (!hard.length) return '';
    return '<div class="card" style="margin-bottom:14px;border-color:rgba(210,153,34,.45)">' +
      '<h3>⚠ ' + esc(pick('failed')) + '</h3>' +
      '<div class="mutc" style="font-size:11.5px;line-height:1.7">' +
      hard.map(function (w) { return esc(w.table) + ' — ' + esc(w.message); }).join('<br>') + '</div></div>';
  }

  function buildView() {
    var fx = compute(MOD.data || {}, { today: MOD.asOf || todayStr(), settings: MOD.settingsRow, lang: currentLang() });
    var tabs = [
      { key: 'ar', label: pick('tab_ar') }, { key: 'ap', label: pick('tab_ap') },
      { key: 'bs', label: pick('tab_bs') }, { key: 'pnl', label: pick('tab_pnl') }
    ];
    var tabHtml = '<div class="settings-tabs" role="tablist">' + tabs.map(function (tb) {
      var on = MOD.tab === tb.key;
      return '<button type="button" role="tab" class="stab' + (on ? ' on' : '') + '" aria-selected="' + (on ? 'true' : 'false') +
        '" data-sf-tab="' + tb.key + '">' + esc(tb.label) + '</button>';
    }).join('') + '</div>';
    var companyName = (S.company && S.company.name) || '—';
    var head = '<h2 class="vt">📊 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(companyName) + ' · ' + esc(pick('asOf')) + ' ' + fmtDate(fx.asOf) + ' · ' +
      esc(pick('subtitle')) + '<span class="spacer"></span>' +
      actionBtn('refresh', pick('refresh'), '⟳') + ' ' +
      actionBtn('export-csv', pick('exportCsv'), '⬇') + ' ' +
      actionBtn('print', pick('print'), '🖨') + '</div>';
    var body;
    if (MOD.tab === 'ap') body = apTab(fx);
    else if (MOD.tab === 'bs') body = bsTab(fx);
    else if (MOD.tab === 'pnl') body = pnlTab(fx);
    else body = arTab(fx);
    return '<div data-sf-finance="' + esc(MOD.tab) + '">' + head + warningsHTML() + tabHtml + '<div role="tabpanel">' + body + '</div></div>';
  }

  function bind(el) {
    function on(selector, type, handler) {
      Array.prototype.forEach.call(el.querySelectorAll(selector), function (node) {
        node.addEventListener(type, function (ev) {
          try { handler(node, ev); } catch (e) { UI.toast(pick('failed') + ': ' + (e && e.message || 'error'), 'bad'); }
        });
      });
    }
    on('[data-sf-tab]', 'click', function (node) {
      MOD.tab = node.getAttribute('data-sf-tab') || 'ar';
      if (MOD.data) paint(MOD.el); else startRender(MOD.el);
    });
    on('[data-sf-action]', 'click', function (node) {
      var action = node.getAttribute('data-sf-action');
      if (action === 'refresh') { MOD.stale = true; startRender(MOD.el); }
      else if (action === 'export-csv') exportCurrent();
      else if (action === 'print') printCurrent('current');
      else if (action === 'print-all') printCurrent('all');
      else if (action === 'edit-settings') openSettingsForm();
    });
  }

  function paint(el) {
    if (!el || !el.querySelector) return;
    if (!el.querySelector('[data-sf-finance]')) return; /* view changed under us */
    try {
      el.innerHTML = buildView();
      bind(el);
    } catch (e) {
      el.innerHTML = errorHTML(e);
    }
  }
  function errorHTML(e) {
    var msg = (e && e.message) || String(e) || 'Unexpected error';
    return '<div data-sf-finance="error"><h2 class="vt">📊 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><h3>⚠ ' + esc(pick('failed')) + '</h3>' +
      '<p class="badc">' + esc(msg) + '</p>' +
      '<p class="mutc" style="font-size:11px;margin-top:8px">' + esc(pick('subtitle')) + '</p></div></div>';
  }
  function loadingHTML() {
    return '<div data-sf-finance="loading"><h2 class="vt">📊 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('subtitle')) + '</div>' +
      '<div class="card"><div class="empty"><div class="big">📊</div>' + esc(pick('loading')) + '</div></div></div>';
  }
  function startRender(el) {
    if (!el || typeof el.innerHTML !== 'string') return;
    MOD.el = el;
    el.innerHTML = loadingHTML();
    var token = ++MOD.token;
    loadData().then(function (res) {
      if (token !== MOD.token) return;
      MOD.data = res.data;
      MOD.settingsRow = res.settingsRow;
      MOD.settingsMissing = res.settingsMissing;
      MOD.warnings = res.warnings;
      MOD.asOf = todayStr();
      MOD.stale = false;
      paint(el);
    }).catch(function (e) {
      if (token !== MOD.token) return;
      try { el.innerHTML = errorHTML(e); } catch (e2) { /* give up silently */ }
    });
  }

  /* ------------------------------------------------------------- actions */
  function exportCurrent() {
    try {
      if (!MOD.data) { UI.toast(pick('loading')); return; }
      var fx = compute(MOD.data, { today: MOD.asOf || todayStr(), settings: MOD.settingsRow, lang: currentLang() });
      var rows = csvRowsFor(MOD.tab, fx, currentLang());
      downloadCSV('finance_' + MOD.tab + '_' + fx.asOf + '.csv', rows);
      UI.toast('Exported ✓', 'ok');
    } catch (e) {
      UI.toast(pick('failed') + ': ' + (e && e.message || 'error'), 'bad');
    }
  }
  function printCurrent(mode) {
    try {
      if (!MOD.data) { UI.toast(pick('loading')); return; }
      var html = printHTML(mode === 'all' ? 'all' : MOD.tab, MOD.data, {
        lang: currentLang(),
        today: MOD.asOf || todayStr(),
        company: S.company || {},
        settings: MOD.settingsRow
      });
      var win = null;
      try { win = window.open('', '_blank'); } catch (e) { win = null; }
      if (!win) { UI.toast(pick('popupBlocked'), 'bad'); return; }
      win.document.write(html);
      win.document.close();
      setTimeout(function () { try { win.focus(); win.print(); } catch (e) {} }, 400);
    } catch (e) {
      UI.toast(pick('failed') + ': ' + (e && e.message || 'error'), 'bad');
    }
  }
  function openSettingsForm() {
    if (!canManage()) { UI.toast(pick('managerOnly'), 'bad'); return; }
    if (!UI.openFormModal) { UI.toast(pick('failed'), 'bad'); return; }
    var st = MOD.settingsRow || {};
    var year = Number(st.fiscal_year) || new Date().getFullYear();
    UI.openFormModal({
      title: '✎ ' + pick('editSettings'),
      wide: true,
      values: {
        fiscal_year: year,
        opening_cash_aed: num(st.opening_cash_aed),
        opening_equity_aed: num(st.opening_equity_aed),
        notes: st.notes || ''
      },
      fields: [
        { key: 'fiscal_year', label: pick('fiscalYear'), type: 'number', step: '1', required: true },
        { key: 'opening_cash_aed', label: pick('openingCashAed'), type: 'number', step: '0.01' },
        { key: 'opening_equity_aed', label: pick('openingEquityAed'), type: 'number', step: '0.01' },
        { key: 'notes', label: pick('notes'), type: 'textarea', rows: 2, full: true }
      ],
      onSubmit: function (values) {
        var payload = {
          company_id: (S.company && S.company.id) || null,
          fiscal_year: Number(values.fiscal_year) || year,
          opening_cash_aed: round2(values.opening_cash_aed),
          opening_equity_aed: round2(values.opening_equity_aed),
          notes: values.notes || null
        };
        var write = st.id ? DB.update('finance_settings', st.id, payload) : DB.insert('finance_settings', payload);
        return Promise.resolve(write).then(function () {
          MOD.stale = true;
          UI.toast(pick('savedOk'), 'ok');
          if (MOD.el) startRender(MOD.el);
        }).catch(function (e) {
          var msg = (e && e.message) || String(e);
          throw new Error(isMissingTable(e) ? pick('settingsNotInstalled') : msg);
        });
      }
    });
  }

  /* ==========================================================================
     PUBLIC PURE API (tests call these with fixture rows via CDP evaluate)
     ========================================================================== */
  window.SF_modules = window.SF_modules || {};
  window.SF_modules.finance = {
    /* Required surface */
    ageing: ageing,
    arTotal: arTotal,
    apTotal: apTotal,
    balanceSheet: balanceSheet,
    pnl: pnl,
    /* Additional deterministic helpers used by checks / UI */
    arAgeing: function (data, opts) { return arAgeingOf(normData(data), opts || {}); },
    apAgeing: function (data, opts) { return apAgeingOf(normData(data), opts || {}); },
    compute: compute,
    normalize: normData,
    csvCell: csvCell,
    buildCSV: buildCSV,
    printHTML: printHTML,
    money: money,
    money0: money0,
    round2: round2,
    bucketFor: bucketFor,
    dayIndex: dayIndex,
    version: 1
  };

  /* ==========================================================================
     VIEW REGISTRATION
     ========================================================================== */
  S.registerView({
    id: 'finance',
    nav: { section: 'company', icon: '📊', label: 'Financial Accounts', labelAr: 'الحسابات المالية' },
    roles: ['director', 'controller'],
    render: function (el) {
      try {
        MOD.el = el;
        if (MOD.data && !MOD.stale) {
          /* Cached data: paint directly. The marker lets paint() verify the view
           * still owns <main> before it writes. */
          el.innerHTML = '<div data-sf-finance="' + esc(MOD.tab) + '"></div>';
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
