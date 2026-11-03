/* SiteForge module: Payroll Payslips.
 * Contract: docs/modules/CONTRACT.md — owner: payslips teammate.
 *
 * Printable payslips, batch generated from approved timesheets for a project +
 * period (YYYY-MM). Saved rows live in public.payslips (migration
 * supabase/migrations/202611031003_payslips.sql) and are upserted on
 * (project_id, worker_id, period) so generating/saving the same period twice is
 * idempotent.
 *
 * Calculation source of truth (exact, 2dp):
 *   otRate          = round(hourly_rate * 1.5, 2)
 *   gross           = round(reg_hours*hourly_rate + ot_hours*otRate, 2)
 *   loanDeduction   = min(max(0, loan_balance), max(0, gross))
 *   otherDeductions = max(0, input)
 *   net             = max(0, round(gross - loanDeduction - otherDeductions, 2))
 *   shortfall       = max(0, loan_balance - loanDeduction)  -> notes (carried forward)
 * Negative hours/rates/deductions are clamped to 0 and reported as warnings,
 * never silently accepted.
 *
 * Pure helpers are exposed for the test suite:
 *   window.SF_modules.payslips = {computeLine, computeTotals, otRate, ...}
 */
(function () {
  'use strict';
  if (!window.SF) return;

  var S = window.SF;
  var H = S.helpers || {};
  var DB = S.db || {};
  var UI = S.ui || {};
  var MIGRATION = 'supabase/migrations/202611031003_payslips.sql';
  var VIEW_ID = 'payslips';

  /* ------------------------------------------------------------------ *
   * i18n (EN + AR; falls back to English)                              *
   * ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Payslips',
      sub: 'Printable payroll payslips · batch generated from approved timesheets',
      period: 'Period',
      generate: '⚙ Generate from timesheets',
      printAll: '🖨 Print all',
      save: '💾 Save batch',
      discard: 'Discard preview',
      loading: 'Loading…',
      preview: 'Preview — generated from approved timesheets',
      previewHint: 'Edit any value, then save. Saving again for the same period updates existing payslips (unique project + worker + period).',
      saved: 'Saved payslips',
      workers: 'Payslips',
      gross: 'Gross',
      deductions: 'Deductions',
      net: 'Net pay',
      worker: 'Worker',
      staffNo: 'Staff #',
      days: 'Days',
      regHours: 'Reg hours',
      otHours: 'OT hours',
      rate: 'Rate (AED/h)',
      otRate: 'OT rate (AED/h)',
      grossCol: 'Gross',
      loanCol: 'Loan deduction',
      otherCol: 'Other deductions',
      netCol: 'Net pay',
      status: 'Status',
      actions: 'Actions',
      empty: 'No payslips saved for this period yet.',
      emptyHint: 'Pick a period, generate from approved timesheets, review the preview, then save the batch.',
      noTimesheets: 'No approved timesheets found for this period.',
      noProject: 'Select a project to manage its payslips.',
      migrationTitle: 'This module needs a database update.',
      migrationRun: 'Run',
      migrationAfter: 'in the Supabase SQL editor, then reload this page.',
      unmatched: 'No matching worker record',
      mixedRates: 'Mixed timesheet rates averaged',
      salaryFallback: 'Hourly rate derived from monthly salary',
      negativeHours: 'Negative hours clamped to 0',
      negativeRate: 'Negative rate clamped to 0',
      negativeDeduction: 'Negative deduction clamped to 0',
      noRate: 'No hourly rate on timesheets',
      shortfall: 'Loan shortfall',
      carriedForward: 'carried forward',
      draft: 'Draft',
      approved: 'Approved',
      paid: 'Paid',
      approve: 'Approve',
      markPaid: 'Mark paid',
      delete: 'Delete',
      print: 'Print',
      removeLine: 'Remove line',
      accessDenied: 'Access denied — manager permission required',
      confirmDelete: 'Delete this payslip? This cannot be undone.',
      savedOk: 'payslip(s) saved',
      saveFailed: 'Save failed',
      actionFailed: 'Action failed',
      printFailed: 'Nothing to print for this period',
      totals: 'Totals',
      notesCol: 'Notes',
      generated: 'Generated',
      companyFallback: 'SITEFORGE',
      slipTitle: 'PAYSLIP',
      earnings: 'Earnings',
      deductionTable: 'Deductions',
      description: 'Description',
      hours: 'Hours',
      amount: 'Amount (AED)',
      netPayable: 'NET PAYABLE',
      signature: 'Signature',
      employee: 'Employee',
      preparedBy: 'Prepared by',
      approvedBy: 'Approved by',
      computerGenerated: 'This is a computer-generated payslip and does not require a stamp.',
      periodLbl: 'Pay period',
      daysWorked: 'Days worked',
      nationality: 'Nationality',
      trade: 'Trade'
    },
    ar: {
      title: 'قسائم الرواتب',
      sub: 'قسائم رواتب قابلة للطباعة · تُنشأ دفعةً واحدة من كشوف الوقت المعتمدة',
      period: 'الفترة',
      generate: '⚙ توليد من كشوف الوقت',
      printAll: '🖨 طباعة الكل',
      save: '💾 حفظ الدفعة',
      discard: 'إلغاء المعاينة',
      loading: 'جار التحميل…',
      preview: 'معاينة — مولّدة من كشوف الوقت المعتمدة',
      previewHint: 'عدّل أي قيمة ثم احفظ. الحفظ مرة أخرى لنفس الفترة يحدّث القسائم الموجودة (مفتاح فريد: المشروع + العامل + الفترة).',
      saved: 'قسائم الرواتب المحفوظة',
      workers: 'القسائم',
      gross: 'الإجمالي',
      deductions: 'الاستقطاعات',
      net: 'الصافي',
      worker: 'العامل',
      staffNo: 'رقم الموظف',
      days: 'الأيام',
      regHours: 'ساعات عادية',
      otHours: 'ساعات إضافية',
      rate: 'الأجر (درهم/ساعة)',
      otRate: 'أجر العمل الإضافي',
      grossCol: 'الإجمالي',
      loanCol: 'استقطاع السلفة',
      otherCol: 'استقطاعات أخرى',
      netCol: 'الصافي',
      status: 'الحالة',
      actions: 'إجراءات',
      empty: 'لا توجد قسائم محفوظة لهذه الفترة بعد.',
      emptyHint: 'اختر الفترة، ولّد من كشوف الوقت المعتمدة، راجع المعاينة، ثم احفظ الدفعة.',
      noTimesheets: 'لا توجد كشوف وقت معتمدة لهذه الفترة.',
      noProject: 'اختر مشروعًا لإدارة قسائم رواتبه.',
      migrationTitle: 'هذا الجزء يحتاج تحديثًا لقاعدة البيانات.',
      migrationRun: 'شغّل',
      migrationAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      unmatched: 'لا يوجد سجل عامل مطابق',
      mixedRates: 'تم حساب متوسط أسعار كشوف الوقت المختلفة',
      salaryFallback: 'الأجر بالساعة مشتق من الراتب الشهري',
      negativeHours: 'تم ضبط الساعات السالبة إلى صفر',
      negativeRate: 'تم ضبط الأجر السالب إلى صفر',
      negativeDeduction: 'تم ضبط الاستقطاع السالب إلى صفر',
      noRate: 'لا يوجد أجر بالساعة في كشوف الوقت',
      shortfall: 'عجز السلفة',
      carriedForward: 'يُرحّل للفترة القادمة',
      draft: 'مسودة',
      approved: 'معتمدة',
      paid: 'مدفوعة',
      approve: 'اعتماد',
      markPaid: 'تحديد كمدفوعة',
      delete: 'حذف',
      print: 'طباعة',
      removeLine: 'حذف السطر',
      accessDenied: 'الوصول مرفوض — مطلوب صلاحية مدير',
      confirmDelete: 'حذف قسيمة الراتب هذه؟ لا يمكن التراجع.',
      savedOk: 'قسيمة رواتب محفوظة',
      saveFailed: 'فشل الحفظ',
      actionFailed: 'فشل الإجراء',
      printFailed: 'لا يوجد ما يمكن طباعته لهذه الفترة',
      totals: 'المجاميع',
      notesCol: 'ملاحظات',
      generated: 'أُنشئت',
      companyFallback: 'سايت فورج',
      slipTitle: 'قسيمة راتب',
      earnings: 'الاستحقاقات',
      deductionTable: 'الاستقطاعات',
      description: 'البيان',
      hours: 'الساعات',
      amount: 'المبلغ (درهم)',
      netPayable: 'صافي المستحق',
      signature: 'التوقيع',
      employee: 'الموظف',
      preparedBy: 'أعدّها',
      approvedBy: 'اعتمدها',
      computerGenerated: 'هذه القسيمة صادرة آليًا ولا تحتاج إلى ختم.',
      periodLbl: 'فترة الأجر',
      daysWorked: 'أيام العمل',
      nationality: 'الجنسية',
      trade: 'المهنة'
    }
  };
  function isAr() { return S.language === 'ar'; }
  function pick(k) {
    var pack = isAr() ? L.ar : L.en;
    return (pack && pack[k]) || L.en[k] || k;
  }

  /* ------------------------------------------------------------------ *
   * Numeric core (pure — exposed for tests)                            *
   * ------------------------------------------------------------------ */
  function toNum(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  /* Round to 2dp without the 1.005-style binary surprise (money values are
     non-negative here, but keep it sign-safe for reuse). */
  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    var sign = v < 0 ? -1 : 1;
    return sign * Math.round((Math.abs(v) + 1e-9) * 100) / 100;
  }
  function otRate(hourlyRate) {
    return round2(Math.max(0, toNum(hourlyRate, 0)) * 1.5);
  }
  function warningsFor(input) {
    var out = [];
    if (toNum(input.reg_hours, 0) < 0 || toNum(input.ot_hours, 0) < 0) out.push(pick('negativeHours'));
    if (toNum(input.hourly_rate != null ? input.hourly_rate : input.rate, 0) < 0) out.push(pick('negativeRate'));
    if (toNum(input.other_deductions, 0) < 0) out.push(pick('negativeDeduction'));
    if (toNum(input.loan_balance, 0) < 0) out.push('Negative loan balance clamped to 0');
    return out;
  }
  /**
   * computeLine(input) -> normalised payslip line.
   * input: {worker_id?, worker_name?, staff_no?, nationality?, trade?, days_worked?,
   *         reg_hours, ot_hours, hourly_rate (or rate), loan_balance, other_deductions}
   * Identity fields are passed through. Never throws.
   */
  function computeLine(input) {
    input = input || {};
    var warnings = warningsFor(input);
    var rate = round2(Math.max(0, toNum(input.hourly_rate != null ? input.hourly_rate : input.rate, 0)));
    var reg = round2(Math.max(0, toNum(input.reg_hours, 0)));
    var ot = round2(Math.max(0, toNum(input.ot_hours, 0)));
    var otR = otRate(rate);
    var gross = round2(reg * rate + ot * otR);
    var loanBalance = round2(Math.max(0, toNum(input.loan_balance, 0)));
    var loanDeduction = round2(Math.min(loanBalance, Math.max(0, gross)));
    var otherDeductions = round2(Math.max(0, toNum(input.other_deductions, 0)));
    var net = Math.max(0, round2(gross - loanDeduction - otherDeductions));
    var shortfall = round2(Math.max(0, loanBalance - loanDeduction));
    var days = round2(Math.max(0, toNum(input.days_worked, 0)));
    if (gross > 0 && rate <= 0) warnings.push(pick('noRate'));
    return {
      worker_id: input.worker_id || null,
      worker_name: String(input.worker_name == null ? '' : input.worker_name),
      staff_no: String(input.staff_no == null ? '' : input.staff_no),
      nationality: String(input.nationality == null ? '' : input.nationality),
      trade: String(input.trade == null ? '' : input.trade),
      matched: input.matched !== false && !!input.matched,
      days_worked: days,
      reg_hours: reg,
      ot_hours: ot,
      hourly_rate: rate,
      ot_rate: otR,
      gross: gross,
      loan_balance: loanBalance,
      loan_deduction: loanDeduction,
      other_deductions: otherDeductions,
      net: net,
      shortfall: shortfall,
      warnings: warnings
    };
  }
  /** computeTotals(lines) -> sums for a batch (all 2dp). */
  function computeTotals(lines) {
    var out = { count: 0, days_worked: 0, reg_hours: 0, ot_hours: 0, gross: 0, loan_deduction: 0, other_deductions: 0, net: 0, shortfall: 0 };
    (lines || []).forEach(function (line) {
      if (!line) return;
      out.count++;
      out.days_worked = round2(out.days_worked + toNum(line.days_worked, 0));
      out.reg_hours = round2(out.reg_hours + toNum(line.reg_hours, 0));
      out.ot_hours = round2(out.ot_hours + toNum(line.ot_hours, 0));
      out.gross = round2(out.gross + toNum(line.gross, 0));
      out.loan_deduction = round2(out.loan_deduction + toNum(line.loan_deduction, 0));
      out.other_deductions = round2(out.other_deductions + toNum(line.other_deductions, 0));
      out.net = round2(out.net + toNum(line.net, 0));
      out.shortfall = round2(out.shortfall + toNum(line.shortfall, 0));
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Worker pay parsing (defensive: packed <!--sfpay:…--> JSON, legacy  *
   * whole-notes JSON, or plain columns)                                *
   * ------------------------------------------------------------------ */
  function numFrom(obj, keys) {
    if (!obj) return null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '' && isFinite(Number(obj[k]))) return Number(obj[k]);
    }
    return null;
  }
  /**
   * parseWorkerPay(notes) -> {salary, loan, deduct, notes, source}
   * Handles: <!--sfpay:{"salary":..,"loan":..,"deduct":..}-->\n<body>
   *          legacy raw JSON notes {"salary_aed":..,"loan_balance":..,"loan_deduction":..}
   *          (also accepts salary/loan/deduct keys) and plain text notes.
   */
  function parseWorkerPay(notes) {
    var out = { salary: 0, loan: 0, deduct: 0, notes: '', source: 'none' };
    var text = notes === null || notes === undefined ? '' : String(notes);
    var payload = null;
    var m = text.match(/^\s*<!--sfpay:([\s\S]*?)-->\s*/);
    if (m) {
      try { payload = JSON.parse(m[1]); out.source = 'packed'; } catch (e) { payload = null; }
      text = text.slice(m[0].length);
    } else {
      var trimmed = text.replace(/^\s+|\s+$/g, '');
      if (trimmed.charAt(0) === '{') {
        try { payload = JSON.parse(trimmed); out.source = 'json'; text = ''; } catch (e) { payload = null; }
      }
    }
    if (payload && typeof payload === 'object') {
      var salary = numFrom(payload, ['salary_aed', 'salary', 'monthly_salary_aed', 'monthly_salary']);
      var loan = numFrom(payload, ['loan_balance', 'loan', 'loan_balance_aed']);
      var deduct = numFrom(payload, ['loan_deduction', 'deduct', 'loan_deduction_aed']);
      if (salary !== null) out.salary = salary;
      if (loan !== null) out.loan = loan;
      if (deduct !== null) out.deduct = deduct;
    }
    out.notes = text;
    return out;
  }
  /** Worker row -> pay + identity, falling back to raw columns when notes has no JSON. */
  function workerPayOf(worker) {
    var pay = parseWorkerPay(worker && worker.notes);
    var salary = pay.salary;
    var loan = pay.loan;
    var deduct = pay.deduct;
    if (!salary && worker && worker.salary_aed !== undefined) salary = Math.max(0, toNum(worker.salary_aed, 0));
    if (!loan && worker && worker.loan_balance !== undefined) loan = Math.max(0, toNum(worker.loan_balance, 0));
    if (!deduct && worker && worker.loan_deduction !== undefined) deduct = Math.max(0, toNum(worker.loan_deduction, 0));
    return { salary: salary || 0, loan: loan || 0, deduct: deduct || 0, notes: pay.notes };
  }
  function normName(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').toLowerCase();
  }
  function stateOf() { return (S.data && S.data.state) || {}; }
  function companyOf() { return S.company || stateOf().company || {}; }

  /* ------------------------------------------------------------------ *
   * Timesheet -> candidate payslip lines                               *
   * ------------------------------------------------------------------ */
  function normalizeTimesheet(x) {
    x = x || {};
    return {
      name: String(x.name != null ? x.name : (x.employee_name != null ? x.employee_name : '')).replace(/^\s+|\s+$/g, ''),
      date: String(x.date || x.work_date || ''),
      reg: Math.max(0, toNum(x.regHours != null ? x.regHours : x.reg_hours, 0)),
      ot: Math.max(0, toNum(x.otHours != null ? x.otHours : x.ot_hours, 0)),
      rate: Math.max(0, toNum(x.rate != null ? x.rate : x.rate_aed, 0)),
      cost: toNum(x.cost != null ? x.cost : x.total_cost_aed, 0),
      status: String(x.status == null ? '' : x.status).toLowerCase(),
      trade: x.trade || '',
      staff_no: String(x.staff_no || x.employee_staff_no || ''),
      email: String(x.email || x.employee_email || '')
    };
  }
  function matchWorker(name, tsList, workers) {
    var key = normName(name);
    var workersArr = workers || [];
    var i;
    var fallbackStaff = '';
    var fallbackEmail = '';
    (tsList || []).forEach(function (row) {
      if (normName(row.name) !== key) return;
      if (row.staff_no && !fallbackStaff) fallbackStaff = normName(row.staff_no);
      if (row.email && !fallbackEmail) fallbackEmail = normName(row.email);
    });
    for (i = 0; i < workersArr.length; i++) {
      if (normName(workersArr[i].name) === key) return workersArr[i];
    }
    if (fallbackStaff) {
      for (i = 0; i < workersArr.length; i++) {
        if (workersArr[i].staff_no && normName(workersArr[i].staff_no) === fallbackStaff) return workersArr[i];
      }
    }
    if (fallbackEmail) {
      for (i = 0; i < workersArr.length; i++) {
        if (workersArr[i].email && normName(workersArr[i].email) === fallbackEmail) return workersArr[i];
      }
    }
    return null;
  }
  /**
   * buildLines({period, timesheets, workers}) -> candidate lines grouped by
   * employee name from APPROVED timesheets in that period, merged with workers.
   * Pure (does not read live state when all inputs are supplied).
   */
  function buildLines(opts) {
    opts = opts || {};
    var period = String(opts.period || '');
    var timesheets = (opts.timesheets || stateOf().timesheets || []).map(normalizeTimesheet);
    var workers = opts.workers || stateOf().workers || [];
    var groups = {};
    var order = [];
    timesheets.forEach(function (x) {
      if (x.status !== 'approved') return;
      if (x.date.slice(0, 7) !== period) return;
      if (!x.name) return;
      var key = normName(x.name);
      if (!groups[key]) {
        groups[key] = { name: x.name, reg: 0, ot: 0, cost: 0, rateWeighted: 0, rates: {}, trades: {}, dates: {}, rows: 0, staff_no: '', email: '' };
        order.push(key);
      }
      var g = groups[key];
      g.reg += x.reg;
      g.ot += x.ot;
      g.cost += x.cost;
      g.rateWeighted += x.reg * x.rate;
      g.rates[x.rate] = true;
      g.rows++;
      if (x.trade) g.trades[String(x.trade)] = true;
      if (x.date) g.dates[x.date] = true;
      if (!g.staff_no && x.staff_no) g.staff_no = x.staff_no;
      if (!g.email && x.email) g.email = x.email;
    });
    var lines = [];
    order.forEach(function (key) {
      var g = groups[key];
      var worker = matchWorker(g.name, timesheets, workers);
      var rate = g.reg > 0 ? round2(g.rateWeighted / g.reg) : 0;
      var extraWarnings = [];
      if (Object.keys(g.rates).length > 1) extraWarnings.push(pick('mixedRates'));
      var pay = worker ? workerPayOf(worker) : null;
      if (pay && rate <= 0 && pay.salary > 0) {
        rate = round2(pay.salary / 208);
        extraWarnings.push(pick('salaryFallback') + ' (208 h/mo)');
      }
      if (!worker) extraWarnings.push(pick('unmatched') + ' — will save with name only');
      var line = computeLine({
        worker_id: worker ? worker.id : null,
        worker_name: g.name,
        staff_no: (worker && worker.staff_no) || g.staff_no || '',
        nationality: worker ? worker.nationality || '' : '',
        trade: worker ? worker.trade || worker.role || '' : String(Object.keys(g.trades)[0] || ''),
        matched: !!worker,
        days_worked: Object.keys(g.dates).length,
        reg_hours: g.reg,
        ot_hours: g.ot,
        hourly_rate: rate,
        loan_balance: pay ? pay.loan : 0,
        other_deductions: 0
      });
      line._extraWarnings = extraWarnings;
      line.warnings = line.warnings.concat(extraWarnings);
      line.source_rows = g.rows;
      lines.push(line);
    });
    return lines;
  }

  /* ------------------------------------------------------------------ *
   * Persistence                                                        *
   * ------------------------------------------------------------------ */
  function money(n) { return H.money ? H.money(n) : 'AED ' + (Number(n) || 0).toFixed(2); }
  function esc(v) {
    if (H.esc) return H.esc(v);
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeImg(src) { return H.safeImgSrc ? H.safeImgSrc(src) : ''; }
  function fmtDate(v) { return H.fmtDate ? H.fmtDate(v) : String(v || '—'); }
  function todayStr() { return H.today ? H.today() : new Date().toISOString().slice(0, 10); }
  function errText(err) {
    return String((err && (err.message || err.error_description || err.hint)) || err || 'Unknown error');
  }
  function isMissingTable(err) {
    var m = errText(err).toLowerCase();
    return m.indexOf('payslips') >= 0 && (m.indexOf('does not exist') >= 0 || m.indexOf('could not find the table') >= 0 || m.indexOf('schema cache') >= 0 || m.indexOf('relation') >= 0 || m.indexOf('404') >= 0);
  }
  function notesForLine(line, period) {
    var parts = [];
    if (toNum(line.shortfall, 0) > 0) {
      parts.push('Loan shortfall: ' + money(toNum(line.shortfall, 0)) + ' carried forward to next period.');
    }
    if (toNum(line.loan_balance, 0) > 0) {
      parts.push('Loan balance before deduction: ' + money(toNum(line.loan_balance, 0)) + '.');
    }
    if (line.warnings && line.warnings.length) parts.push('Warnings: ' + line.warnings.join('; ') + '.');
    parts.push('Generated from approved timesheets for ' + period + '.');
    return parts.join(' ');
  }
  function toDbRow(line, period, projectId) {
    return {
      project_id: projectId,
      worker_id: line.worker_id || null,
      worker_name: String(line.worker_name == null ? '' : line.worker_name).replace(/^\s+|\s+$/g, ''),
      staff_no: line.staff_no || null,
      period: period,
      days_worked: round2(toNum(line.days_worked, 0)),
      reg_hours: round2(toNum(line.reg_hours, 0)),
      ot_hours: round2(toNum(line.ot_hours, 0)),
      hourly_rate_aed: round2(toNum(line.hourly_rate, 0)),
      ot_rate_aed: round2(toNum(line.ot_rate, 0)),
      gross_aed: round2(toNum(line.gross, 0)),
      loan_deduction_aed: round2(toNum(line.loan_deduction, 0)),
      other_deductions_aed: round2(toNum(line.other_deductions, 0)),
      net_aed: round2(toNum(line.net, 0)),
      notes: notesForLine(line, period)
      /* status / paid_at / created_at intentionally omitted: DB defaults on
         insert, and an upsert on conflict must not reset an approved/paid row. */
    };
  }
  function normalizeSaved(row) {
    row = row || {};
    return {
      id: row.id,
      project_id: row.project_id,
      worker_id: row.worker_id || null,
      worker_name: String(row.worker_name == null ? '' : row.worker_name),
      staff_no: String(row.staff_no == null ? '' : row.staff_no),
      period: String(row.period || ''),
      days_worked: toNum(row.days_worked, 0),
      reg_hours: toNum(row.reg_hours, 0),
      ot_hours: toNum(row.ot_hours, 0),
      hourly_rate: toNum(row.hourly_rate_aed, 0),
      ot_rate: toNum(row.ot_rate_aed, 0),
      gross: toNum(row.gross_aed, 0),
      loan_deduction: toNum(row.loan_deduction_aed, 0),
      other_deductions: toNum(row.other_deductions_aed, 0),
      net: toNum(row.net_aed, 0),
      status: String(row.status || 'draft'),
      paid_at: row.paid_at || null,
      notes: String(row.notes == null ? '' : row.notes),
      created_at: row.created_at || null,
      /* aliases so row objects work with buildPrintHtml/computeTotals too */
      notes_raw: row.notes == null ? '' : row.notes
    };
  }
  /** Load saved payslips for one period. Returns {rows, error}. */
  async function loadSaved(period, projectId) {
    var pid = projectId || S.currentProjectId;
    if (!pid) return { rows: [], error: null };
    period = period || st.period;
    var r = await DB.selectStrict('payslips', { project_id: pid, period: period }, 'created_at', true);
    if (r && r.error) return { rows: [], error: r.error };
    return { rows: (r && r.rows ? r.rows : []).map(normalizeSaved), error: null };
  }
  function identityFor(slip) {
    var workers = stateOf().workers || [];
    var i;
    if (slip.worker_id) {
      for (i = 0; i < workers.length; i++) if (workers[i].id === slip.worker_id) return workers[i];
    }
    var key = normName(slip.worker_name);
    for (i = 0; i < workers.length; i++) if (normName(workers[i].name) === key) return workers[i];
    return null;
  }
  /** Reconcile rows by worker_id or worker_name; used for NULL worker_id rows
      (Postgres unique keys treat NULLs as distinct, so onConflict cannot apply). */
  async function reconcileRows(rows, period, projectId, matchByWorker) {
    var existing = await loadSaved(period, projectId);
    if (existing.error) throw new Error(errText(existing.error));
    var byWorker = {};
    var byName = {};
    existing.rows.forEach(function (r) {
      if (r.worker_id) byWorker[String(r.worker_id)] = r;
      else byName[normName(r.worker_name)] = r;
    });
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hit = matchByWorker && row.worker_id ? byWorker[String(row.worker_id)] : byName[normName(row.worker_name)];
      if (hit) {
        var payload = Object.assign({}, row);
        delete payload.project_id;
        await DB.update('payslips', hit.id, payload);
      } else {
        await DB.insert('payslips', Object.assign({}, row, { status: 'draft' }));
      }
    }
  }
  async function upsertMatched(rows, period, projectId) {
    if (typeof DB.upsert === 'function') {
      var res = await DB.upsert('payslips', rows, 'project_id,worker_id,period');
      if (res && res.error) throw new Error(errText(res.error));
      return;
    }
    var client = DB.client && DB.client();
    if (client && typeof client.from === 'function') {
      try {
        var q = client.from('payslips');
        if (q && typeof q.upsert === 'function') {
          var r = await q.upsert(rows, { onConflict: 'project_id,worker_id,period' });
          if (r && r.error) throw new Error(errText(r.error));
          return;
        }
      } catch (e) {
        if (!/upsert|not a function|undefined is not/i.test(errText(e))) throw e;
      }
    }
    await reconcileRows(rows, period, projectId, true);
  }
  /**
   * saveBatch(period, lines, projectId) -> {saved, rows}
   * Idempotent: matched rows go through the PostgREST upsert on
   * (project_id,worker_id,period); unmatched names (worker_id null) are
   * reconciled by worker_name so a second save updates instead of duplicating.
   */
  async function saveBatch(period, lines, projectId) {
    period = String(period || st.period || '');
    var pid = projectId || S.currentProjectId;
    if (!pid) throw new Error('Select a project first.');
    if (!UI.canManage || !UI.canManage()) throw new Error(pick('accessDenied') + '.');
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('Period must be YYYY-MM.');
    var list = lines || [];
    var dbRows = list.filter(function (line) { return line && String(line.worker_name || '').replace(/\s+/g, '') !== ''; })
      .map(function (line) { return toDbRow(line, period, pid); });
    if (!dbRows.length) return { saved: 0, rows: [] };
    var matched = [];
    var unmatched = [];
    dbRows.forEach(function (row) { (row.worker_id ? matched : unmatched).push(row); });
    if (matched.length) await upsertMatched(matched, period, pid);
    if (unmatched.length) await reconcileRows(unmatched, period, pid, false);
    return { saved: dbRows.length, rows: dbRows };
  }

  /* ------------------------------------------------------------------ *
   * Print document                                                     *
   * ------------------------------------------------------------------ */
  function statusWord(status) {
    status = String(status || 'draft').toLowerCase();
    if (status === 'approved') return pick('approved');
    if (status === 'paid') return pick('paid');
    return pick('draft');
  }
  function statusColor(status) {
    status = String(status || 'draft').toLowerCase();
    return status === 'paid' ? '#1a7f37' : status === 'approved' ? '#9a6700' : '#57606a';
  }
  function slipRows(slips, opts) {
    opts = opts || {};
    var list = Array.isArray(slips) ? slips : [slips];
    return list.filter(Boolean).map(function (slip) {
      var identity = slip.worker_id || slip.worker_name ? identityFor(slip) : null;
      return {
        worker_name: String(slip.worker_name == null ? '' : slip.worker_name),
        staff_no: String(slip.staff_no == null ? '' : slip.staff_no),
        nationality: String(slip.nationality || (identity && identity.nationality) || ''),
        trade: String(slip.trade || (identity && (identity.trade || identity.role)) || ''),
        period: String(slip.period || opts.period || ''),
        days_worked: toNum(slip.days_worked, 0),
        reg_hours: toNum(slip.reg_hours, 0),
        ot_hours: toNum(slip.ot_hours, 0),
        hourly_rate: toNum(slip.hourly_rate, 0),
        ot_rate: toNum(slip.ot_rate, 0),
        gross: toNum(slip.gross, 0),
        loan_deduction: toNum(slip.loan_deduction, 0),
        other_deductions: toNum(slip.other_deductions, 0),
        net: toNum(slip.net, 0),
        status: String(slip.status || 'draft'),
        notes: String(slip.notes == null ? slip.notes_raw == null ? '' : slip.notes_raw : slip.notes)
      };
    });
  }
  /**
   * buildPrintHtml(slips[, opts]) -> complete HTML document string.
   * One payslip per page (CSS page-break-after), bulk = one document.
   * opts: {period, company, language, generatedAt, title}
   */
  function buildPrintHtml(slips, opts) {
    opts = opts || {};
    var company = opts.company || companyOf();
    var language = opts.language || (isAr() ? 'ar' : 'en');
    var dir = language === 'ar' ? 'rtl' : 'ltr';
    var rows = slipRows(slips, opts);
    var cName = company.name || pick('companyFallback');
    var cAddress = String(company.address || '');
    var cContact = [company.phone, company.email].filter(Boolean).join(' · ');
    var trn = company.tax_id || company.trn || '';
    var logo = safeImg(company.logo_data);
    var t = language === 'ar' ? L.ar : L.en;
    var generatedAt = opts.generatedAt || todayStr();
    var css = [
      '@page{size:A4 portrait;margin:12mm 10mm}',
      '*{box-sizing:border-box}',
      'html,body{margin:0;padding:0}',
      'body{font-family:"Segoe UI",Arial,"Helvetica Neue",sans-serif;color:#111;background:#fff;font-size:12px;line-height:1.45}',
      '.slip{page-break-after:always;break-after:page;padding:2mm 0 6mm}',
      '.slip:last-child{page-break-after:auto;break-after:auto}',
      '.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}',
      '.brand{display:flex;gap:12px;align-items:flex-start}',
      '.brand img{max-height:56px;max-width:150px;object-fit:contain}',
      '.brand h1{font-size:17px;margin:0 0 3px}',
      '.meta{font-size:10.5px;color:#555;line-height:1.5}',
      '.doc{text-align:end}',
      '.doc h2{font-size:15px;margin:0 0 4px;letter-spacing:.4px}',
      '.doc .period{font-weight:700}',
      '.tag{display:inline-block;border:1px solid #999;border-radius:999px;padding:1px 8px;font-size:9.5px;font-weight:800;text-transform:uppercase}',
      '.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 22px;margin-bottom:12px}',
      '.row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dotted #ccc;font-size:11.5px}',
      '.row span:first-child{color:#555}',
      '.row b{text-align:end}',
      'h3{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#555;margin:12px 0 5px}',
      'table{width:100%;border-collapse:collapse;font-size:11.5px}',
      'th{text-align:start;font-size:9.5px;letter-spacing:.6px;text-transform:uppercase;color:#555;background:#f4f4f4;padding:6px 8px;border:1px solid #ccc}',
      'td{padding:6px 8px;border:1px solid #ddd;font-variant-numeric:tabular-nums}',
      'td.num,th.num{text-align:end;white-space:nowrap}',
      'tr.total td{font-weight:800;background:#fafafa}',
      'tr.net td{font-weight:800;background:#111;color:#fff;font-size:12.5px}',
      '.notes{margin-top:10px;font-size:10.5px;color:#444;border:1px dashed #bbb;padding:6px 8px;border-radius:4px}',
      '.sigs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:26px;margin-top:34px}',
      '.sig .line{border-bottom:1px solid #111;height:30px}',
      '.sig .lbl{font-size:9.5px;text-transform:uppercase;font-weight:800;margin-top:4px;color:#333}',
      '.foot{margin-top:16px;font-size:9px;color:#777;border-top:1px solid #ddd;padding-top:6px;display:flex;justify-content:space-between;gap:10px}'
    ].join('\n');
    function field(label, value) {
      return '<div class="row"><span>' + esc(label) + '</span><b>' + esc(value || '—') + '</b></div>';
    }
    function moneyRow(label, hours, rate, amount) {
      return '<tr><td>' + esc(label) + '</td><td class="num">' + esc(hours || '') + '</td><td class="num">' + esc(rate || '') + '</td><td class="num">' + esc(amount) + '</td></tr>';
    }
    var body = rows.map(function (slip) {
      var earnings = [];
      if (slip.reg_hours || slip.hourly_rate) earnings.push(moneyRow(t.regHours, slip.reg_hours + ' h', money(slip.hourly_rate) + '/h', money(round2(slip.reg_hours * slip.hourly_rate))));
      if (slip.ot_hours || slip.ot_rate) earnings.push(moneyRow(t.otHours, slip.ot_hours + ' h', money(slip.ot_rate) + '/h', money(round2(slip.ot_hours * slip.ot_rate))));
      if (!earnings.length) earnings.push(moneyRow(t.regHours, '0 h', money(0), money(0)));
      var deductions = [];
      if (slip.loan_deduction) deductions.push(moneyRow(t.loanCol, '', '', money(slip.loan_deduction)));
      if (slip.other_deductions) deductions.push(moneyRow(t.otherCol, '', '', money(slip.other_deductions)));
      return '<section class="slip">' +
        '<div class="head"><div class="brand">' +
        (logo ? '<img src="' + esc(logo) + '" alt="' + esc(cName) + '">' : '') +
        '<div><h1>' + esc(cName) + '</h1>' +
        '<div class="meta">' + esc(cAddress) + (cAddress && cContact ? '<br>' : '') + esc(cContact) + (trn ? '<br>TRN: ' + esc(trn) : '') + '</div></div></div>' +
        '<div class="doc"><h2>' + esc(t.slipTitle) + '</h2>' +
        '<div class="period">' + esc(t.periodLbl) + ': <b>' + esc(slip.period) + '</b></div>' +
        '<div style="margin-top:5px"><span class="tag" style="color:' + statusColor(slip.status) + ';border-color:' + statusColor(slip.status) + '">' + esc(statusWord(slip.status)) + '</span></div>' +
        '</div></div>' +
        '<div class="grid">' +
        field(t.worker, slip.worker_name) + field(t.staffNo, slip.staff_no) +
        field(t.nationality, slip.nationality) + field(t.trade, slip.trade) +
        field(t.periodLbl, slip.period) + field(t.daysWorked, String(slip.days_worked)) +
        '</div>' +
        '<h3>' + esc(t.earnings) + '</h3>' +
        '<table><thead><tr><th>' + esc(t.description) + '</th><th class="num">' + esc(t.hours) + '</th><th class="num">' + esc(t.rate) + '</th><th class="num">' + esc(t.amount) + '</th></tr></thead><tbody>' +
        earnings.join('') +
        '<tr class="total"><td colspan="3">' + esc(t.gross) + '</td><td class="num">' + money(slip.gross) + '</td></tr>' +
        '</tbody></table>' +
        '<h3>' + esc(t.deductionTable) + '</h3>' +
        '<table><thead><tr><th>' + esc(t.description) + '</th><th class="num">' + esc(t.hours) + '</th><th class="num">' + esc(t.rate) + '</th><th class="num">' + esc(t.amount) + '</th></tr></thead><tbody>' +
        (deductions.length ? deductions.join('') : '<tr><td colspan="3">—</td><td class="num">' + money(0) + '</td></tr>') +
        '<tr class="net"><td colspan="3">' + esc(t.netPayable) + '</td><td class="num">' + money(slip.net) + '</td></tr>' +
        '</tbody></table>' +
        (slip.notes ? '<div class="notes"><b>' + esc(t.notesCol) + ':</b> ' + esc(slip.notes) + '</div>' : '') +
        '<div class="sigs">' +
        '<div class="sig"><div class="line"></div><div class="lbl">' + esc(t.signature) + ' — ' + esc(t.employee) + '</div></div>' +
        '<div class="sig"><div class="line"></div><div class="lbl">' + esc(t.preparedBy) + '</div></div>' +
        '<div class="sig"><div class="line"></div><div class="lbl">' + esc(t.approvedBy) + '</div></div>' +
        '</div>' +
        '<div class="foot"><span>' + esc(t.generated) + ': ' + esc(generatedAt) + '</span><span>' + esc(t.computerGenerated) + '</span></div>' +
        '</section>';
    }).join('\n');
    return '<!DOCTYPE html><html lang="' + (language === 'ar' ? 'ar' : 'en') + '" dir="' + dir + '"><head><meta charset="utf-8">' +
      '<title>' + esc(opts.title || (t.slipTitle + ' — ' + (rows[0] ? rows[0].worker_name : ''))) + '</title>' +
      '<style>' + css + '</style></head><body>' + body + '</body></html>';
  }
  function fallbackPrint(html) {
    try {
      var frame = document.createElement('iframe');
      frame.setAttribute('title', 'Print');
      frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;';
      document.body.appendChild(frame);
      var doc = frame.contentWindow.document;
      doc.open();
      doc.write(html);
      doc.close();
      setTimeout(function () {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* ignore */ }
        setTimeout(function () { try { document.body.removeChild(frame); } catch (e) { /* ignore */ } }, 2000);
      }, 300);
      return true;
    } catch (e) { return false; }
  }
  /** Open a fresh print window (opener severed) and close it after printing. */
  function openPrintWindow(html, title) {
    var w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    if (!w) return fallbackPrint(html);
    try { w.opener = null; } catch (e) { /* ignore */ }
    try {
      w.document.open();
      w.document.write(html);
      w.document.close();
    } catch (e) {
      try { w.close(); } catch (e2) { /* ignore */ }
      return fallbackPrint(html);
    }
    try { w.onafterprint = function () { try { w.close(); } catch (e) { /* ignore */ } }; } catch (e) { /* ignore */ }
    setTimeout(function () {
      try { w.focus(); w.print(); } catch (e) { /* ignore */ }
    }, 350);
    /* Close a window the user never prints (e.g. cancelled dialog) without leaking it. */
    setTimeout(function () { try { if (!w.closed) w.close(); } catch (e) { /* ignore */ } }, 60000);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * View state + rendering                                             *
   * ------------------------------------------------------------------ */
  var st = {
    period: (H.today ? H.today() : new Date().toISOString().slice(0, 10)).slice(0, 7),
    loaded: false,
    loading: false,
    err: null,
    saved: [],
    preview: null,
    busy: false,
    gen: 0
  };
  var mountedEl = null;

  function validPeriod(p) { return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(String(p || '')); }
  function skeletonHtml() {
    return '<h2 class="vt">🧾 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('sub')) + '</div>' +
      '<div class="card"><p class="mutc">' + esc(pick('loading')) + '</p></div>';
  }
  function noProjectHtml() {
    return '<h2 class="vt">🧾 ' + esc(pick('title')) + '</h2>' +
      '<div class="card"><div class="empty"><div class="big">🏗</div>' + esc(pick('noProject')) + '</div></div>';
  }
  function errorCardHtml(err) {
    return '<h2 class="vt">🧾 ' + esc(pick('title')) + '</h2>' +
      '<div class="card">' +
      '<p class="badc" style="font-weight:800">' + esc(pick('migrationTitle')) + '</p>' +
      '<p class="mutc">' + esc(pick('migrationRun')) + ' <code>' + esc(MIGRATION) + '</code> ' + esc(pick('migrationAfter')) + '</p>' +
      '<p class="mutc" style="font-family:var(--font-mono);font-size:11px;white-space:pre-wrap">' + esc(errText(err)) + '</p>' +
      '<div class="row" style="margin-top:10px"><button class="btn ghost sm" onclick="SF_modules.payslips._reload()">↻ Retry</button></div>' +
      '</div>';
  }
  function tag(cls, text, titleAttr) {
    return '<span class="tag ' + cls + '"' + (titleAttr ? ' title="' + esc(titleAttr) + '"' : '') + '>' + esc(text) + '</span>';
  }
  function inputCell(i, field, value, opts) {
    opts = opts || {};
    return '<input type="number" step="' + (opts.step || '0.01') + '" min="0" value="' + esc(value) + '"' +
      ' aria-label="' + esc(opts.label || field) + '"' +
      ' oninput="SF_modules.payslips._edit(' + i + ',\'' + field + '\',this)"' +
      ' style="width:76px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font-size:12px;text-align:end;color:var(--txt);font-variant-numeric:tabular-nums">';
  }
  function warningsHtml(line) {
    var out = '';
    if (!line.matched) out += tag('warn', pick('unmatched'));
    (line.warnings || []).forEach(function (w) {
      if (String(w).indexOf('will save with name only') >= 0) return;
      out += tag('warn', w);
    });
    if (line.shortfall > 0) out += tag('bad', pick('shortfall') + ': ' + money(line.shortfall));
    return out;
  }
  function previewCardHtml() {
    var lines = st.preview || [];
    var totals = computeTotals(lines);
    var body = lines.length ? lines.map(function (line, i) {
      return '<tr>' +
        '<td><b>' + esc(line.worker_name || '—') + '</b><div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap" id="ps-warn-' + i + '">' + warningsHtml(line) + '</div></td>' +
        '<td><span class="staff-badge">' + esc(line.staff_no || '—') + '</span></td>' +
        '<td class="tright">' + inputCell(i, 'days_worked', line.days_worked, { step: '0.01', label: pick('days') }) + '</td>' +
        '<td class="tright">' + inputCell(i, 'reg_hours', line.reg_hours, { step: '0.25', label: pick('regHours') }) + '</td>' +
        '<td class="tright">' + inputCell(i, 'ot_hours', line.ot_hours, { step: '0.25', label: pick('otHours') }) + '</td>' +
        '<td class="tright">' + inputCell(i, 'hourly_rate', line.hourly_rate, { label: pick('rate') }) + '</td>' +
        '<td class="tright mono" id="ps-otrate-' + i + '">' + money(line.ot_rate) + '</td>' +
        '<td class="tright mono" id="ps-gross-' + i + '">' + money(line.gross) + '</td>' +
        '<td class="tright mono" id="ps-loan-' + i + '">' + money(line.loan_deduction) + '</td>' +
        '<td class="tright">' + inputCell(i, 'other_deductions', line.other_deductions, { label: pick('otherCol') }) + '</td>' +
        '<td class="tright mono okc" id="ps-net-' + i + '">' + money(line.net) + '</td>' +
        '<td class="tright"><button class="btn ghost sm" aria-label="' + esc(pick('removeLine')) + '" title="' + esc(pick('removeLine')) + '" onclick="SF_modules.payslips._remove(' + i + ')">✕</button></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="12" class="empty">' + esc(pick('noTimesheets')) + '</td></tr>';
    var foot = lines.length ? '<tfoot><tr>' +
      '<td colspan="2"><b>' + esc(pick('totals')) + '</b></td>' +
      '<td class="tright mono" id="ps-tot-days">' + totals.days_worked + '</td>' +
      '<td class="tright mono" id="ps-tot-reg">' + totals.reg_hours.toFixed(2) + '</td>' +
      '<td class="tright mono" id="ps-tot-ot">' + totals.ot_hours.toFixed(2) + '</td>' +
      '<td></td><td></td>' +
      '<td class="tright mono" id="ps-tot-gross">' + money(totals.gross) + '</td>' +
      '<td class="tright mono" id="ps-tot-loan">' + money(totals.loan_deduction) + '</td>' +
      '<td class="tright mono" id="ps-tot-other">' + money(totals.other_deductions) + '</td>' +
      '<td class="tright mono okc" id="ps-tot-net">' + money(totals.net) + '</td><td></td></tr></tfoot>' : '';
    return '<div class="card" style="margin-bottom:14px">' +
      '<h3>' + esc(pick('preview')) + ' · ' + lines.length + '</h3>' +
      '<div style="overflow-x:auto"><table><thead><tr>' +
      '<th>' + esc(pick('worker')) + '</th><th>' + esc(pick('staffNo')) + '</th>' +
      '<th class="tright">' + esc(pick('days')) + '</th><th class="tright">' + esc(pick('regHours')) + '</th><th class="tright">' + esc(pick('otHours')) + '</th>' +
      '<th class="tright">' + esc(pick('rate')) + '</th><th class="tright">' + esc(pick('otRate')) + '</th>' +
      '<th class="tright">' + esc(pick('grossCol')) + '</th><th class="tright">' + esc(pick('loanCol')) + '</th>' +
      '<th class="tright">' + esc(pick('otherCol')) + '</th><th class="tright">' + esc(pick('netCol')) + '</th><th></th>' +
      '</tr></thead><tbody>' + body + '</tbody>' + foot + '</table></div>' +
      '<p class="mutc" style="font-size:11px;margin-top:10px">' + esc(pick('previewHint')) + '</p>' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="btn ghost" onclick="SF_modules.payslips._discard()">' + esc(pick('discard')) + '</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" onclick="SF_modules.payslips._save()"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? '…' : esc(pick('save'))) + '</button>' +
      '</div></div>';
  }
  function savedCardHtml() {
    var rows = st.saved || [];
    var canManage = !!(UI.canManage && UI.canManage());
    var body = rows.length ? rows.map(function (row) {
      var actions = '<button class="btn ghost sm" aria-label="' + esc(pick('print')) + '" title="' + esc(pick('print')) + '" onclick="SF_modules.payslips._printOne(\'' + esc(row.id) + '\')">🖨</button> ';
      if (canManage && row.status === 'draft') actions += '<button class="btn ok sm" aria-label="' + esc(pick('approve')) + '" title="' + esc(pick('approve')) + '" onclick="SF_modules.payslips._action(\'' + esc(row.id) + '\',\'approve\')">✓</button> ';
      if (canManage && row.status === 'approved') actions += '<button class="btn blue sm" aria-label="' + esc(pick('markPaid')) + '" title="' + esc(pick('markPaid')) + '" onclick="SF_modules.payslips._action(\'' + esc(row.id) + '\',\'paid\')">💵</button> ';
      if (canManage) actions += '<button class="btn bad sm" aria-label="' + esc(pick('delete')) + '" title="' + esc(pick('delete')) + '" onclick="SF_modules.payslips._action(\'' + esc(row.id) + '\',\'delete\')">✕</button>';
      var statusCls = row.status === 'paid' ? 'ok' : row.status === 'approved' ? 'warn' : 'mut';
      return '<tr>' +
        '<td><b>' + esc(row.worker_name || '—') + '</b>' + (!row.worker_id ? ' ' + tag('warn', 'no worker') : '') +
        (row.notes ? '<div class="mutc" style="font-size:10.5px;max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(row.notes) + '">' + esc(row.notes) + '</div>' : '') + '</td>' +
        '<td><span class="staff-badge">' + esc(row.staff_no || '—') + '</span></td>' +
        '<td class="tright mono">' + row.days_worked + '</td>' +
        '<td class="tright mono">' + Number(row.reg_hours || 0).toFixed(2) + '</td>' +
        '<td class="tright mono">' + Number(row.ot_hours || 0).toFixed(2) + '</td>' +
        '<td class="tright mono">' + money(row.gross) + '</td>' +
        '<td class="tright mono">' + money(row.loan_deduction) + '</td>' +
        '<td class="tright mono">' + money(row.other_deductions) + '</td>' +
        '<td class="tright mono okc">' + money(row.net) + '</td>' +
        '<td>' + tag(statusCls, statusWord(row.status)) + (row.paid_at ? '<div class="mutc" style="font-size:10px">' + esc(fmtDate(row.paid_at)) + '</div>' : '') + '</td>' +
        '<td class="tright" style="white-space:nowrap">' + actions + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="11" class="empty"><div class="big">🧾</div>' + esc(pick('empty')) +
      '<div class="mutc" style="margin-top:6px;font-size:12px">' + esc(pick('emptyHint')) + '</div></td></tr>';
    return '<div class="card"><h3>' + esc(pick('saved')) + ' · ' + rows.length + '</h3>' +
      '<div style="overflow-x:auto"><table><thead><tr>' +
      '<th>' + esc(pick('worker')) + '</th><th>' + esc(pick('staffNo')) + '</th>' +
      '<th class="tright">' + esc(pick('days')) + '</th><th class="tright">' + esc(pick('regHours')) + '</th><th class="tright">' + esc(pick('otHours')) + '</th>' +
      '<th class="tright">' + esc(pick('grossCol')) + '</th><th class="tright">' + esc(pick('loanCol')) + '</th>' +
      '<th class="tright">' + esc(pick('otherCol')) + '</th><th class="tright">' + esc(pick('netCol')) + '</th>' +
      '<th>' + esc(pick('status')) + '</th><th class="tright">' + esc(pick('actions')) + '</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }
  function kpiHtml() {
    var totals = computeTotals(st.saved || []);
    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px">' +
      '<div class="kpi"><div class="lbl">' + esc(pick('workers')) + '</div><div class="val">' + totals.count + '</div><div class="sub">' + esc(st.period) + '</div></div>' +
      '<div class="kpi b"><div class="lbl">' + esc(pick('gross')) + '</div><div class="val" style="font-size:18px">' + money(totals.gross) + '</div><div class="sub">' + totals.reg_hours.toFixed(2) + ' h + ' + totals.ot_hours.toFixed(2) + ' h OT</div></div>' +
      '<div class="kpi y"><div class="lbl">' + esc(pick('deductions')) + '</div><div class="val" style="font-size:18px">' + money(round2(totals.loan_deduction + totals.other_deductions)) + '</div><div class="sub">' + esc(pick('loanCol')) + ' ' + money(totals.loan_deduction) + '</div></div>' +
      '<div class="kpi g"><div class="lbl">' + esc(pick('net')) + '</div><div class="val" style="font-size:18px">' + money(totals.net) + '</div><div class="sub">' + totals.count + ' ' + esc(pick('workers')).toLowerCase() + '</div></div>' +
      '</div>';
  }
  function toolbarHtml() {
    return '<h2 class="vt">🧾 ' + esc(pick('title')) + '</h2>' +
      '<div class="vsub">' + esc(pick('sub')) + '<span class="spacer"></span>' +
      '<label for="psPeriod" style="font-size:10px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);font-weight:800">' + esc(pick('period')) + '</label>' +
      '<input id="psPeriod" type="month" value="' + esc(st.period) + '" aria-label="' + esc(pick('period')) + '" onchange="SF_modules.payslips._setPeriod(this.value)" style="background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12.5px;color:var(--txt)">' +
      '<button class="btn" onclick="SF_modules.payslips._generate()">' + esc(pick('generate')) + '</button>' +
      '<button class="btn ghost" onclick="SF_modules.payslips._printPeriod()">' + esc(pick('printAll')) + '</button>' +
      '</div>';
  }
  function paint(el) {
    if (!el) return;
    try {
      if (!S.currentProjectId) { el.innerHTML = '<div data-ps-root="1">' + noProjectHtml() + '</div>'; return; }
      if (st.err) { el.innerHTML = '<div data-ps-root="1">' + errorCardHtml(st.err) + '</div>'; return; }
      var html = '<div data-ps-root="1">' + toolbarHtml() + kpiHtml();
      if (st.preview) html += previewCardHtml();
      html += savedCardHtml() + '</div>';
      el.innerHTML = html;
    } catch (e) {
      try { el.innerHTML = '<div data-ps-root="1">' + errorCardHtml(e) + '</div>'; } catch (e2) { /* ignore */ }
    }
  }
  function render(el) {
    try {
      mountedEl = el;
      if (!el) return;
      if (!S.currentProjectId) { el.innerHTML = '<div data-ps-root="1">' + noProjectHtml() + '</div>'; return; }
      if (!st.loaded) {
        el.innerHTML = '<div data-ps-root="1">' + skeletonHtml() + '</div>';
        if (!st.loading) ensureLoaded();
        return;
      }
      paint(el);
    } catch (e) {
      try { el.innerHTML = '<div data-ps-root="1">' + errorCardHtml(e) + '</div>'; } catch (e2) { /* ignore */ }
    }
  }
  function repaint() {
    try {
      if (!mountedEl || !mountedEl.querySelector || !mountedEl.querySelector('[data-ps-root]')) return;
      paint(mountedEl);
    } catch (e) { /* never throw out of the async path */ }
  }
  function ensureLoaded() {
    var gen = ++st.gen;
    st.loading = true;
    loadSaved(st.period).then(function (res) {
      if (gen !== st.gen) return;
      st.loading = false;
      st.loaded = true;
      if (res.error) { st.err = res.error; st.saved = []; }
      else { st.err = null; st.saved = res.rows; }
      repaint();
    }).catch(function (e) {
      if (gen !== st.gen) return;
      st.loading = false;
      st.loaded = true;
      st.err = e;
      st.saved = [];
      repaint();
    });
  }
  function reloadView() {
    st.loaded = false;
    st.err = null;
    if (UI.render) UI.render(); else ensureLoaded();
  }

  /* ------------------------------------------------------------------ *
   * Interactions                                                       *
   * ------------------------------------------------------------------ */
  function setPeriod(value) {
    try {
      var v = String(value || '');
      if (!validPeriod(v)) { if (UI.toast) UI.toast('Period must be YYYY-MM', 'bad'); reloadView(); return; }
      st.period = v;
      reloadView();
    } catch (e) { if (UI.toast) UI.toast(errText(e), 'bad'); }
  }
  function generate() {
    try {
      var lines = buildLines({ period: st.period });
      st.preview = lines.length ? lines : null;
      if (!lines.length && UI.toast) UI.toast(pick('noTimesheets'), 'bad');
      if (UI.render) UI.render(); else repaint();
    } catch (e) { if (UI.toast) UI.toast(errText(e), 'bad'); }
  }
  function discardPreview() {
    st.preview = null;
    if (UI.render) UI.render(); else repaint();
  }
  function removeLine(i) {
    try {
      if (!st.preview || !st.preview[i]) return;
      st.preview.splice(i, 1);
      if (!st.preview.length) st.preview = null;
      if (UI.render) UI.render(); else repaint();
    } catch (e) { /* ignore */ }
  }
  function editingBase(line) {
    var raw = line._raw || {};
    function val(key, fallback) { return raw[key] != null ? raw[key] : (line[key] != null ? line[key] : fallback); }
    return {
      worker_id: line.worker_id,
      worker_name: line.worker_name,
      staff_no: line.staff_no,
      nationality: line.nationality,
      trade: line.trade,
      matched: line.matched,
      days_worked: val('days_worked', 0),
      reg_hours: val('reg_hours', 0),
      ot_hours: val('ot_hours', 0),
      hourly_rate: val('hourly_rate', 0),
      loan_balance: line.loan_balance,
      other_deductions: val('other_deductions', 0)
    };
  }
  function editLine(i, field, el) {
    try {
      var line = st.preview && st.preview[i];
      if (!line) return;
      var raw = el && typeof el === 'object' && 'value' in el ? el.value : el;
      var v = toNum(raw, 0);
      if (v < 0) { v = 0; if (el && el.value != null) { try { el.value = '0'; } catch (e) { /* ignore */ } } }
      line._raw = line._raw || {};
      line._raw[field] = v;
      var recomputed = computeLine(editingBase(line));
      recomputed._raw = line._raw;
      recomputed._extraWarnings = line._extraWarnings || [];
      recomputed.source_rows = line.source_rows;
      recomputed.warnings = recomputed.warnings.concat(recomputed._extraWarnings);
      st.preview[i] = recomputed;
      updateRowDom(i);
      updateTotalsDom();
    } catch (e) { /* input handlers must never throw */ }
  }
  function setText(id, text) {
    try {
      var node = document.getElementById(id);
      if (node) node.textContent = text;
    } catch (e) { /* ignore */ }
  }
  function updateRowDom(i) {
    var line = st.preview && st.preview[i];
    if (!line) return;
    setText('ps-otrate-' + i, money(line.ot_rate));
    setText('ps-gross-' + i, money(line.gross));
    setText('ps-loan-' + i, money(line.loan_deduction));
    setText('ps-net-' + i, money(line.net));
    try {
      var warn = document.getElementById('ps-warn-' + i);
      if (warn) warn.innerHTML = warningsHtml(line);
    } catch (e) { /* ignore */ }
  }
  function updateTotalsDom() {
    var totals = computeTotals(st.preview || []);
    setText('ps-tot-days', String(totals.days_worked));
    setText('ps-tot-reg', totals.reg_hours.toFixed(2));
    setText('ps-tot-ot', totals.ot_hours.toFixed(2));
    setText('ps-tot-gross', money(totals.gross));
    setText('ps-tot-loan', money(totals.loan_deduction));
    setText('ps-tot-other', money(totals.other_deductions));
    setText('ps-tot-net', money(totals.net));
  }
  async function savePreview() {
    if (st.busy) return;
    if (!st.preview || !st.preview.length) { if (UI.toast) UI.toast(pick('noTimesheets'), 'bad'); return; }
    st.busy = true;
    if (UI.render) UI.render(); else repaint();
    try {
      var out = await saveBatch(st.period, st.preview, S.currentProjectId);
      st.preview = null;
      st.busy = false;
      if (UI.toast) UI.toast(out.saved + ' ' + pick('savedOk') + ' — ' + st.period, 'ok');
      st.loaded = false;
      if (UI.render) UI.render(); else ensureLoaded();
    } catch (e) {
      st.busy = false;
      st.preview = null;
      if (isMissingTable(e)) {
        st.err = e;
        st.loaded = true;
        if (UI.render) UI.render();
      } else {
        if (UI.render) UI.render();
        if (UI.toast) UI.toast(pick('saveFailed') + ': ' + errText(e), 'bad');
      }
    }
  }
  function findSaved(id) {
    var rows = st.saved || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }
  async function doAction(id, op) {
    try {
      if (!UI.canManage || !UI.canManage()) { if (UI.toast) UI.toast(pick('accessDenied'), 'bad'); return; }
      var row = findSaved(id);
      if (!row) return;
      if (op === 'approve') {
        if (row.status !== 'draft') return;
        await DB.update('payslips', id, { status: 'approved' });
        if (UI.toast) UI.toast(pick('approved') + ' ✓', 'ok');
      } else if (op === 'paid') {
        if (row.status !== 'approved') return;
        await DB.update('payslips', id, { status: 'paid', paid_at: new Date().toISOString() });
        if (UI.toast) UI.toast(pick('paid') + ' ✓', 'ok');
      } else if (op === 'delete') {
        var ok = true;
        try { ok = window.confirm(pick('confirmDelete')); } catch (e) { ok = false; }
        if (!ok) return;
        await DB.remove('payslips', id);
        if (UI.toast) UI.toast(pick('delete') + ' ✓', 'ok');
      } else {
        return;
      }
      reloadView();
    } catch (e) {
      if (UI.toast) UI.toast(pick('actionFailed') + ': ' + errText(e), 'bad');
    }
  }
  function printOne(id) {
    try {
      var row = findSaved(id);
      if (!row) { if (UI.toast) UI.toast(pick('printFailed'), 'bad'); return; }
      var html = buildPrintHtml([row], { period: row.period || st.period });
      openPrintWindow(html, pick('slipTitle') + ' — ' + row.worker_name);
    } catch (e) { if (UI.toast) UI.toast(errText(e), 'bad'); }
  }
  function printPeriod() {
    try {
      var rows = st.saved || [];
      if (!rows.length) { if (UI.toast) UI.toast(pick('printFailed'), 'bad'); return; }
      var html = buildPrintHtml(rows, { period: st.period, title: pick('slipTitle') + ' ' + st.period });
      openPrintWindow(html, pick('slipTitle') + ' ' + st.period);
    } catch (e) { if (UI.toast) UI.toast(errText(e), 'bad'); }
  }

  /* ------------------------------------------------------------------ *
   * Registration + test surface                                        *
   * ------------------------------------------------------------------ */
  S.registerView({
    id: VIEW_ID,
    nav: { section: 'project', icon: '🧾', label: 'Payslips', labelAr: 'قسائم الرواتب' },
    roles: ['director', 'controller'],
    render: render
  });

  window.SF_modules = window.SF_modules || {};
  window.SF_modules.payslips = {
    /* pure API (used by tools/checks/payslips.mjs) */
    computeLine: computeLine,
    computeTotals: computeTotals,
    otRate: otRate,
    round2: round2,
    parseWorkerPay: parseWorkerPay,
    workerPayOf: workerPayOf,
    buildLines: buildLines,
    saveBatch: saveBatch,
    loadSaved: loadSaved,
    buildPrintHtml: buildPrintHtml,
    normalizeSaved: normalizeSaved,
    notesForLine: notesForLine,
    /* view actions (inline handlers) */
    _setPeriod: setPeriod,
    _generate: generate,
    _discard: discardPreview,
    _remove: removeLine,
    _edit: editLine,
    _save: savePreview,
    _action: doAction,
    _printOne: printOne,
    _printPeriod: printPeriod,
    _reload: function () { reloadView(); },
    /* diagnostics for the headless suite */
    _state: st,
    _reset: function () {
      st.period = (H.today ? H.today() : new Date().toISOString().slice(0, 10)).slice(0, 7);
      st.loaded = false; st.loading = false; st.err = null; st.saved = []; st.preview = null; st.busy = false; st.gen = 0;
    }
  };
})();
