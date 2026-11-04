/* SUPERSEDED — kept for reference only, NOT loaded by index.html.
 * The behaviour in this file is implemented natively in scripts/app.js as of v29.3.0
 * (notifications/alerts, commitments vs actuals, PO->bill, BOQ valuation, IPC->AR sync,
 * worker-linked timesheets, unified payroll run, variation lines, cross-project queue,
 * WebP photos). Loading it alongside the native implementation double-overrides globals;
 * app.js now also exposes a compatibility surface so this style of patch cannot crash
 * with "Cannot read properties of undefined (reading 'boq')".
 * See docs/ENHANCEMENTS.md section 1.6. */
/**
 * SiteForge ERP v29.2 — Complete End-to-End Workflow & Notification Upgrade Module
 * Implements:
 * 1. Persistent Notification & Alert Dismissal Engine (Fixes stuck badge & panel)
 * 2. Commitments vs. Actuals Separation + 1-Click PO -> Supplier Payable Invoice
 * 3. BOQ-Driven IPC Valuation + Automated IPC <-> AR Payments Sync
 * 4. Worker ID Link in Timesheets + Unified Monthly Payroll Run (Basic + OT - Loan + Payslips + Expense)
 * 5. Auto-Create BOQ Variation Lines on Change Order Approval
 * 6. Cross-Project Executive Approvals Queue (Company-wide visibility on login)
 * 7. Site Report Cloud Storage Offloading (`siteforge-files` WebP) + Schedule Progress Sync
 */

