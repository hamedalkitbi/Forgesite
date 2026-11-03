/* ============================================================================
 * SiteForge module: Payment Requests (subcontractors & suppliers)
 * ----------------------------------------------------------------------------
 * Project-level payment requests with a draft → submitted → approved → paid
 * workflow (plus rejection with a mandatory reason), retention and advance
 * recovery, ageing, print, and a full audit trail.
 *
 * Owned by: payment-requests teammate. Contract: docs/modules/CONTRACT.md.
 * Table + RLS: supabase/migrations/202611031001_payment_requests.sql.
 * Docs: docs/modules/payment-requests.md. Checks: tools/checks/payment-requests.mjs.
 *
 * The module never edits scripts/app.js. It only uses the window.SF bridge and
 * registers the "payment-requests" view. Pure calculation helpers are exposed
 * on window.SF_modules['payment-requests'] and are safe to load without SF (a
 * Node harness can evaluate this file with a bare `window` object and test the
 * math), which keeps the features testable before the mock-Supabase testkit is
 * available.
 * ========================================================================== */
(function () {
  'use strict';

  var MODULE_ID = 'payment-requests';
  var TABLE = 'payment_requests';
  var MIGRATION = 'supabase/migrations/202611031001_payment_requests.sql';
  var STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'paid'];
  var TYPES = ['subcontractor', 'supplier'];

  /* ------------------------------------------------------------------ */
  /* i18n (EN + AR; real Arabic, never machine transliteration)          */
  /* ------------------------------------------------------------------ */
  var L = {
    en: {
      title: 'Payment Requests',
      subtitle: 'Subcontractor & supplier requests · submit → approve → pay',
      newBtn: '+ New Request',
      loading: 'Loading payment requests…',
      retry: 'Retry',
      migrationTitle: 'Database update required',
      migrationBody: 'Payment Requests needs the payment_requests table before it can list or save requests.',
      migrationRun: 'Run',
      migrationRunAfter: 'in the Supabase SQL editor, then reload this page.',
      empty: 'No payment requests for this project yet.',
      emptyHint: 'Raise a request for a subcontractor or supplier to start the approval flow.',
      noProject: 'Select a project to see its payment requests.',
      kpiPending: 'Pending approval',
      kpiApproved: 'Approved · unpaid',
      kpiOverdue: 'Overdue',
      kpiPaid: 'Paid to date',
      requests: 'requests',
      ageing: 'Ageing · net payable',
      bNotDue: 'Not due',
      b1_30: '1–30 days',
      b31_60: '31–60 days',
      b61_90: '61–90 days',
      b90: '90+ days',
      fType: 'Type',
      fStatus: 'Status',
      fSearch: 'Search',
      searchPlaceholder: 'Reference, party or description…',
      all: 'All',
      tableTitle: 'Requests',
      tableAria: 'Payment requests table',
      colRef: 'Ref',
      colType: 'Type',
      colParty: 'Party',
      colDesc: 'Description',
      colAmount: 'Amount',
      colRetention: 'Retention',
      colNet: 'Net payable',
      colDue: 'Due',
      colStatus: 'Status',
      colActions: 'Actions',
      typeSub: 'Subcontractor',
      typeSup: 'Supplier',
      statusDraft: 'Draft',
      statusSubmitted: 'Submitted',
      statusApproved: 'Approved',
      statusRejected: 'Rejected',
      statusPaid: 'Paid',
      submit: 'Submit',
      approve: 'Approve',
      reject: 'Reject',
      pay: 'Mark paid',
      print: 'Print',
      edit: 'Edit',
      del: 'Delete',
      unknownParty: 'Unknown party',
      current: 'current',
      overdueShort: 'overdue',
      dueIn: 'due in',
      rejectedReason: 'Reason',
      needParty: 'No subcontractor/supplier parties on this project yet — add one in Parties first.',
      managerOnly: 'Approval, rejection, payment, editing and deletion require a Project Director or Financial Controller.',
      badTransition: 'That action is not allowed for this status.',
      notFound: 'Payment request not found — refresh and try again.',
      createTitle: 'New payment request',
      editTitle: 'Edit payment request',
      reference: 'Reference',
      requestType: 'Request type',
      party: 'Party',
      description: 'Description of works',
      amount: 'Amount (AED)',
      retentionPct: 'Retention %',
      advanceRecovery: 'Advance recovery (AED)',
      dueDate: 'Due date',
      status: 'Status',
      notes: 'Notes',
      saving: 'Saving…',
      cancel: 'Cancel',
      rejectTitle: 'Reject payment request',
      rejectReason: 'Reason for rejection',
      rejectReasonPh: 'Explain what the subcontractor/supplier must correct…',
      rejectReasonRequired: 'A reason is required to reject a payment request.',
      payTitle: 'Record payment',
      paymentMethod: 'Payment method',
      paidDate: 'Paid on',
      paymentMethodRequired: 'Choose a payment method.',
      paidDateRequired: 'Enter the payment date.',
      popupBlocked: 'Allow pop-ups to print the payment request.',
      createdToast: 'Payment request created ✓',
      updatedToast: 'Payment request updated ✓',
      submittedToast: 'Submitted for approval ✓',
      approvedToast: 'Payment request approved ✓',
      rejectedToast: 'Payment request rejected',
      paidToast: 'Payment recorded ✓',
      deletedToast: 'Payment request deleted',
      logCreated: 'created',
      logUpdated: 'updated',
      logSubmitted: 'submitted for approval',
      logApproved: 'approved',
      logRejected: 'rejected',
      logPaid: 'paid',
      logDeleted: 'deleted',
      deleteConfirm: 'Delete payment request',
      retentionShort: 'ret.',
      advanceShort: 'adv.'
    },
    ar: {
      title: 'طلبات الدفع',
      subtitle: 'طلبات مقاولي الباطن والموردين · إرسال ← اعتماد ← دفع',
      newBtn: '+ طلب جديد',
      loading: 'جارٍ تحميل طلبات الدفع…',
      retry: 'إعادة المحاولة',
      migrationTitle: 'يلزم تحديث قاعدة البيانات',
      migrationBody: 'يتطلب قسم طلبات الدفع جدول payment_requests قبل أن يتمكن من عرض الطلبات أو حفظها.',
      migrationRun: 'شغّل',
      migrationRunAfter: 'في محرر SQL في Supabase، ثم أعد تحميل الصفحة.',
      empty: 'لا توجد طلبات دفع لهذا المشروع بعد.',
      emptyHint: 'أنشئ طلباً لمقاول باطن أو مورد لبدء مسار الاعتماد.',
      noProject: 'اختر مشروعاً لعرض طلبات الدفع الخاصة به.',
      kpiPending: 'بانتظار الاعتماد',
      kpiApproved: 'معتمدة وغير مدفوعة',
      kpiOverdue: 'متأخرة',
      kpiPaid: 'المدفوع حتى تاريخه',
      requests: 'طلبات',
      ageing: 'أعمار المبالغ · الصافي المستحق',
      bNotDue: 'غير مستحقة',
      b1_30: '1–30 يوماً',
      b31_60: '31–60 يوماً',
      b61_90: '61–90 يوماً',
      b90: 'أكثر من 90 يوماً',
      fType: 'النوع',
      fStatus: 'الحالة',
      fSearch: 'بحث',
      searchPlaceholder: 'المرجع أو الطرف أو الوصف…',
      all: 'الكل',
      tableTitle: 'الطلبات',
      tableAria: 'جدول طلبات الدفع',
      colRef: 'المرجع',
      colType: 'النوع',
      colParty: 'الطرف',
      colDesc: 'الوصف',
      colAmount: 'المبلغ',
      colRetention: 'الاستقطاع',
      colNet: 'الصافي المستحق',
      colDue: 'الاستحقاق',
      colStatus: 'الحالة',
      colActions: 'إجراءات',
      typeSub: 'مقاول باطن',
      typeSup: 'مورد',
      statusDraft: 'مسودة',
      statusSubmitted: 'قيد الاعتماد',
      statusApproved: 'معتمد',
      statusRejected: 'مرفوض',
      statusPaid: 'مدفوع',
      submit: 'إرسال',
      approve: 'اعتماد',
      reject: 'رفض',
      pay: 'تسجيل الدفع',
      print: 'طباعة',
      edit: 'تعديل',
      del: 'حذف',
      unknownParty: 'طرف غير معروف',
      current: 'الحالي',
      overdueShort: 'متأخر',
      dueIn: 'يستحق خلال',
      rejectedReason: 'السبب',
      needParty: 'لا يوجد مقاول باطن أو مورد في هذا المشروع — أضِف طرفاً في صفحة الأطراف أولاً.',
      managerOnly: 'الاعتماد والرفض والدفع والتعديل والحذف تتطلب مدير مشروع أو مراقباً مالياً.',
      badTransition: 'هذا الإجراء غير مسموح لحالة الطلب الحالية.',
      notFound: 'لم يتم العثور على طلب الدفع — أعد التحديث ثم حاول مجدداً.',
      createTitle: 'طلب دفع جديد',
      editTitle: 'تعديل طلب الدفع',
      reference: 'المرجع',
      requestType: 'نوع الطلب',
      party: 'الطرف',
      description: 'وصف الأعمال',
      amount: 'المبلغ (درهم)',
      retentionPct: 'نسبة الاستقطاع %',
      advanceRecovery: 'استرداد الدفعة المقدمة (درهم)',
      dueDate: 'تاريخ الاستحقاق',
      status: 'الحالة',
      notes: 'ملاحظات',
      saving: 'جارٍ الحفظ…',
      cancel: 'إلغاء',
      rejectTitle: 'رفض طلب الدفع',
      rejectReason: 'سبب الرفض',
      rejectReasonPh: 'اشرح ما يجب على مقاول الباطن أو المورد تصحيحه…',
      rejectReasonRequired: 'سبب الرفض مطلوب.',
      payTitle: 'تسجيل الدفع',
      paymentMethod: 'طريقة الدفع',
      paidDate: 'تاريخ الدفع',
      paymentMethodRequired: 'اختر طريقة الدفع.',
      paidDateRequired: 'أدخل تاريخ الدفع.',
      popupBlocked: 'اسمح بالنوافذ المنبثقة لطباعة طلب الدفع.',
      createdToast: 'تم إنشاء طلب الدفع ✓',
      updatedToast: 'تم تحديث طلب الدفع ✓',
      submittedToast: 'تم إرسال الطلب للاعتماد ✓',
      approvedToast: 'تم اعتماد طلب الدفع ✓',
      rejectedToast: 'تم رفض طلب الدفع',
      paidToast: 'تم تسجيل الدفع ✓',
      deletedToast: 'تم حذف طلب الدفع',
      logCreated: 'أُنشئ',
      logUpdated: 'حُدّث',
      logSubmitted: 'أُرسل للاعتماد',
      logApproved: 'اعتُمد',
      logRejected: 'رُفض',
      logPaid: 'دُفع',
      logDeleted: 'حُذف',
      deleteConfirm: 'حذف طلب الدفع',
      retentionShort: 'استقطاع',
      advanceShort: 'استرداد مقدمة'
    }
  };

  var PRINT_L = {
    en: {
      docTitle: 'PAYMENT REQUEST',
      project: 'Project',
      payableTo: 'Payable to',
      description: 'Description',
      amount: 'Amount (AED)',
      retention: 'Retention',
      advance: 'Advance recovery',
      net: 'Net payable',
      dueDate: 'Due date',
      requestedBy: 'Requested by',
      approvedBy: 'Approved by',
      receivedBy: 'Received by',
      reference: 'Request no.',
      date: 'Date',
      status: 'Status',
      notes: 'Notes',
      payment: 'Payment',
      method: 'Method',
      paidAt: 'Paid on',
      phone: 'Phone',
      email: 'Email',
      address: 'Address',
      contact: 'Contact',
      trn: 'TRN',
      type: 'Party type',
      subcontractor: 'Subcontractor',
      supplier: 'Supplier',
      draft: 'Draft',
      submitted: 'Submitted',
      approved: 'Approved',
      rejected: 'Rejected',
      paid: 'Paid',
      footer: 'Generated by SiteForge ERP. Retention and advance recovery are deducted from the certified amount.'
    },
    ar: {
      docTitle: 'طلب دفع',
      project: 'المشروع',
      payableTo: 'يُدفع إلى',
      description: 'الوصف',
      amount: 'المبلغ (درهم)',
      retention: 'الاستقطاع',
      advance: 'استرداد الدفعة المقدمة',
      net: 'الصافي المستحق',
      dueDate: 'تاريخ الاستحقاق',
      requestedBy: 'مقدّم الطلب',
      approvedBy: 'المعتمد',
      receivedBy: 'المستلم',
      reference: 'رقم الطلب',
      date: 'التاريخ',
      status: 'الحالة',
      notes: 'ملاحظات',
      payment: 'الدفع',
      method: 'طريقة الدفع',
      paidAt: 'تاريخ الدفع',
      phone: 'الهاتف',
      email: 'البريد الإلكتروني',
      address: 'العنوان',
      contact: 'جهة الاتصال',
      trn: 'الرقم الضريبي',
      type: 'نوع الطرف',
      subcontractor: 'مقاول باطن',
      supplier: 'مورد',
      draft: 'مسودة',
      submitted: 'قيد الاعتماد',
      approved: 'معتمد',
      rejected: 'مرفوض',
      paid: 'مدفوع',
      footer: 'أُنشئت هذه الوثيقة بواسطة SiteForge ERP. يُخصم الاستقطاع واسترداد الدفعة المقدمة من المبلغ المعتمد.'
    }
  };

  /* ------------------------------------------------------------------ */
  /* Bridge accessors (all null-safe; the file must load without SF)      */
  /* ------------------------------------------------------------------ */
  function bridge() {
    return (typeof window !== 'undefined' && window.SF) ? window.SF : null;
  }
  function helpers() {
    var S = bridge();
    return (S && S.helpers) ? S.helpers : {};
  }
  function currentLang() {
    var S = bridge();
    return (S && S.language === 'ar') ? 'ar' : 'en';
  }
  function tr(key) {
    var pack = L[currentLang()] || L.en;
    return pack[key] != null ? pack[key] : (L.en[key] != null ? L.en[key] : key);
  }

  /* ------------------------------------------------------------------ */
  /* Pure helpers — exposed for tests; no DOM / no SF dependency          */
  /* ------------------------------------------------------------------ */
  function toNum(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }
  /* Round half away from zero at 2dp (matches app.js money formatting and the
     SQL trigger's round(numeric, 2) for positive monetary values). */
  function round2(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    var r = Math.round((n + (n >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
    return r === 0 ? 0 : r;
  }

  /* computeRetention(amountAed, retentionPct) → AED 2dp
     Also accepts an object: computeRetention({amount_aed, retention_pct}). */
  function computeRetention(amount, retentionPct) {
    var a = amount;
    var p = retentionPct;
    if (a && typeof a === 'object') {
      p = (a.retention_pct !== undefined && a.retention_pct !== null) ? a.retention_pct : a.retentionPct;
      a = (a.amount_aed !== undefined && a.amount_aed !== null) ? a.amount_aed : a.amount;
    }
    return round2(toNum(a, 0) * toNum(p, 0) / 100);
  }

  /* computeNet(amountAed, retentionAed, advanceRecoveryAed) → AED 2dp
     Also accepts:
       computeNet({amount_aed, retention_pct | retention_aed, advance_recovery_aed})
       computeNet(amountAed, {retention_pct | retention_aed, advance_recovery_aed})
     The formula is always amount − retention − advance recovery; a negative
     result is a validation error (validate() below), not silently clamped. */
  function computeNet(amount, retentionAed, advanceRecoveryAed) {
    var a, ret, adv;
    if (amount && typeof amount === 'object') {
      a = (amount.amount_aed !== undefined && amount.amount_aed !== null) ? amount.amount_aed : amount.amount;
      if (amount.retention_aed !== undefined && amount.retention_aed !== null) {
        ret = amount.retention_aed;
      } else {
        ret = computeRetention(a, (amount.retention_pct !== undefined && amount.retention_pct !== null) ? amount.retention_pct : amount.retentionPct);
      }
      adv = (amount.advance_recovery_aed !== undefined && amount.advance_recovery_aed !== null) ? amount.advance_recovery_aed : amount.advanceRecoveryAed;
    } else {
      a = amount;
      if (retentionAed && typeof retentionAed === 'object') {
        ret = (retentionAed.retention_aed !== undefined && retentionAed.retention_aed !== null)
          ? retentionAed.retention_aed
          : computeRetention(a, retentionAed.retention_pct);
        adv = retentionAed.advance_recovery_aed;
      } else {
        ret = retentionAed;
        adv = advanceRecoveryAed;
      }
    }
    return round2(toNum(a, 0) - toNum(ret, 0) - toNum(adv, 0));
  }

  /* computeTotals({amount_aed, retention_pct, advance_recovery_aed}) → values */
  function computeTotals(input) {
    var i = input || {};
    var amount = round2(toNum(i.amount_aed, 0));
    var pct = round2(toNum(i.retention_pct, 0));
    var adv = round2(toNum(i.advance_recovery_aed, 0));
    var retention = computeRetention(amount, pct);
    return {
      amount_aed: amount,
      retention_pct: pct,
      retention_aed: retention,
      advance_recovery_aed: adv,
      net_aed: round2(amount - retention - adv)
    };
  }

  function padDatePart(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function localToday() {
    var h = helpers();
    if (typeof h.today === 'function') return h.today();
    var d = new Date();
    return d.getFullYear() + '-' + padDatePart(d.getMonth() + 1) + '-' + padDatePart(d.getDate());
  }
  /* UTC-midnight milliseconds for a date / date-time value, so day maths never
     shifts by a timezone offset. */
  function dateOnlyMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return null;
      return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    }
    var s = String(value).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /* computeAgeing(row, todayValue) → {bucket, overdue, daysOverdue, ...}
     Buckets (inclusive upper bounds, measured in whole days past due):
        not due | 1–30 | 31–60 | 61–90 | 90+   (closed for paid/rejected)
     Overdue = due_date < today AND status not in ('paid','rejected'). */
  function computeAgeing(row, todayValue) {
    var r = row || {};
    var status = String(r.status || 'draft');
    if (status === 'paid' || status === 'rejected') {
      return { bucket: 'closed', overdue: false, daysOverdue: 0, daysUntilDue: null, closed: true };
    }
    var due = (r.due_date !== undefined && r.due_date !== null && r.due_date !== '') ? r.due_date : r.dueDate;
    if (due === undefined || due === null || due === '') {
      return { bucket: 'no_due', overdue: false, daysOverdue: 0, daysUntilDue: null, closed: false };
    }
    var dueMs = dateOnlyMs(due);
    var baseMs = dateOnlyMs(todayValue || localToday());
    if (dueMs === null || baseMs === null) {
      return { bucket: 'no_due', overdue: false, daysOverdue: 0, daysUntilDue: null, closed: false };
    }
    var diff = Math.round((dueMs - baseMs) / 86400000);
    if (diff >= 0) {
      return { bucket: 'not_due', overdue: false, daysOverdue: 0, daysUntilDue: diff, closed: false };
    }
    var od = -diff;
    var bucket = od <= 30 ? '1-30' : (od <= 60 ? '31-60' : (od <= 90 ? '61-90' : '90+'));
    return { bucket: bucket, overdue: true, daysOverdue: od, daysUntilDue: null, closed: false };
  }

  /* ageingSummary(rows, todayValue) → per-bucket counts + net values and totals */
  function ageingSummary(rows, todayValue) {
    var out = {
      not_due: { count: 0, value: 0 },
      '1-30': { count: 0, value: 0 },
      '31-60': { count: 0, value: 0 },
      '61-90': { count: 0, value: 0 },
      '90+': { count: 0, value: 0 },
      no_due: { count: 0, value: 0 },
      closed: { count: 0, value: 0 },
      total: { count: 0, value: 0 },
      overdue: { count: 0, value: 0 }
    };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var a = computeAgeing(row, todayValue);
      var bucket = out[a.bucket] || (out[a.bucket] = { count: 0, value: 0 });
      var value = toNum(row && row.net_aed, 0);
      bucket.count += 1;
      bucket.value = round2(bucket.value + value);
      out.total.count += 1;
      out.total.value = round2(out.total.value + value);
      if (a.overdue) {
        out.overdue.count += 1;
        out.overdue.value = round2(out.overdue.value + value);
      }
    });
    return out;
  }

  /* nextReference(existing) → 'PR-001' style, derived from the highest trailing
     number in the supplied references (strings or rows with .reference). */
  function nextReference(existing, width) {
    var pad = (width === undefined || width === null || width < 1) ? 3 : Math.floor(width);
    var max = 0;
    (Array.isArray(existing) ? existing : []).forEach(function (item) {
      var raw = (item && typeof item === 'object') ? (item.reference !== undefined ? item.reference : item.ref) : item;
      if (raw === null || raw === undefined) return;
      var m = String(raw).match(/(\d+)\s*$/);
      if (!m) return;
      var n = parseInt(m[1], 10);
      if (isFinite(n) && n > max) max = n;
    });
    var s = String(max + 1);
    while (s.length < pad) s = '0' + s;
    return 'PR-' + s;
  }

  /* validate(input, ctx) → {ok, errors, values}
     - amount must be > 0
     - retention % 0..100
     - advance recovery >= 0
     - net (amount − retention − advance recovery, 2dp) must be >= 0
     - reference must be unique among ctx.existingReferences (case-insensitive)
     Values are always returned rounded to 2dp so the UI can persist exactly the
     numbers it displayed. */
  function validate(input, ctx) {
    var i = input || {};
    var c = ctx || {};
    var errors = [];
    var rawAmount = (i.amount_aed !== undefined && i.amount_aed !== null) ? i.amount_aed : i.amount;
    var amountNum = toNum(rawAmount, NaN);
    if (!isFinite(amountNum) || amountNum <= 0) errors.push('Amount must be greater than zero.');
    var rawPct = (i.retention_pct !== undefined && i.retention_pct !== null) ? i.retention_pct : i.retentionPct;
    if (rawPct === null || rawPct === undefined || rawPct === '') rawPct = 0;
    var pctNum = toNum(rawPct, NaN);
    if (!isFinite(pctNum) || pctNum < 0 || pctNum > 100) errors.push('Retention % must be between 0 and 100.');
    var rawAdv = (i.advance_recovery_aed !== undefined && i.advance_recovery_aed !== null) ? i.advance_recovery_aed : i.advanceRecoveryAed;
    if (rawAdv === null || rawAdv === undefined || rawAdv === '') rawAdv = 0;
    var advNum = toNum(rawAdv, NaN);
    if (!isFinite(advNum) || advNum < 0) errors.push('Advance recovery must be zero or greater.');

    var values = computeTotals({
      amount_aed: isFinite(amountNum) ? amountNum : 0,
      retention_pct: isFinite(pctNum) ? pctNum : 0,
      advance_recovery_aed: isFinite(advNum) ? advNum : 0
    });
    if (values.net_aed < 0) {
      errors.push('Net amount cannot be negative — retention ' + values.retention_aed.toFixed(2) +
        ' + advance recovery ' + values.advance_recovery_aed.toFixed(2) +
        ' exceeds the amount ' + values.amount_aed.toFixed(2) + '.');
    }

    var ref = (i.reference !== undefined && i.reference !== null) ? String(i.reference).trim() : '';
    if (ref && Array.isArray(c.existingReferences)) {
      var lower = ref.toLowerCase();
      var dup = c.existingReferences.some(function (r) {
        var other = (r && typeof r === 'object') ? r.reference : r;
        return String(other === null || other === undefined ? '' : other).trim().toLowerCase() === lower;
      });
      if (dup) errors.push('Reference ' + ref + ' is already used on this project.');
    }
    if (i.request_type !== undefined && i.request_type !== null && i.request_type !== '' && TYPES.indexOf(i.request_type) < 0) {
      errors.push('Request type must be subcontractor or supplier.');
    }
    return { ok: errors.length === 0, errors: errors, values: values };
  }

  /* ------------------------------------------------------------------ */
  /* Public test surface                                                 */
  /* ------------------------------------------------------------------ */
  var api = {
    computeRetention: computeRetention,
    computeNet: computeNet,
    computeTotals: computeTotals,
    computeAgeing: computeAgeing,
    ageingSummary: ageingSummary,
    nextReference: nextReference,
    validate: validate,
    buildPrintHtml: buildPrintHtml,
    round2: round2
  };
  if (typeof window !== 'undefined') {
    window.SF_modules = window.SF_modules || {};
    window.SF_modules[MODULE_ID] = api;
  }
  /* Pure functions above are always available; everything below needs the app. */
  if (!bridge() || typeof bridge().registerView !== 'function') return;

  /* ------------------------------------------------------------------ */
  /* UI formatting helpers                                               */
  /* ------------------------------------------------------------------ */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function hesc(value) {
    var h = helpers();
    return (typeof h.esc === 'function') ? h.esc(value) : esc(value);
  }
  function safeImage(src) {
    var h = helpers();
    if (typeof h.safeImgSrc === 'function') return h.safeImgSrc(src);
    if (!src || typeof src !== 'string') return '';
    var s = src.trim();
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^https:\/\/[a-z0-9.-]+\.supabase\.co\//i.test(s)) return esc(s);
    return '';
  }
  function fmtDate(value) {
    var h = helpers();
    if (typeof h.fmtDate === 'function') return h.fmtDate(value);
    if (value === null || value === undefined || value === '') return '—';
    var s = String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '—';
  }
  function fmtMoney(value, decimals) {
    var h = helpers();
    var d = (decimals === undefined || decimals === null) ? 2 : decimals;
    if (d === 2 && typeof h.money === 'function') return h.money(value);
    if (d === 0 && typeof h.money0 === 'function') return h.money0(value);
    var n = toNum(value, 0);
    var neg = n < 0;
    var abs = Math.abs(n);
    var txt;
    try {
      txt = abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    } catch (e) {
      txt = abs.toFixed(d);
    }
    return (neg ? '-AED ' : 'AED ') + txt;
  }
  function money(value) { return fmtMoney(value, 2); }
  function money0(value) { return fmtMoney(value, 0); }
  function errText(err) {
    return (err && err.message) ? err.message : String(err === null || err === undefined ? 'Unknown error' : err);
  }
  function userName() {
    var S = bridge();
    return (S && S.user && S.user.name) ? S.user.name : '—';
  }
  function projectId() {
    var S = bridge();
    if (!S) return null;
    if (S.currentProjectId) return S.currentProjectId;
    var st = S.data && S.data.state;
    return st ? st.currentProjectId : null;
  }
  function canManage() {
    var S = bridge();
    return !!(S && S.ui && typeof S.ui.canManage === 'function' && S.ui.canManage());
  }
  function todayIso() { return localToday(); }
  function addDaysIso(dateStr, days) {
    var ms = dateOnlyMs(dateStr);
    if (ms === null) return dateStr;
    var d = new Date(ms + days * 86400000);
    return d.getUTCFullYear() + '-' + padDatePart(d.getUTCMonth() + 1) + '-' + padDatePart(d.getUTCDate());
  }
  function paidTimestamp(dateStr) {
    if (!dateStr) return new Date().toISOString();
    var s = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T12:00:00.000Z';
    var d = new Date(s);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  function statusKey(status) {
    var s = String(status === null || status === undefined ? '' : status).toLowerCase();
    // Tolerant read of pre-migration / fixture rows: a request awaiting a
    // decision used to be stored as 'pending' (the migration's vocabulary is
    // 'submitted'). Unknown values fall back to draft instead of throwing.
    if (s === 'pending') s = 'submitted';
    return STATUSES.indexOf(s) >= 0 ? s : 'draft';
  }
  function statusLabel(status) {
    var map = { draft: 'statusDraft', submitted: 'statusSubmitted', approved: 'statusApproved', rejected: 'statusRejected', paid: 'statusPaid' };
    return tr(map[statusKey(status)]);
  }
  function statusClass(status) {
    return { draft: 'mut', submitted: 'warn', approved: 'info', rejected: 'bad', paid: 'ok' }[statusKey(status)] || 'mut';
  }
  function typeLabel(type) {
    return tr(type === 'supplier' ? 'typeSup' : 'typeSub');
  }
  function typeClass(type) {
    return type === 'supplier' ? 'pur' : 'info';
  }

  /* ------------------------------------------------------------------ */
  /* Parties (filtered from SF.parties by type)                          */
  /* ------------------------------------------------------------------ */
  function parties() {
    var S = bridge();
    return (S && Array.isArray(S.parties)) ? S.parties : [];
  }
  function eligibleParties() {
    return parties().filter(function (p) {
      return p && (p.type === 'subcontractor' || p.type === 'supplier');
    });
  }
  function partyOf(row) {
    var id = row && row.party_id;
    if (!id) return null;
    var list = parties();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }
  function partyLabel(p) {
    if (!p) return tr('unknownParty');
    var name = p.name || p.companyName || tr('unknownParty');
    var company = (p.companyName && p.companyName !== name) ? ' · ' + p.companyName : '';
    return name + company + ' (' + typeLabel(p.type) + ')';
  }
  function partyNameOf(row) {
    var p = partyOf(row);
    if (p) return p.name || p.companyName || '—';
    // Pre-migration rows may carry a denormalized display name instead of a
    // resolvable party_id — show it rather than "unknown party".
    if (row && row.party_name) return String(row.party_name);
    return tr('unknownParty');
  }

  /* ------------------------------------------------------------------ */
  /* Module state + data loading                                         */
  /* ------------------------------------------------------------------ */
  var state = {
    projectId: null,
    rows: [],
    error: null,
    loading: false,
    loadedAt: 0,
    seq: 0
  };
  var filters = { type: 'all', status: 'all', q: '' };
  var wired = false;

  function normalizeRow(raw) {
    var r = raw || {};
    var amount = toNum(r.amount_aed, 0);
    var pct = toNum(r.retention_pct, 0);
    var adv = toNum(r.advance_recovery_aed, 0);
    var retention = (r.retention_aed !== undefined && r.retention_aed !== null) ? toNum(r.retention_aed, 0) : computeRetention(amount, pct);
    var net = (r.net_aed !== undefined && r.net_aed !== null) ? toNum(r.net_aed, 0) : computeNet(amount, retention, adv);
    var type = TYPES.indexOf(r.request_type) >= 0 ? r.request_type : (TYPES.indexOf(r.party_type) >= 0 ? r.party_type : 'subcontractor');
    return {
      id: r.id,
      project_id: r.project_id,
      party_id: r.party_id || null,
      party_name: r.party_name || '',
      request_type: type,
      // Pre-migration/fixture rows used request_no for the reference column.
      reference: r.reference || r.request_no || '',
      description: r.description || '',
      amount_aed: amount,
      retention_pct: pct,
      retention_aed: retention,
      advance_recovery_aed: adv,
      net_aed: net,
      due_date: r.due_date || null,
      status: statusKey(r.status),
      requested_by: r.requested_by || '',
      approved_by: r.approved_by || '',
      approved_at: r.approved_at || null,
      rejected_reason: r.rejected_reason || r.rejection_reason || '',
      paid_at: r.paid_at || r.paid_date || null,
      payment_method: r.payment_method || '',
      notes: r.notes || '',
      created_at: r.created_at || null
    };
  }
  function snapshot(row) {
    var out = {};
    Object.keys(row || {}).forEach(function (k) {
      if (k.charAt(0) !== '_') out[k] = row[k];
    });
    return out;
  }
  function merge(base, patch) { return Object.assign({}, base || {}, patch || {}); }

  function fetchRows(pid) {
    var S = bridge();
    if (!S || !S.db || typeof S.db.selectStrict !== 'function') {
      return Promise.resolve({ rows: [], error: new Error('SiteForge bridge is not ready') });
    }
    return Promise.resolve()
      .then(function () { return S.db.selectStrict(TABLE, { project_id: pid }, 'created_at', false); })
      .then(function (r) {
        return { rows: (r && r.rows) || [], error: (r && r.error) || null };
      })
      .catch(function (err) { return { rows: [], error: err }; });
  }

  function load(pid) {
    var seq = ++state.seq;
    return fetchRows(pid).then(function (res) {
      if (seq !== state.seq) return;
      var S = bridge();
      if (!S || projectId() !== pid) return;
      state.rows = (res.rows || []).map(normalizeRow);
      state.error = res.error || null;
      state.loading = false;
      state.loadedAt = Date.now();
      paint();
    }).catch(function (err) {
      if (seq !== state.seq) return;
      state.error = err;
      state.loading = false;
      state.loadedAt = Date.now();
      paint();
    });
  }
  function reload() {
    var pid = projectId();
    if (!pid) return Promise.resolve();
    return load(pid);
  }

  function rowById(id) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i] && String(state.rows[i].id) === String(id)) return state.rows[i];
    }
    return null;
  }
  function statusCount(list) {
    return (list || []).length;
  }
  function sumNet(list) {
    return round2((list || []).reduce(function (s, r) { return s + toNum(r && r.net_aed, 0); }, 0));
  }
  function openRequests() {
    return state.rows.filter(function (r) { return r.status !== 'paid' && r.status !== 'rejected'; });
  }
  function filteredRows() {
    var q = String(filters.q || '').trim().toLowerCase();
    return state.rows.filter(function (r) {
      if (filters.type !== 'all' && r.request_type !== filters.type) return false;
      if (filters.status !== 'all' && r.status !== filters.status) return false;
      if (!q) return true;
      var hay = [r.reference, r.description, partyNameOf(r), r.requested_by, r.notes, r.status]
        .join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  /* ------------------------------------------------------------------ */
  /* HTML shells                                                         */
  /* ------------------------------------------------------------------ */
  function kpiHtml(cls, label, value, sub) {
    return '<div class="kpi ' + cls + '"><div class="lbl">' + hesc(label) + '</div>' +
      '<div class="val">' + hesc(value) + '</div>' +
      (sub ? '<div class="sub">' + hesc(sub) + '</div>' : '') + '</div>';
  }
  function loadingCardHtml() {
    return '<div class="card"><div class="empty"><div class="big">⟳</div>' + hesc(tr('loading')) + '</div></div>';
  }
  function errorCardHtml(err) {
    var message = errText(err);
    return '<div class="card" style="border-color:rgba(248,81,73,.45)">' +
      '<h3>⚠ ' + hesc(tr('migrationTitle')) + '</h3>' +
      '<p class="badc" style="margin-bottom:8px">' + hesc(tr('migrationBody')) + '</p>' +
      '<p class="mutc" style="margin-bottom:8px">' + hesc(tr('migrationRun')) +
      ' <code style="direction:ltr;unicode-bidi:embed">' + hesc(MIGRATION) + '</code> ' +
      hesc(tr('migrationRunAfter')) + '</p>' +
      '<p class="mutc mono" style="font-size:11px;white-space:pre-wrap;direction:ltr;unicode-bidi:embed">' + hesc(message) + '</p>' +
      '<div class="row" style="margin-top:12px"><button type="button" class="btn ghost sm" data-pr-action="reload">' + hesc(tr('retry')) + '</button></div>' +
      '</div>';
  }
  function createButtonHtml() {
    var disabled = !!state.error;
    return '<button type="button" class="btn" data-pr-action="create"' + (disabled ? ' disabled aria-disabled="true"' : '') + '>➕ ' + hesc(tr('newBtn')) + '</button>';
  }
  function headerHtml() {
    var project = (bridge() && bridge().currentProject) || {};
    var projectText = project.name ? (project.name + (project.code ? ' · ' + project.code : '')) : '';
    return '<h2 class="vt">🧾 ' + hesc(tr('title')) + '</h2>' +
      '<div class="vsub">' + hesc(tr('subtitle')) +
      (projectText ? ' · ' + hesc(projectText) : '') +
      '<span class="spacer"></span>' + createButtonHtml() + '</div>';
  }
  function kpisHtml() {
    var pending = state.rows.filter(function (r) { return r.status === 'submitted'; });
    var approved = state.rows.filter(function (r) { return r.status === 'approved'; });
    var paid = state.rows.filter(function (r) { return r.status === 'paid'; });
    var overdue = openRequests().filter(function (r) { return computeAgeing(r).overdue; });
    return '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px">' +
      kpiHtml('y', tr('kpiPending'), money0(sumNet(pending)), statusCount(pending) + ' ' + tr('requests')) +
      kpiHtml('b', tr('kpiApproved'), money0(sumNet(approved)), statusCount(approved) + ' ' + tr('requests')) +
      kpiHtml('r', tr('kpiOverdue'), money0(sumNet(overdue)), statusCount(overdue) + ' ' + tr('requests')) +
      kpiHtml('g', tr('kpiPaid'), money0(sumNet(paid)), statusCount(paid) + ' ' + tr('requests')) +
      '</div>';
  }
  function ageingHtml() {
    var a = ageingSummary(state.rows);
    var defs = [
      ['not_due', 'mut', tr('bNotDue')],
      ['1-30', 'warn', tr('b1_30')],
      ['31-60', 'warn', tr('b31_60')],
      ['61-90', 'bad', tr('b61_90')],
      ['90+', 'bad', tr('b90')]
    ];
    return '<div class="card" style="margin-bottom:14px"><h3>⏱ ' + hesc(tr('ageing')) + '</h3><div class="row">' +
      defs.map(function (d) {
        var b = a[d[0]] || { count: 0, value: 0 };
        return '<span class="tag ' + d[1] + '">' + hesc(d[2]) + ' · ' + b.count + ' · ' + hesc(money0(b.value)) + '</span>';
      }).join('') +
      '</div></div>';
  }
  function selectOptions(entries, value) {
    return entries.map(function (e) {
      return '<option value="' + hesc(e.value) + '"' + (String(value) === String(e.value) ? ' selected' : '') + '>' + hesc(e.label) + '</option>';
    }).join('');
  }
  function filtersHtml() {
    var typeEntries = [{ value: 'all', label: tr('all') }].concat(TYPES.map(function (type) {
      return { value: type, label: typeLabel(type) };
    }));
    var statusEntries = [{ value: 'all', label: tr('all') }].concat(STATUSES.map(function (status) {
      return { value: status, label: statusLabel(status) };
    }));
    return '<div class="card" style="margin-bottom:14px"><div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">' +
      '<div class="field" style="min-width:150px"><label for="prFilterType">' + hesc(tr('fType')) + '</label>' +
      '<select id="prFilterType" data-pr-filter="type">' + selectOptions(typeEntries, filters.type) + '</select></div>' +
      '<div class="field" style="min-width:150px"><label for="prFilterStatus">' + hesc(tr('fStatus')) + '</label>' +
      '<select id="prFilterStatus" data-pr-filter="status">' + selectOptions(statusEntries, filters.status) + '</select></div>' +
      '<div class="field" style="flex:1;min-width:220px"><label for="prFilterQ">' + hesc(tr('fSearch')) + '</label>' +
      '<input id="prFilterQ" type="search" data-pr-filter="q" value="' + hesc(filters.q) + '" placeholder="' + hesc(tr('searchPlaceholder')) + '" autocomplete="off"></div>' +
      '</div></div>';
  }
  function actionButton(action, cls, label, id) {
    return '<button type="button" class="btn ' + cls + ' sm" data-pr-action="' + hesc(action) + '"' +
      (id ? ' data-pr-id="' + hesc(String(id)) + '"' : '') + '>' + hesc(label) + '</button>';
  }
  function actionsHtml(row) {
    var out = [];
    var mgr = canManage();
    if (row.status === 'draft' || row.status === 'rejected') out.push(actionButton('submit', 'ok', '↗ ' + tr('submit'), row.id));
    if (mgr && row.status === 'submitted') {
      out.push(actionButton('approve', 'ok', '✓ ' + tr('approve'), row.id));
      out.push(actionButton('reject', 'bad', '✕ ' + tr('reject'), row.id));
    }
    if (mgr && row.status === 'approved') out.push(actionButton('pay', 'blue', '💳 ' + tr('pay'), row.id));
    if (mgr && (row.status === 'draft' || row.status === 'rejected' || row.status === 'submitted')) {
      out.push(actionButton('edit', 'ghost', '✎ ' + tr('edit'), row.id));
    }
    out.push(actionButton('print', 'ghost', '🖨 ' + tr('print'), row.id));
    if (mgr && row.status !== 'paid') out.push(actionButton('delete', 'bad', '✕ ' + tr('del'), row.id));
    return '<div class="row" style="gap:5px;flex-wrap:nowrap">' + out.join('') + '</div>';
  }
  function dueCellHtml(row) {
    if (!row.due_date) return '<span class="mutc">—</span>';
    var a = computeAgeing(row);
    var extra = '';
    if (a.overdue) extra = ' <span class="tag bad">' + a.daysOverdue + 'd ' + hesc(tr('overdueShort')) + '</span>';
    else if (!a.closed && a.daysUntilDue !== null && a.daysUntilDue <= 7) {
      extra = ' <span class="tag warn">' + hesc(tr('dueIn')) + ' ' + a.daysUntilDue + 'd</span>';
    }
    return '<span class="mono">' + hesc(fmtDate(row.due_date)) + '</span>' + extra;
  }
  function statusCellHtml(row) {
    var h = '<span class="tag ' + statusClass(row.status) + '">' + hesc(statusLabel(row.status)) + '</span>';
    if (row.status === 'rejected' && row.rejected_reason) {
      h += '<div class="mutc" style="font-size:10.5px;max-width:220px" title="' + hesc(tr('rejectedReason') + ': ' + row.rejected_reason) + '">' +
        hesc(tr('rejectedReason')) + ': ' + hesc(row.rejected_reason) + '</div>';
    } else if (row.status === 'approved' && row.approved_by) {
      h += '<div class="mutc" style="font-size:10.5px">' + hesc(row.approved_by) + '</div>';
    } else if (row.status === 'paid') {
      var paidMeta = [row.payment_method, row.paid_at ? fmtDate(row.paid_at) : ''].filter(Boolean).join(' · ');
      if (paidMeta) h += '<div class="mutc" style="font-size:10.5px">' + hesc(paidMeta) + '</div>';
    }
    return h;
  }
  function rowsHtml(list) {
    if (!list.length) {
      var msg = state.rows.length
        ? tr('empty') + ' (' + tr('all') + ' → ' + tr('fSearch') + ')'
        : tr('empty');
      return '<tr><td colspan="10"><div class="empty"><div class="big">🧾</div>' + hesc(msg) +
        (state.rows.length ? '' : '<div class="mutc" style="margin-top:6px">' + hesc(tr('emptyHint')) + '</div>') + '</div></td></tr>';
    }
    return list.map(function (row) {
      var desc = String(row.description || '');
      var shortDesc = desc.length > 90 ? desc.slice(0, 87) + '…' : desc;
      return '<tr>' +
        '<td class="mono">' + hesc(row.reference || '—') + '</td>' +
        '<td><span class="tag ' + typeClass(row.request_type) + '">' + hesc(typeLabel(row.request_type)) + '</span></td>' +
        '<td><b>' + hesc(partyNameOf(row)) + '</b>' + (partyOf(row) && partyOf(row).companyName && partyOf(row).companyName !== partyNameOf(row)
          ? '<div class="mutc" style="font-size:10.5px">' + hesc(partyOf(row).companyName) + '</div>' : '') + '</td>' +
        '<td title="' + hesc(desc) + '">' + hesc(shortDesc || '—') + '</td>' +
        '<td class="tright mono">' + hesc(money(row.amount_aed)) + '</td>' +
        '<td class="tright mono">' + hesc(money(row.retention_aed)) +
          '<div class="mutc" style="font-size:10.5px">' + hesc(String(round2(row.retention_pct))) + '% · ' + hesc(tr('advanceShort')) + ' ' + hesc(money(row.advance_recovery_aed)) + '</div></td>' +
        '<td class="tright mono"><b>' + hesc(money(row.net_aed)) + '</b></td>' +
        '<td>' + dueCellHtml(row) + '</td>' +
        '<td>' + statusCellHtml(row) + '</td>' +
        '<td class="tright" style="white-space:nowrap">' + actionsHtml(row) + '</td>' +
        '</tr>';
    }).join('');
  }
  function tableCardHtml() {
    return '<div class="card"><h3>🧾 ' + hesc(tr('tableTitle')) +
      ' · <span id="prRowCount">' + filteredRows().length + ' / ' + state.rows.length + '</span></h3>' +
      '<div class="scroll-x" tabindex="0" role="region" aria-label="' + hesc(tr('tableAria')) + '">' +
      '<table><thead><tr>' +
      '<th>' + hesc(tr('colRef')) + '</th>' +
      '<th>' + hesc(tr('colType')) + '</th>' +
      '<th>' + hesc(tr('colParty')) + '</th>' +
      '<th>' + hesc(tr('colDesc')) + '</th>' +
      '<th class="tright">' + hesc(tr('colAmount')) + '</th>' +
      '<th class="tright">' + hesc(tr('colRetention')) + '</th>' +
      '<th class="tright">' + hesc(tr('colNet')) + '</th>' +
      '<th>' + hesc(tr('colDue')) + '</th>' +
      '<th>' + hesc(tr('colStatus')) + '</th>' +
      '<th class="tright">' + hesc(tr('colActions')) + '</th>' +
      '</tr></thead><tbody id="prTableBody">' + rowsHtml(filteredRows()) + '</tbody></table></div></div>';
  }
  function shellHtml() {
    if (state.loading && !state.loadedAt) return headerHtml() + loadingCardHtml();
    if (state.error) return headerHtml() + errorCardHtml(state.error);
    if (!state.rows.length) return headerHtml() + kpisHtml() + '<div class="card"><div class="empty"><div class="big">🧾</div>' +
      hesc(tr('empty')) + '<div class="mutc" style="margin-top:6px">' + hesc(tr('emptyHint')) + '</div></div></div>';
    return headerHtml() + kpisHtml() + ageingHtml() + filtersHtml() + tableCardHtml();
  }
  function paint() {
    if (typeof document === 'undefined') return;
    var root = document.getElementById('prRoot');
    if (!root) return; // another view rendered meanwhile — never paint over it
    root.innerHTML = shellHtml();
  }
  function noProjectHtml() {
    return '<h2 class="vt">🧾 ' + hesc(tr('title')) + '</h2>' +
      '<div class="card"><div class="empty"><div class="big">🏗</div>' + hesc(tr('noProject')) + '</div></div>';
  }
  function refreshTable() {
    if (typeof document === 'undefined') return;
    var body = document.getElementById('prTableBody');
    if (body) body.innerHTML = rowsHtml(filteredRows());
    var count = document.getElementById('prRowCount');
    if (count) count.textContent = filteredRows().length + ' / ' + state.rows.length;
  }

  /* ------------------------------------------------------------------ */
  /* Delegated events (attached once, only inside our own root)          */
  /* ------------------------------------------------------------------ */
  function onFilterChange(event) {
    var target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    var key = target.getAttribute('data-pr-filter');
    if (key !== 'type' && key !== 'status') return;
    filters[key] = target.value || 'all';
    refreshTable();
  }
  function onFilterInput(event) {
    var target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    if (target.getAttribute('data-pr-filter') !== 'q') return;
    filters.q = target.value || '';
    refreshTable();
  }
  function onRootClick(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    var button = target.closest('[data-pr-action]');
    if (!button || !button.closest || !button.closest('#prRoot')) return;
    if (button.disabled) return;
    event.preventDefault();
    runAction(button.getAttribute('data-pr-action'), button.getAttribute('data-pr-id') || '');
  }
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('click', onRootClick);
    document.addEventListener('change', onFilterChange);
    document.addEventListener('input', onFilterInput);
  }

  /* ------------------------------------------------------------------ */
  /* Workflow actions                                                    */
  /* ------------------------------------------------------------------ */
  function requireManager() {
    var S = bridge();
    if (canManage()) return true;
    if (S && S.ui && typeof S.ui.toast === 'function') S.ui.toast(tr('managerOnly'), 'bad');
    return false;
  }
  function explicitLog(action, id, label, before, after) {
    var S = bridge();
    if (!S || !S.db || typeof S.db.log !== 'function') return Promise.resolve();
    try {
      return Promise.resolve(S.db.log(action, TABLE, id, label, projectId(), before || null, after || null))
        .catch(function () { /* logTransaction already surfaces audit failures */ });
    } catch (e) {
      return Promise.resolve();
    }
  }
  function toast(message, cls) {
    var S = bridge();
    if (S && S.ui && typeof S.ui.toast === 'function') S.ui.toast(message, cls || '');
  }
  function changeRequest(row, patch, logLabel, toastMessage) {
    var S = bridge();
    if (!S || !row) return Promise.resolve();
    var before = snapshot(row);
    return Promise.resolve(S.db.update(TABLE, row.id, patch)).then(function () {
      return explicitLog('update', row.id, row.reference + ' · ' + logLabel, before, merge(before, patch));
    }).then(function () {
      toast(toastMessage, 'ok');
      return reload();
    });
  }
  function submitRequest(row) {
    if (!row) return Promise.resolve();
    if (row.status !== 'draft' && row.status !== 'rejected') { toast(tr('badTransition'), 'bad'); return Promise.resolve(); }
    var patch = { status: 'submitted', rejected_reason: null };
    if (!row.requested_by) patch.requested_by = userName();
    return changeRequest(row, patch, tr('logSubmitted'), tr('submittedToast'));
  }
  function approveRequest(row) {
    if (!row) return Promise.resolve();
    if (!requireManager()) return Promise.resolve();
    if (row.status !== 'submitted') { toast(tr('badTransition'), 'bad'); return Promise.resolve(); }
    var patch = {
      status: 'approved',
      approved_by: userName(),
      approved_at: new Date().toISOString(),
      rejected_reason: null
    };
    return changeRequest(row, patch, tr('logApproved'), tr('approvedToast'));
  }
  function rejectRequest(row) {
    var S = bridge();
    if (!row || !S || !S.ui) return Promise.resolve();
    if (!requireManager()) return Promise.resolve();
    if (row.status !== 'submitted') { toast(tr('badTransition'), 'bad'); return Promise.resolve(); }
    S.ui.openModal(
      '✕ ' + hesc(tr('rejectTitle')) + ' · ' + hesc(row.reference || ''),
      '<div class="field"><label for="prRejectReason">' + hesc(tr('rejectReason')) + '</label>' +
      '<textarea id="prRejectReason" rows="3" aria-required="true" placeholder="' + hesc(tr('rejectReasonPh')) + '"></textarea></div>' +
      '<div class="ferror" id="prRejectErr" role="alert"></div>',
      '<button type="button" class="btn ghost" id="prRejectCancel">' + hesc(tr('cancel')) + '</button>' +
      '<button type="button" class="btn bad" id="prRejectBtn">' + hesc(tr('reject')) + '</button>'
    );
    var cancel = document.getElementById('prRejectCancel');
    if (cancel) cancel.onclick = function () { S.ui.closeModal(); };
    var btn = document.getElementById('prRejectBtn');
    var reasonEl = document.getElementById('prRejectReason');
    if (reasonEl && reasonEl.focus) { try { reasonEl.focus({ preventScroll: true }); } catch (e) { reasonEl.focus(); } }
    if (!btn) return Promise.resolve();
    btn.onclick = function () {
      var reason = (reasonEl && reasonEl.value ? reasonEl.value : '').trim();
      var errEl = document.getElementById('prRejectErr');
      if (!reason) {
        if (errEl) errEl.textContent = '✗ ' + tr('rejectReasonRequired');
        if (reasonEl && reasonEl.focus) reasonEl.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = tr('saving');
      var patch = { status: 'rejected', rejected_reason: reason };
      var before = snapshot(row);
      Promise.resolve(S.db.update(TABLE, row.id, patch)).then(function () {
        return explicitLog('update', row.id, row.reference + ' · ' + tr('logRejected') + ': ' + reason, before, merge(before, patch));
      }).then(function () {
        S.ui.closeModal();
        toast(tr('rejectedToast'), 'ok');
        return reload();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = tr('reject');
        if (errEl) errEl.textContent = '✗ ' + errText(err);
      });
    };
    return Promise.resolve();
  }
  function payRequest(row) {
    var S = bridge();
    if (!row || !S || !S.ui) return Promise.resolve();
    if (!requireManager()) return Promise.resolve();
    if (row.status !== 'approved') { toast(tr('badTransition'), 'bad'); return Promise.resolve(); }
    S.ui.openFormModal({
      title: '💳 ' + tr('payTitle') + ' · ' + (row.reference || ''),
      values: { payment_method: '', paid_at: todayIso() },
      fields: [
        {
          key: 'payment_method',
          label: tr('paymentMethod'),
          required: true,
          type: 'select',
          options: ['Bank Transfer', 'Cheque', 'Cash', 'Letter of Credit', 'Other']
        },
        { key: 'paid_at', label: tr('paidDate'), required: true, type: 'date', default: todayIso() }
      ],
      onSubmit: function (d) {
        if (!d.payment_method) throw new Error(tr('paymentMethodRequired'));
        if (!d.paid_at) throw new Error(tr('paidDateRequired'));
        var patch = {
          status: 'paid',
          payment_method: d.payment_method,
          paid_at: paidTimestamp(d.paid_at)
        };
        var before = snapshot(row);
        return Promise.resolve(S.db.update(TABLE, row.id, patch)).then(function () {
          return explicitLog('update', row.id, row.reference + ' · ' + tr('logPaid') + ' · ' + d.payment_method, before, merge(before, patch));
        }).then(function () {
          toast(tr('paidToast'), 'ok');
          return reload();
        });
      }
    });
    return Promise.resolve();
  }
  function deleteRequest(row) {
    var S = bridge();
    if (!row || !S) return Promise.resolve();
    if (!requireManager()) return Promise.resolve();
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(tr('deleteConfirm') + ' ' + (row.reference || '') + '?')) return Promise.resolve();
    }
    var before = snapshot(row);
    return Promise.resolve(S.db.remove(TABLE, row.id)).then(function () {
      return explicitLog('delete', row.id, row.reference + ' · ' + tr('logDeleted'), before, null);
    }).then(function () {
      toast(tr('deletedToast'), 'ok');
      return reload();
    });
  }
  function printRequest(row) {
    var S = bridge();
    if (!row) return Promise.resolve();
    if (typeof window === 'undefined' || typeof window.open !== 'function') return Promise.resolve();
    var html = buildPrintHtml(row, {
      company: (S && S.company) || {},
      project: (S && S.currentProject) || {},
      parties: parties(),
      language: currentLang(),
      user: (S && S.user) || null,
      today: todayIso()
    });
    var win = null;
    try { win = window.open('', '_blank'); } catch (e) { win = null; }
    if (!win) { toast(tr('popupBlocked'), 'bad'); return Promise.resolve(); }
    try { win.opener = null; } catch (e) { /* cross-window guard best effort */ }
    win.document.write(html);
    win.document.close();
    setTimeout(function () {
      try { win.focus(); win.print(); } catch (e) { /* user may close it first */ }
      setTimeout(function () { try { win.close(); } catch (e) { /* already closed */ } }, 700);
    }, 350);
    return Promise.resolve();
  }

  function runAction(action, id) {
    var S = bridge();
    return Promise.resolve().then(function () {
      if (!S) return;
      if (action === 'create') return openCreate();
      if (action === 'reload') {
        state.loadedAt = 0;
        state.loading = true;
        paint();
        return load(projectId());
      }
      var row = rowById(id);
      if (!row) { toast(tr('notFound'), 'bad'); return; }
      if (action === 'submit') return submitRequest(row);
      if (action === 'approve') return approveRequest(row);
      if (action === 'reject') return rejectRequest(row);
      if (action === 'pay') return payRequest(row);
      if (action === 'edit') return openEdit(row);
      if (action === 'print') return printRequest(row);
      if (action === 'delete') return deleteRequest(row);
    }).catch(function (err) {
      toast(errText(err), 'bad');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Create / edit forms                                                 */
  /* ------------------------------------------------------------------ */
  function partyOptionsFor(type, ensureId) {
    var list = eligibleParties().filter(function (p) { return p && p.type === type; }).map(function (p) {
      return { value: p.id, label: partyLabel(p) };
    });
    if (ensureId && !list.some(function (o) { return String(o.value) === String(ensureId); })) {
      var current = partyOf({ party_id: ensureId });
      list.unshift({ value: ensureId, label: (current ? partyLabel(current) : String(ensureId).slice(0, 8)) + ' (' + tr('current') + ')' });
    }
    return list;
  }
  function defaultRequestType() {
    var list = eligibleParties();
    if (list.some(function (p) { return p.type === 'subcontractor'; })) return 'subcontractor';
    if (list.some(function (p) { return p.type === 'supplier'; })) return 'supplier';
    return 'subcontractor';
  }
  function formFields(values) {
    var v = values || {};
    var type = TYPES.indexOf(v.request_type) >= 0 ? v.request_type : defaultRequestType();
    return [
      { key: 'reference', label: tr('reference'), required: true, default: nextReference(state.rows), full: false },
      {
        key: 'request_type',
        label: tr('requestType'),
        required: true,
        type: 'select',
        options: [{ value: 'subcontractor', label: tr('typeSub') }, { value: 'supplier', label: tr('typeSup') }],
        default: type
      },
      { key: 'party_id', label: tr('party'), required: true, type: 'select', options: partyOptionsFor(type, v.party_id), full: false },
      { key: 'description', label: tr('description'), required: true, full: true, type: 'textarea', rows: 2 },
      { key: 'amount_aed', label: tr('amount'), required: true, type: 'number', step: '0.01', min: '0.01' },
      { key: 'retention_pct', label: tr('retentionPct'), type: 'number', step: '0.01', min: '0', default: 0 },
      { key: 'advance_recovery_aed', label: tr('advanceRecovery'), type: 'number', step: '0.01', min: '0', default: 0 },
      { key: 'due_date', label: tr('dueDate'), type: 'date', default: addDaysIso(todayIso(), 30) },
      { key: 'notes', label: tr('notes'), full: true, type: 'textarea', rows: 2 }
    ];
  }
  function wirePartyFilter() {
    if (typeof document === 'undefined') return;
    var typeEl = document.getElementById('f_request_type');
    var partyEl = document.getElementById('f_party_id');
    if (!typeEl || !partyEl) return;
    function fill(keep) {
      var list = partyOptionsFor(typeEl.value, null);
      var html = '<option value="">— ' + hesc(tr('party')) + ' —</option>' + list.map(function (o) {
        return '<option value="' + hesc(o.value) + '"' + (String(o.value) === String(keep) ? ' selected' : '') + '>' + hesc(o.label) + '</option>';
      }).join('');
      partyEl.innerHTML = html;
      if (keep) partyEl.value = String(keep);
    }
    var current = partyEl.value;
    fill(current);
    typeEl.addEventListener('change', function () { fill(''); });
  }
  function formInput(d) {
    return {
      reference: d.reference,
      request_type: d.request_type,
      party_id: d.party_id,
      description: d.description,
      amount_aed: d.amount_aed,
      retention_pct: d.retention_pct,
      advance_recovery_aed: d.advance_recovery_aed,
      due_date: d.due_date,
      notes: d.notes
    };
  }
  function payloadFromForm(d, values) {
    return {
      project_id: projectId(),
      party_id: d.party_id || null,
      request_type: d.request_type,
      reference: String(d.reference || '').trim(),
      description: String(d.description || '').trim(),
      amount_aed: values.amount_aed,
      retention_pct: values.retention_pct,
      retention_aed: values.retention_aed,
      advance_recovery_aed: values.advance_recovery_aed,
      net_aed: values.net_aed,
      due_date: d.due_date || null,
      notes: d.notes ? String(d.notes) : null
    };
  }
  function isDuplicateReferenceError(err) {
    var message = errText(err);
    return /duplicate key|unique constraint|already exists|23505/i.test(message) &&
      /reference|payment_requests|project_id/i.test(message);
  }
  function insertWithUniqueReference(payload, existingReferences) {
    var S = bridge();
    var refs = (existingReferences || []).slice();
    var attempt = 0;
    function attemptInsert() {
      var data = merge(payload, { reference: payload.reference });
      return Promise.resolve(S.db.insert(TABLE, data)).catch(function (err) {
        if (attempt >= 5 || !isDuplicateReferenceError(err)) throw err;
        attempt += 1;
        if (data.id) delete data.id;
        refs.push(payload.reference);
        payload.reference = nextReference(refs);
        return attemptInsert();
      });
    }
    return attemptInsert();
  }
  function openCreate() {
    var S = bridge();
    if (!S || !S.ui || typeof S.ui.openFormModal !== 'function') return;
    if (!eligibleParties().length) {
      toast(tr('needParty'), 'bad');
      return;
    }
    S.ui.openFormModal({
      title: '➕ ' + tr('createTitle'),
      fields: formFields({}),
      onSubmit: function (d) {
        var existing = state.rows.map(function (r) { return r.reference; });
        var input = formInput(d);
        var ref = String(d.reference || '').trim() || nextReference(existing);
        input.reference = ref;
        var result = validate(input, { existingReferences: existing });
        if (!result.ok) throw new Error(result.errors.join('\n'));
        var payload = payloadFromForm(merge(d, { reference: ref }), result.values);
        payload.status = d.status === 'submitted' ? 'submitted' : 'draft';
        payload.requested_by = userName();
        payload.reference = ref;
        return insertWithUniqueReference(payload, existing).then(function (created) {
          var id = created && created.id ? created.id : null;
          return explicitLog('create', id, ref + ' · ' + tr('logCreated'), null, payload);
        }).then(function () {
          toast(tr('createdToast'), 'ok');
          return reload();
        });
      }
    });
    wirePartyFilter();
  }
  function openEdit(row) {
    var S = bridge();
    if (!row || !S || !S.ui || typeof S.ui.openFormModal !== 'function') return;
    if (!requireManager()) return;
    var values = {
      reference: row.reference,
      request_type: row.request_type,
      party_id: row.party_id || '',
      description: row.description,
      amount_aed: row.amount_aed,
      retention_pct: row.retention_pct,
      advance_recovery_aed: row.advance_recovery_aed,
      due_date: row.due_date || '',
      notes: row.notes || ''
    };
    S.ui.openFormModal({
      title: '✎ ' + tr('editTitle') + ' · ' + (row.reference || ''),
      values: values,
      fields: formFields(values),
      onSubmit: function (d) {
        var input = formInput(d);
        var ref = String(d.reference || '').trim();
        var others = state.rows.filter(function (r) { return String(r.id) !== String(row.id); }).map(function (r) { return r.reference; });
        var result = validate(input, { existingReferences: others });
        if (!result.ok) throw new Error(result.errors.join('\n'));
        var patch = {
          party_id: d.party_id || null,
          request_type: d.request_type,
          reference: ref,
          description: String(d.description || '').trim(),
          amount_aed: result.values.amount_aed,
          retention_pct: result.values.retention_pct,
          retention_aed: result.values.retention_aed,
          advance_recovery_aed: result.values.advance_recovery_aed,
          net_aed: result.values.net_aed,
          due_date: d.due_date || null,
          notes: d.notes ? String(d.notes) : null
        };
        var before = snapshot(row);
        return Promise.resolve(S.db.update(TABLE, row.id, patch)).then(function () {
          return explicitLog('update', row.id, ref + ' · ' + tr('logUpdated'), before, merge(before, patch));
        }).then(function () {
          toast(tr('updatedToast'), 'ok');
          return reload();
        });
      }
    });
    wirePartyFilter();
  }

  /* ------------------------------------------------------------------ */
  /* Printable document (company branding, dir-aware, escaped)           */
  /* ------------------------------------------------------------------ */
  function buildPrintHtml(row, ctx) {
    var c = ctx || {};
    var company = c.company || {};
    var project = c.project || {};
    var list = Array.isArray(c.parties) ? c.parties : [];
    var language = c.language === 'ar' ? 'ar' : 'en';
    var rtl = language === 'ar';
    var PL = PRINT_L[language] || PRINT_L.en;
    var r = row || {};
    var party = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === String(r.party_id)) { party = list[i]; break; }
    }
    var partyName = party ? (party.name || party.companyName || '—') : '—';
    var partyCompany = (party && party.companyName && party.companyName !== partyName) ? party.companyName : '';
    var partyType = party ? (PL[party.type] || party.type || '') : '';
    var partyLines = party ? [
      partyCompany,
      party.contactPerson ? PL.contact + ': ' + party.contactPerson : '',
      party.phone ? PL.phone + ': ' + party.phone : '',
      party.email ? PL.email + ': ' + party.email : '',
      party.address ? PL.address + ': ' + party.address : ''
    ].filter(Boolean) : [];
    var logo = safeImage(company.logo_data || company.logo);
    var statusLabelPrint = PL[statusKey(r.status)] || statusKey(r.status);
    var dueDate = r.due_date ? fmtDate(r.due_date) : '—';
    var createdDate = r.created_at ? fmtDate(r.created_at) : fmtDate(c.today || '');
    var approvedMeta = [r.approved_by || '', r.approved_at ? fmtDate(r.approved_at) : ''].filter(Boolean).join(' · ');
    var paymentMeta = [r.payment_method || '', r.paid_at ? fmtDate(r.paid_at) : ''].filter(Boolean).join(' · ');
    var alignEnd = rtl ? 'left' : 'right';
    var alignStart = rtl ? 'right' : 'left';
    var css = 'body{font-family:Arial,sans-serif;padding:34px;max-width:820px;margin:auto;color:#111}' +
      'h1{font-size:20px;margin:0}' +
      '.meta{font-size:12px;line-height:1.65;color:#444}' +
      'table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}' +
      'th{text-align:' + alignStart + ';background:#f3f3f3;padding:8px;border-bottom:2px solid #111}' +
      'td{padding:8px;border-bottom:1px solid #ddd;vertical-align:top}' +
      '.right{text-align:' + alignEnd + '}' +
      '.total{font-weight:800;background:#fafafa}' +
      '.grid{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin:16px 0}' +
      '.sig{display:grid;grid-template-columns:1fr 1fr 1fr;gap:26px;margin-top:52px}' +
      '.sig-line{border-bottom:1px solid #111;height:38px}' +
      '.sig-lbl{font-size:10px;text-transform:uppercase;font-weight:800;margin-top:4px}' +
      '.sig-name{font-size:11px;color:#555;margin-top:2px}' +
      'body[dir=rtl]{text-align:right}' +
      '@media print{body{padding:0}}';
    var html = '<!DOCTYPE html><html lang="' + language + '" dir="' + (rtl ? 'rtl' : 'ltr') + '"><head><meta charset="utf-8">' +
      '<title>' + hesc(PL.docTitle + ' ' + (r.reference || '')) + '</title><style>' + css + '</style></head><body dir="' + (rtl ? 'rtl' : 'ltr') + '">' +
      '<div style="display:flex;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:12px">' +
      '<div>' + (logo ? '<img src="' + logo + '" alt="logo" style="height:64px;max-width:240px;object-fit:contain">' : '') +
      '<h1>' + hesc(company.name || 'SITEFORGE') + '</h1>' +
      '<div class="meta">' + hesc(company.address || '') +
      (company.tax_id ? '<br>' + hesc(PL.trn) + ': ' + hesc(company.tax_id) : '') +
      (company.phone ? '<br>' + hesc(company.phone) : '') + '</div></div>' +
      '<div style="text-align:' + alignEnd + '"><h1>' + hesc(PL.docTitle) + '</h1>' +
      '<div class="meta"><b>' + hesc(PL.reference) + ': ' + hesc(r.reference || '—') + '</b><br>' +
      hesc(PL.date) + ': ' + hesc(createdDate) + '<br>' +
      hesc(PL.status) + ': ' + hesc(statusLabelPrint) +
      '<br>' + hesc(PL.dueDate) + ': ' + hesc(dueDate) + '</div></div></div>' +
      '<div class="grid">' +
      '<div><div class="sig-lbl">' + hesc(PL.project) + '</div><div class="meta">' +
      hesc(project.name || '—') + (project.code ? ' (' + hesc(project.code) + ')' : '') +
      (project.location ? '<br>' + hesc(project.location) : '') +
      (project.plot_no ? '<br>Plot ' + hesc(project.plot_no) : '') +
      (project.client ? '<br>Client: ' + hesc(project.client) : '') + '</div></div>' +
      '<div><div class="sig-lbl">' + hesc(PL.payableTo) + '</div><div class="meta"><b>' + hesc(partyName) + '</b>' +
      (partyCompany ? '<br>' + hesc(partyCompany) : '') +
      (partyType ? '<br>' + hesc(PL.type) + ': ' + hesc(partyType) : '') +
      (partyLines.length ? '<br>' + hesc(partyLines.join(' · ')) : '') + '</div></div></div>' +
      '<table><thead><tr><th>' + hesc(PL.description) + '</th><th class="right">' + hesc(PL.amount) + '</th></tr></thead><tbody>' +
      '<tr><td>' + hesc(r.description || '—') + '</td><td class="right">' + hesc(fmtMoney(r.amount_aed, 2)) + '</td></tr>' +
      '<tr><td>' + hesc(PL.retention) + ' (' + hesc(String(round2(r.retention_pct))) + '%)</td><td class="right">-' + hesc(fmtMoney(r.retention_aed, 2)) + '</td></tr>' +
      '<tr><td>' + hesc(PL.advance) + '</td><td class="right">-' + hesc(fmtMoney(r.advance_recovery_aed, 2)) + '</td></tr>' +
      '<tr class="total"><td>' + hesc(PL.net) + '</td><td class="right">' + hesc(fmtMoney(r.net_aed, 2)) + '</td></tr>' +
      '</tbody></table>' +
      '<div class="meta">' +
      '<b>' + hesc(PL.requestedBy) + ':</b> ' + hesc(r.requested_by || '—') +
      '<br><b>' + hesc(PL.approvedBy) + ':</b> ' + hesc(approvedMeta || '—') +
      (paymentMeta ? '<br><b>' + hesc(PL.payment) + ':</b> ' + hesc(paymentMeta) : '') +
      (r.notes ? '<br><b>' + hesc(PL.notes) + ':</b> ' + hesc(r.notes) : '') + '</div>' +
      '<div class="sig">' +
      '<div><div class="sig-line"></div><div class="sig-lbl">' + hesc(PL.requestedBy) + '</div><div class="sig-name">' + hesc(r.requested_by || '') + '</div></div>' +
      '<div><div class="sig-line"></div><div class="sig-lbl">' + hesc(PL.approvedBy) + '</div><div class="sig-name">' + hesc(approvedMeta || '') + '</div></div>' +
      '<div><div class="sig-line"></div><div class="sig-lbl">' + hesc(PL.receivedBy) + '</div><div class="sig-name"></div></div>' +
      '</div>' +
      '<div class="meta" style="margin-top:26px;font-size:10.5px;color:#666;border-top:1px solid #ddd;padding-top:8px">' + hesc(PL.footer) + '</div>' +
      '</body></html>';
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* View registration                                                   */
  /* ------------------------------------------------------------------ */
  function render(el) {
    try {
      if (!el) return;
      wire();
      el.innerHTML = '<div id="prRoot"></div>';
      var root = document.getElementById('prRoot');
      if (!bridge() || !projectId()) {
        if (root) root.innerHTML = noProjectHtml();
        return;
      }
      var pid = projectId();
      if (state.projectId !== pid) {
        state.projectId = pid;
        state.rows = [];
        state.error = null;
        state.loading = true;
        state.loadedAt = 0;
        state.seq += 1;
      }
      paint();
      if (!state.loading) state.loading = true;
      load(pid);
    } catch (err) {
      try {
        el.innerHTML = '<div class="card"><div class="empty"><div class="big">⚠</div>' + hesc(errText(err)) + '</div></div>';
      } catch (e) { /* never throw out of render */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Executive Approvals Queue integration                               */
  /* The queue calls registered sources synchronously while it renders,  */
  /* so it can only surface rows this module has already cached for the  */
  /* open project: once the Payment Requests view has been opened, its   */
  /* submitted requests appear in the single approvals queue. The queue  */
  /* performs a CAS update on status='submitted' (pendingStatus) and     */
  /* writes approved_by/approved_at itself; our own approve/reject       */
  /* buttons remain available as the project-scoped path.                */
  /* ------------------------------------------------------------------ */
  function approvalsSource() {
    var S = bridge();
    if (!S) return [];
    var pid = projectId();
    if (!pid || state.projectId !== pid) return [];
    var projectCode = (S.currentProject && S.currentProject.code) || '—';
    return state.rows.filter(function (r) {
      return r.status === 'submitted';
    }).map(function (r) {
      var label = r.reference || '';
      var party = partyNameOf(r);
      if (party && party !== tr('unknownParty')) label += ' · ' + party;
      var desc = String(r.description || '');
      if (desc) label += ' · ' + desc.slice(0, 40);
      return {
        type: 'PR',
        cat: 'Payment Requests',
        id: r.id,
        table: TABLE,
        label: label,
        amount: toNum(r.net_aed, 0),
        project: projectCode,
        submitter: r.requested_by || '—',
        pendingStatus: 'submitted',
        // The approvals queue writes reject reasons to rejection_reason by
        // default; this module's column is rejected_reason (migration spec).
        rejectionColumn: 'rejected_reason'
      };
    });
  }
  function approvalsRefresh() {
    // A batch decision in the queue changed statuses — re-fetch our cache.
    try { return reload(); } catch (e) { return Promise.resolve(); }
  }

  var bridgeRef = bridge();
  bridgeRef.registerView({
    id: MODULE_ID,
    nav: { section: 'project', icon: '🧾', label: 'Payment Requests', labelAr: 'طلبات الدفع' },
    roles: ['director', 'controller', 'super'],
    render: render
  });
  if (typeof bridgeRef.registerApprovalsSource === 'function') bridgeRef.registerApprovalsSource(approvalsSource);
  if (typeof bridgeRef.registerApprovalsRefresh === 'function') bridgeRef.registerApprovalsRefresh(approvalsRefresh);
})();