(function (window, document) {
  'use strict';

  var SF = window.SiteForge || {};
  function getState() { return SF.state || window.state; }
  function getSB() { return (SF.getSupabase && SF.getSupabase()) || window.supabase; }
  function esc(s) { return (SF.esc || window.esc || String)(s == null ? '' : s); }
  function money(n) { return (SF.money || window.money)(n); }
  function money0(n) { return (SF.money0 || window.money0)(n); }
  function fmtDate(d) { return (SF.fmtDate || window.fmtDate)(d); }
  function today() { return (SF.today || window.today)(); }
  function toast(m, c) { return (SF.toast || window.toast)(m, c); }
  function openModal(t, b, f, o) { return (SF.openModal || window.openModal)(t, b, f, o); }
  function closeModal() { return (SF.closeModal || window.closeModal)(); }

  /* =========================================================================
   * 1. NOTIFICATION & ALERT DISMISSAL ENGINE (Clears DB + Compliance + Budget)
   * ========================================================================= */
  var DISMISSED_ALERTS_KEY = 'sf_dismissed_alerts_v2';

  function getDismissedAlerts() {
    try { return JSON.parse(localStorage.getItem(DISMISSED_ALERTS_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function saveDismissedAlerts(map) {
    try { localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(map || {})); }
    catch (e) {}
  }

  function alertSig(prefix, a) {
    return prefix + ':' + (a.title || '') + '|' + (a.detail || '');
  }

  window.getActiveComplianceAlerts = function () {
    var dismissed = getDismissedAlerts();
    var raw = typeof window.collectAlerts === 'function' ? window.collectAlerts() : [];
    return raw.filter(function (a) { return !dismissed[alertSig('comp', a)]; });
  };

  window.getActiveBudgetAlerts = function () {
    var dismissed = getDismissedAlerts();
    var raw = typeof window.collectBudgetAlerts === 'function' ? window.collectBudgetAlerts() : [];
    return raw.filter(function (a) { return !dismissed[alertSig('bud', a)]; });
  };

  window.updateNotifBadge = function () {
    var st = getState();
    if (!st) return;
    var alerts = window.getActiveComplianceAlerts();
    var budgetAlerts = window.getActiveBudgetAlerts();
    var unread = (st.notifications || []).filter(function (n) { return !n.is_read; }).length;
    var b = document.getElementById('notifBadge');
    if (b) {
      var total = unread + alerts.length + budgetAlerts.length;
      b.style.display = total > 0 ? 'inline-block' : 'none';
      b.textContent = total;
    }
  };

  window.renderNotifList = function () {
    var list = document.getElementById('notifList');
    var st = getState();
    if (!list || !st) return;

    var alerts = window.getActiveComplianceAlerts();
    var budgetAlerts = window.getActiveBudgetAlerts();
    var unreadNotifs = (st.notifications || []).filter(function (n) { return !n.is_read; });
    var h = '';

    if (budgetAlerts.length) {
      h += '<div style="padding:8px 16px;font-size:10px;font-weight:800;color:var(--bad);background:rgba(248,81,73,.08)">BUDGET ALERTS (' + budgetAlerts.length + ')</div>';
      h += budgetAlerts.slice(0, 10).map(function (a) {
        var sig = alertSig('bud', a);
        return '<div class="notif-item ' + (a.severity === 'overrun' ? 'alert' : 'warn') + '" style="display:flex;align-items:flex-start;gap:8px">' +
                 '<div style="flex:1" onclick="closeNotifPanel();goView(\'boq\')"><div class="title">' + esc(a.title) + '</div><div class="body">' + esc(a.detail) + '</div></div>' +
                 '<button class="btn ghost sm" title="Dismiss" onclick="dismissSingleAlert(event,\'' + esc(sig) + '\')">✕</button>' +
               '</div>';
      }).join('');
    }

    if (alerts.length) {
      h += '<div style="padding:8px 16px;font-size:10px;font-weight:800;color:var(--muted);background:var(--panel2)">COMPLIANCE ALERTS (' + alerts.length + ')</div>';
      h += alerts.slice(0, 10).map(function (a) {
        var sig = alertSig('comp', a);
        return '<div class="notif-item ' + (a.severity === 'expired' ? 'alert' : 'warn') + '" style="display:flex;align-items:flex-start;gap:8px">' +
                 '<div style="flex:1" onclick="closeNotifPanel();goView(\'compliance\')"><div class="title">' + esc(a.title) + '</div><div class="body">' + esc(a.detail) + '</div></div>' +
                 '<button class="btn ghost sm" title="Dismiss" onclick="dismissSingleAlert(event,\'' + esc(sig) + '\')">✕</button>' +
               '</div>';
      }).join('');
    }

    if (unreadNotifs.length) {
      h += '<div style="padding:8px 16px;font-size:10px;font-weight:800;color:var(--muted);background:var(--panel2)">SYSTEM NOTIFICATIONS (' + unreadNotifs.length + ')</div>';
      h += unreadNotifs.map(function (n) {
        return '<div class="notif-item unread" style="display:flex;align-items:flex-start;gap:8px">' +
                 '<div style="flex:1" onclick="markNotifRead(\'' + esc(n.id) + '\')"><div class="title">' + esc(n.title) + '</div><div class="body">' + esc(n.body || '') + '</div></div>' +
                 '<button class="btn ghost sm" title="Dismiss" onclick="event.stopPropagation();markNotifRead(\'' + esc(n.id) + '\')">✕</button>' +
               '</div>';
      }).join('');
    }

    if (!budgetAlerts.length && !alerts.length && !unreadNotifs.length) {
      h = '<div class="notif-empty">✅ All caught up — no active alerts</div>';
    }
    list.innerHTML = h;
  };

  window.dismissSingleAlert = function (e, sig) {
    if (e) e.stopPropagation();
    var d = getDismissedAlerts();
    d[sig] = Date.now();
    saveDismissedAlerts(d);
    window.updateNotifBadge();
    window.renderNotifList();
  };

  window.toggleNotifPanel = function (e) {
    if (e) e.stopPropagation();
    var p = document.getElementById('notifPanel');
    var btn = document.getElementById('notifBtn');
    if (!p) return;
    var isOpen = p.classList.toggle('on');
    if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) window.renderNotifList();
  };

  window.markNotifRead = async function (id) {
    var st = getState();
    if (!st) return;
    st.notifications = (st.notifications || []).map(function (n) {
      return String(n.id) === String(id) ? Object.assign({}, n, { is_read: true }) : n;
    });
    window.updateNotifBadge();
    window.renderNotifList();
    var sb = getSB();
    if (sb) {
      try { await sb.from('notifications').update({ is_read: true }).eq('id', id); } catch (e) {}
    }
  };

  window.markAllNotifsRead = async function (e) {
    if (e) e.stopPropagation();
    var st = getState();
    var dismissed = getDismissedAlerts();
    if (typeof window.collectAlerts === 'function') {
      window.collectAlerts().forEach(function (a) { dismissed[alertSig('comp', a)] = Date.now(); });
    }
    if (typeof window.collectBudgetAlerts === 'function') {
      window.collectBudgetAlerts().forEach(function (a) { dismissed[alertSig('bud', a)] = Date.now(); });
    }
    saveDismissedAlerts(dismissed);

    var ids = [];
    if (st && st.notifications) {
      ids = st.notifications.filter(function (n) { return !n.is_read; }).map(function (n) { return n.id; });
      st.notifications = st.notifications.map(function (n) { return Object.assign({}, n, { is_read: true }); });
    }
    window.updateNotifBadge();
    window.renderNotifList();
    toast('All notifications & alerts cleared ✓', 'ok');

    var sb = getSB();
    if (sb && ids.length) {
      try { await sb.from('notifications').update({ is_read: true }).in('id', ids); } catch (err) {}
    }
  };

  /* =========================================================================
   * 2. PROCUREMENT: COMMITMENTS VS. ACTUALS & 1-CLICK PO -> SUPPLIER PAYABLE
   * ========================================================================= */
  var ACCRUED_STAGES = { Delivered: true, Inspected: true, Installed: true };

  // Override getBoqActualsMap so 'Ordered' & 'In Transit' are Commitments, not Actuals
  window.getBoqActualsMap = function () {
    var st = getState();
    var actualMap = {};
    if (!st) return actualMap;
    (st.materials || []).forEach(function (mat) {
      if (mat.boq_item_id && (mat.status || 'approved') === 'approved' && ACCRUED_STAGES[mat.stage]) {
        var cost = (Number(mat.qty) || 0) * (Number(mat.unitCost) || 0);
        actualMap[mat.boq_item_id] = (actualMap[mat.boq_item_id] || 0) + cost;
      }
    });
    (st.timesheets || []).forEach(function (ts) {
      if (ts.boq_item_id && ts.status === 'approved') {
        actualMap[ts.boq_item_id] = (actualMap[ts.boq_item_id] || 0) + (Number(ts.cost) || 0);
      }
    });
    return actualMap;
  };

  // New helper: Committed Cost Map (Ordered / In Transit)
  window.getBoqCommittedMap = function () {
    var st = getState();
    var commMap = {};
    if (!st) return commMap;
    (st.materials || []).forEach(function (mat) {
      if (mat.boq_item_id && (mat.status || 'approved') === 'approved' && !ACCRUED_STAGES[mat.stage]) {
        var cost = (Number(mat.qty) || 0) * (Number(mat.unitCost) || 0);
        commMap[mat.boq_item_id] = (commMap[mat.boq_item_id] || 0) + cost;
      }
    });
    return commMap;
  };

  // 1-Click Convert PO to Supplier Payable Invoice (with 5% UAE VAT & 30-day credit terms)
  window.convertPOToBill = async function (matId) {
    var st = getState();
    var m = (st.materials || []).find(function (x) { return x.id === matId; });
    if (!m) return toast('Material PO not found', 'bad');

    var subtotal = Math.round((Number(m.qty) || 0) * (Number(m.unitCost) || 0) * 100) / 100;
    var vat = Math.round(subtotal * 0.05 * 100) / 100;
    var totalIncVat = Math.round((subtotal + vat) * 100) / 100;

    var d = new Date();
    d.setDate(d.getDate() + 30);
    var due30 = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    openModal(
      '🧾 Convert PO to Supplier Payable Invoice',
      '<div class="fgrid">' +
        '<div class="field"><label>PO Number</label><input id="po_bill_po" value="' + esc(m.po) + '" readonly></div>' +
        '<div class="field"><label>Supplier</label><input id="po_bill_sup" value="' + esc(m.supplier) + '"></div>' +
        '<div class="field"><label>Supplier Invoice # *</label><input id="po_bill_inv" value="' + esc(m.invoiceNo || ('BILL-' + m.po)) + '"></div>' +
        '<div class="field"><label>Due Date (Credit Terms)</label><input id="po_bill_due" type="date" value="' + due30 + '"></div>' +
        '<div class="field"><label>Subtotal (Excl. VAT)</label><input id="po_bill_sub" type="number" step="0.01" value="' + subtotal.toFixed(2) + '"></div>' +
        '<div class="field"><label>Total Payable (Incl. 5% VAT)</label><input id="po_bill_tot" type="number" step="0.01" value="' + totalIncVat.toFixed(2) + '"></div>' +
        '<div class="field full"><label>Description</label><input id="po_bill_desc" value="Supplier Bill for ' + esc(m.po) + ' — ' + esc(m.desc) + '"></div>' +
      '</div>',
      '<button class="btn ghost" onclick="closeModal()">Cancel</button>' +
      '<button class="btn ok" onclick="commitPOBill(\'' + esc(m.id) + '\')">Post Payable Invoice →</button>'
    );
  };

  window.commitPOBill = async function (matId) {
    var st = getState();
    var m = (st.materials || []).find(function (x) { return x.id === matId; });
    if (!m) return;
    var invNo = document.getElementById('po_bill_inv').value.trim();
    var sup = document.getElementById('po_bill_sup').value.trim();
    var due = document.getElementById('po_bill_due').value;
    var tot = Number(document.getElementById('po_bill_tot').value) || 0;
    var desc = document.getElementById('po_bill_desc').value.trim();

    try {
      // 1. Ensure supplier is registered in project_parties
      if (typeof window.ensureSupplier === 'function' && sup) {
        await window.ensureSupplier(sup, st.currentProjectId);
      }
      // 2. Mark material stage as Inspected if still Ordered/In Transit so it accrues to BOQ actuals
      var newStage = ACCRUED_STAGES[m.stage] ? m.stage : 'Inspected';
      await (SF.updateRow || window.updateRow)('materials', m.id, { stage: newStage, invoice_no: invNo });

      // 3. Create AP record in payments
      await (SF.insertRow || window.insertRow)('payments', {
        project_id: st.currentProjectId,
        payment_type: 'invoice',
        invoice_no: invNo,
        description: '[AP · ' + sup + '] ' + desc,
        amount: tot,
        due_date: due || null,
        status: 'pending',
        payment_method: 'Bank Transfer'
      });

      if (typeof window.reloadProjectTable === 'function') {
        await window.reloadProjectTable('materials', 'created_at', false);
        await window.reloadProjectTable('payments', 'created_at', false);
      }
      closeModal();
      if (typeof window.render === 'function') window.render();
      toast('Supplier Bill posted to Accounts Payable ✓', 'ok');
    } catch (e) {
      toast('Failed: ' + e.message, 'bad');
    }
  };

  /* =========================================================================
   * 3. REVENUE: BOQ-DRIVEN IPC VALUATION & AUTOMATED AR LEDGER SYNC
   * ========================================================================= */
  window.syncIPCToReceivables = async function (billingObj) {
    var st = getState();
    if (!st || !billingObj) return;
    var invRef = billingObj.billing_no || billingObj.billingNo;
    if (!invRef) return;

    var status = billingObj.status;
    if (status !== 'certified' && status !== 'paid') return;

    var amountIncVat = Number(billingObj.total_payable_inc_vat || billingObj.totalPayableIncVat) || 0;
    var d = new Date();
    d.setDate(d.getDate() + 30);
    var dueDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    var existing = (st.payments || []).find(function (p) { return p.invoiceNo === invRef; });
    if (existing) {
      await (SF.updateRow || window.updateRow)('payments', existing.id, {
        payment_type: status === 'paid' ? 'received' : 'pending',
        amount: amountIncVat,
        status: status === 'paid' ? 'paid' : 'pending',
        paid_date: status === 'paid' ? today() : existing.paidDate
      });
    } else {
      await (SF.insertRow || window.insertRow)('payments', {
        project_id: st.currentProjectId,
        payment_type: status === 'paid' ? 'received' : 'pending',
        invoice_no: invRef,
        description: 'Client IPC Receivable — ' + invRef,
        amount: amountIncVat,
        due_date: dueDate,
        paid_date: status === 'paid' ? today() : null,
        status: status === 'paid' ? 'paid' : 'pending',
        payment_method: 'Bank Transfer'
      });
    }
    if (typeof window.reloadProjectTable === 'function') {
      await window.reloadProjectTable('payments', 'created_at', false);
    }
  };

  // Interactive BOQ-Driven Valuation Calculator inside IPC Modal
  window.openBoqValuationSheet = function () {
    var st = getState();
    if (!st || !st.boq || !st.boq.length) return toast('No BOQ items found in this project', 'bad');

    var rowsHtml = st.boq.filter(function (i) { return (i.status || 'approved') === 'approved'; }).map(function (i) {
      var lineTotal = (Number(i.qty) || 0) * (Number(i.rate) || 0);
      return '<tr>' +
        '<td class="mono">' + esc(i.code || '—') + '</td>' +
        '<td>' + esc(i.desc) + '</td>' +
        '<td class="tright mono">' + money(lineTotal) + '</td>' +
        '<td class="tright" style="width:120px"><input type="number" class="boq-val-pct" data-total="' + lineTotal + '" min="0" max="100" step="1" value="0" oninput="recalcBoqValuation()" style="width:80px;padding:4px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;text-align:right"> %</td>' +
      '</tr>';
    }).join('');

    openModal(
      '📋 BOQ Line-by-Line IPC Valuation Sheet',
      '<div style="max-height:55vh;overflow:auto"><table><thead><tr><th>Code</th><th>Description</th><th class="tright">BOQ Value</th><th class="tright">% Executed</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
      '<div class="card" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center"><span>Calculated Gross Cumulative Valuation:</span><b class="mono okc" id="boqValResult" style="font-size:16px">AED 0.00</b></div>',
      '<button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn ok" onclick="applyBoqValuationToIPC()">Apply to IPC →</button>',
      { wide: true }
    );
  };

  window.recalcBoqValuation = function () {
    var inputs = document.querySelectorAll('.boq-val-pct');
    var sum = 0;
    for (var i = 0; i < inputs.length; i++) {
      var lineTot = Number(inputs[i].getAttribute('data-total')) || 0;
      var pct = Math.min(100, Math.max(0, Number(inputs[i].value) || 0));
      sum += lineTot * (pct / 100);
    }
    var el = document.getElementById('boqValResult');
    if (el) el.textContent = money(sum);
    window._lastBoqValSum = Math.round(sum * 100) / 100;
  };

  window.applyBoqValuationToIPC = function () {
    var val = window._lastBoqValSum || 0;
    closeModal();
    if (typeof window.newBilling === 'function') {
      window.newBilling();
      setTimeout(function () {
        var claimInput = document.getElementById('f_total_claim');
        if (claimInput) claimInput.value = val.toFixed(2);
      }, 80);
    }
  };

  /* =========================================================================
   * 4. LABOR: WORKER LINK IN TIMESHEETS & UNIFIED MONTHLY PAYROLL RUN
   * ========================================================================= */
  window.newTimesheet = function () {
    var st = getState();
    var boqOptions = (st.boq || []).map(function (item) {
      return { value: item.id, label: (item.code ? item.code + ' - ' : '') + item.desc.slice(0, 50) };
    });
    var activeWorkers = (st.workers || []).filter(function (w) { return w.status !== 'inactive'; });
    var workerOptions = activeWorkers.map(function (w) {
      return { value: w.name, label: (w.staff_no ? w.staff_no + ' · ' : '') + w.name + (w.trade ? ' (' + w.trade + ')' : '') };
    });

    if (typeof window.openFormModal === 'function') {
      window.openFormModal({
        title: '+ New Linked Timesheet',
        fields: [
          { key: 'boq_item_id', label: 'BOQ Item / البند (Searchable)', type: 'searchable_select', options: boqOptions, full: true },
          { key: 'employee_name', label: 'Worker (Linked to Staff Register)', type: workerOptions.length ? 'select' : 'text', options: workerOptions, required: true, full: true },
          { key: 'trade', label: 'Trade', type: 'select', options: ['CONC', 'STEL', 'ELEC', 'HVAC', 'DRYW', 'HEQV'] },
          { key: 'work_date', label: 'Date', type: 'date', required: true, default: today() },
          { key: 'reg_hours', label: 'Regular Hours', type: 'number', step: '0.25', default: 8 },
          { key: 'ot_hours', label: 'Overtime Hours (1.5x)', type: 'number', step: '0.25', default: 0 },
          { key: 'rate_aed', label: 'Hourly Rate (AED/hr)', type: 'number', step: '0.01', required: true, default: 25 }
        ],
        onSubmit: async function (d) {
          var total = (Number(d.reg_hours) || 0) + (Number(d.ot_hours) || 0);
          var cost = (Number(d.reg_hours) || 0) * Number(d.rate_aed) + (Number(d.ot_hours) || 0) * Number(d.rate_aed) * 1.5;
          await (SF.insertRow || window.insertRow)('timesheets', {
            project_id: st.currentProjectId,
            boq_item_id: d.boq_item_id || null,
            employee_name: d.employee_name,
            trade: d.trade,
            work_date: d.work_date,
            reg_hours: Number(d.reg_hours),
            ot_hours: Number(d.ot_hours),
            total_hours: total,
            rate_aed: Number(d.rate_aed),
            total_cost_aed: cost,
            status: 'pending'
          });
          if (typeof window.reloadProjectTable === 'function') await window.reloadProjectTable('timesheets', 'created_at', false);
          if (typeof window.render === 'function') window.render();
          toast('Timesheet logged ✓', 'ok');
        }
      });
    }
  };

  // Unified Monthly Payroll Run (Combines Basic Salary + Approved OT - Loan Installment)
  window.newPayrollBatch = function () {
    var st = getState();
    var curPeriod = today().slice(0, 7);
    var activeWorkers = (st.workers || []).filter(function (w) { return w.status !== 'inactive'; });
    var approvedTS = (st.timesheets || []).filter(function (x) {
      return x.status === 'approved' && String(x.date || '').slice(0, 7) === curPeriod;
    });

    // Aggregate approved OT pay per worker for the period
    var otByWorker = {};
    approvedTS.forEach(function (ts) {
      var otPay = (Number(ts.otHours) || 0) * (Number(ts.rate) || 0) * 1.5;
      otByWorker[ts.name] = (otByWorker[ts.name] || 0) + otPay;
    });

    var payrollLines = [];
    var totalGross = 0, totalDeduct = 0, totalNet = 0;

    activeWorkers.forEach(function (w) {
      var m = String(w.notes || '').match(/^<!--sfpay:([\s\S]*?)-->\n?/);
      var pay = { salary: 0, loan: 0, deduct: 0, rawNotes: String(w.notes || '').replace(/^<!--sfpay:[\s\S]*?-->\n?/, '') };
      if (m) {
        try { var o = JSON.parse(m[1]); pay.salary = Number(o.salary) || 0; pay.loan = Number(o.loan) || 0; pay.deduct = Number(o.deduct) || 0; } catch (e) {}
      }
      var otPay = Math.round((otByWorker[w.name] || 0) * 100) / 100;
      var gross = pay.salary + otPay;
      var deduct = Math.min(pay.deduct, pay.loan);
      var net = Math.max(0, gross - deduct);
      var remLoan = Math.max(0, pay.loan - deduct);

      if (gross > 0 || approvedTS.some(function (t) { return t.name === w.name; })) {
        payrollLines.push({
          workerId: w.id,
          staffNo: w.staff_no || '—',
          name: w.name,
          basic: pay.salary,
          otPay: otPay,
          gross: gross,
          deduct: deduct,
          net: net,
          remLoan: remLoan,
          origDeduct: pay.deduct,
          rawNotes: pay.rawNotes
        });
        totalGross += gross;
        totalDeduct += deduct;
        totalNet += net;
      }
    });

    window._pendingPayrollRun = { period: curPeriod, lines: payrollLines, totalGross: totalGross, totalDeduct: totalDeduct, totalNet: totalNet };

    var tableHtml = payrollLines.length ? payrollLines.map(function (ln) {
      return '<tr>' +
        '<td class="mono">' + esc(ln.staffNo) + '</td>' +
        '<td><b>' + esc(ln.name) + '</b></td>' +
        '<td class="tright mono">' + money(ln.basic) + '</td>' +
        '<td class="tright mono infoc">' + money(ln.otPay) + '</td>' +
        '<td class="tright mono warnc">-' + money(ln.deduct) + '</td>' +
        '<td class="tright mono okc"><b>' + money(ln.net) + '</b></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="6" class="empty">No active workers with salary or approved timesheets for ' + curPeriod + '</td></tr>';

    openModal(
      '💸 Unified Monthly Payroll Run — ' + curPeriod,
      '<div class="mutc" style="font-size:12px;margin-bottom:10px">Automatically combines monthly basic salaries, approved site overtime (1.5x), and deducts monthly loan installments.</div>' +
      '<div style="max-height:50vh;overflow:auto"><table><thead><tr><th>Staff #</th><th>Worker</th><th class="tright">Basic</th><th class="tright">Approved OT</th><th class="tright">Loan Deduct</th><th class="tright">Net Pay</th></tr></thead><tbody>' + tableHtml + '</tbody></table></div>' +
      '<div class="card" style="margin-top:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px">' +
        '<div>Gross: <b class="mono">' + money(totalGross) + '</b></div>' +
        '<div>Loan Recovered: <b class="mono warnc">' + money(totalDeduct) + '</b></div>' +
        '<div>Total Net Disbursed: <b class="mono okc">' + money(totalNet) + '</b></div>' +
      '</div>',
      '<button class="btn ghost" onclick="closeModal()">Cancel</button>' +
      '<button class="btn ok" onclick="commitUnifiedPayrollRun()">Certify & Disburse Payroll →</button>',
      { wide: true }
    );
  };

  window.commitUnifiedPayrollRun = async function () {
    var run = window._pendingPayrollRun;
    var st = getState();
    if (!run || !run.lines.length) return closeModal();

    try {
      // 1. Update each worker's loan balance
      for (var i = 0; i < run.lines.length; i++) {
        var ln = run.lines[i];
        if (ln.deduct > 0) {
          var newNotes = '<!--sfpay:' + JSON.stringify({ salary: ln.basic, loan: ln.remLoan, deduct: ln.origDeduct }) + '-->\n' + ln.rawNotes;
          await (SF.updateRow || window.updateRow)('workers', ln.workerId, { notes: newNotes });
        }
      }
      // 2. Insert certified batch in payroll_batches
      await (SF.insertRow || window.insertRow)('payroll_batches', {
        project_id: st.currentProjectId,
        period: run.period,
        worker_count: run.lines.length,
        gross_aed: run.totalGross,
        net_aed: run.totalNet,
        certified_at: new Date().toISOString()
      });
      // 3. Post consolidated payroll expense to company_expenses
      await (SF.insertRow || window.insertRow)('company_expenses', {
        category: 'Salaries',
        description: 'Certified Monthly Payroll Run (' + run.period + ' · ' + run.lines.length + ' workers)',
        amount: run.totalNet,
        expense_date: today(),
        paid_to: 'WPS Payroll Batch',
        payment_method: 'Bank Transfer',
        status: 'approved'
      });

      if (typeof window.loadCompanyData === 'function') await window.loadCompanyData();
      if (typeof window.reloadProjectTable === 'function') await window.reloadProjectTable('payroll_batches', 'certified_at', false);
      closeModal();
      if (typeof window.render === 'function') window.render();
      toast('Payroll certified, loans updated & expense posted ✓', 'ok');
    } catch (e) {
      toast('Payroll error: ' + e.message, 'bad');
    }
  };

  /* =========================================================================
   * 5. VARIATIONS: AUTO-CREATE BOQ LINE ON CHANGE ORDER APPROVAL
   * ========================================================================= */
  var origApproveItem = window.approveItem;
  window.approveItem = async function (table, id) {
    var st = getState();
    var coItem = null;
    if (table === 'change_orders' && st && st.changeOrders) {
      coItem = st.changeOrders.find(function (c) { return c.id === id; });
    }
    if (typeof origApproveItem === 'function') {
      await origApproveItem(table, id);
    }
    // Automatically append approved Change Order to BOQ under 'Variations / Change Orders'
    if (table === 'change_orders' && coItem && st.currentProjectId) {
      var code = coItem.coNumber || 'CO-VAR';
      var alreadyInBoq = (st.boq || []).some(function (b) { return b.code === code; });
      if (!alreadyInBoq) {
        try {
          await (SF.insertRow || window.insertRow)('boq_items', {
            project_id: st.currentProjectId,
            section: 'Variations / Change Orders',
            code: code,
            description: '[Approved Variation] ' + (coItem.desc || ''),
            unit: 'LS',
            quantity: 1,
            rate: Number(coItem.amount) || 0,
            sort_order: (st.boq ? st.boq.length : 0) + 1,
            status: 'approved'
          });
          if (typeof window.reloadProjectTable === 'function') {
            await window.reloadProjectTable('boq_items', 'sort_order', true);
          }
          if (typeof window.render === 'function') window.render();
          toast('Variation ' + code + ' added to BOQ ✓', 'ok');
        } catch (e) {
          console.warn('Could not auto-append CO to BOQ:', e);
        }
      }
    }
  };

  /* =========================================================================
   * 6. CROSS-PROJECT EXECUTIVE APPROVALS QUEUE (Company-Wide Pending Fetch)
   * ========================================================================= */
  window.loadCrossProjectPending = async function () {
    var sb = getSB();
    var st = getState();
    if (!sb || !st) return;
    try {
      var projMap = {};
      (st.projects || []).forEach(function (p) { projMap[p.id] = p.code || p.name; });

      var results = await Promise.all([
        sb.from('boq_items').select('*').eq('status', 'pending'),
        sb.from('timesheets').select('*').eq('status', 'pending'),
        sb.from('materials').select('*').eq('status', 'pending'),
        sb.from('change_orders').select('*').eq('status', 'pending')
      ]);

      st._globalPending = {
        boq: (results[0].data || []).map(function (x) { x._projCode = projMap[x.project_id] || '—'; return x; }),
        ts: (results[1].data || []).map(function (x) { x._projCode = projMap[x.project_id] || '—'; return x; }),
        mat: (results[2].data || []).map(function (x) { x._projCode = projMap[x.project_id] || '—'; return x; }),
        co: (results[3].data || []).map(function (x) { x._projCode = projMap[x.project_id] || '—'; return x; })
      };

      // Update topbar Approvals badge with global count when on Company view
      var abBadge = document.getElementById('approvalsBadge');
      if (abBadge && !st.currentProjectId) {
        var gp = st._globalPending;
        var expPend = (st.expenses || []).filter(function (e) { return (e.status || 'approved') === 'pending'; }).length;
        var total = gp.boq.length + gp.ts.length + gp.mat.length + gp.co.length + expPend;
        abBadge.style.display = total > 0 ? 'inline-block' : 'none';
        abBadge.textContent = total;
      }
    } catch (e) {
      console.warn('Cross-project pending query skipped:', e);
    }
  };

  /* =========================================================================
   * 7. SITE REPORTS: SUPABASE STORAGE OFFLOADING (WebP) & SCHEDULE PROGRESS
   * ========================================================================= */
  window.handleReportPhotos = function (ev) {
    var files = ev.target.files;
    if (!files || !files.length) return;
    var st = getState();
    var sb = getSB();
    window._reportPhotos = window._reportPhotos || [];

    Array.from(files).forEach(function (f) {
      if (f.size > 15 * 1024 * 1024) {
        toast(f.name + ' exceeds 15MB limit', 'bad');
        return;
      }
      var rd = new FileReader();
      rd.onload = function (e) {
        var img = new Image();
        img.onload = async function () {
          var canvas = document.createElement('canvas');
          var MAX_W = 1400;
          var scale = img.width > MAX_W ? (MAX_W / img.width) : 1;
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          // Compress to WebP for 70% smaller footprint
          canvas.toBlob(async function (blob) {
            if (!blob) return;
            var cleanName = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') + '.webp';
            var storagePath = (st.currentProjectId || 'general') + '/site_reports/' + today() + '/' + Date.now() + '_' + cleanName;

            if (sb) {
              try {
                var up = await sb.storage.from('siteforge-files').upload(storagePath, blob, {
                  contentType: 'image/webp',
                  upsert: true
                });
                if (!up.error) {
                  var signed = await sb.storage.from('siteforge-files').createSignedUrl(storagePath, 60 * 60 * 24 * 365);
                  var url = (signed.data && signed.data.signedUrl) ? signed.data.signedUrl : canvas.toDataURL('image/webp', 0.75);
                  window._reportPhotos.push({ name: cleanName, path: storagePath, data: url });
                  if (typeof window.renderReportPhotoGrid === 'function') window.renderReportPhotoGrid();
                  toast('Uploaded ' + cleanName + ' to cloud storage ✓', 'ok');
                  return;
                }
              } catch (err) {
                console.warn('Storage bucket fallback to inline WebP:', err);
              }
            }
            // Fallback if bucket is offline
            window._reportPhotos.push({ name: cleanName, data: canvas.toDataURL('image/webp', 0.75) });
            if (typeof window.renderReportPhotoGrid === 'function') window.renderReportPhotoGrid();
          }, 'image/webp', 0.78);
        };
        img.src = e.target.result;
      };
      rd.readAsDataURL(f);
    });
    ev.target.value = '';
  };

  // Initialize cross-project pending check once authenticated
  setTimeout(function () {
    if (getSB()) window.loadCrossProjectPending();
  }, 1500);

})(window, document);
