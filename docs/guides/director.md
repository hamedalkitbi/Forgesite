# Project Director — Day Guide

The Project Director has **full access**: approve and certify every record, manage users, watch the
audit trail, and run the financial/management views. You are the only role that can approve anything
without a money cap, and the only one who can manage users and see the full history.

**You can open:** Dashboard, Projects, Expenses, Budget, Workers, Compliance, Settings, **Users**,
**History**, Approvals, Financial Accounts, Suppliers & Contractors, Management Exceptions, and — inside
a project — Overview, BOQ, Drawings, Timeline, Materials/POs, Payments, Parties, Change Orders,
Timesheets, Payroll, Audit, Reports, Progress Billing (IPC), Site Reports, Payment Requests, Payslips,
Receiving/GRN, Retention, and Measurement & Certificates.

---

## 1. Start of day — see the whole business

1. Sign in. You land on the **Company Dashboard** (KPIs: cash, pending approvals, overruns, alerts).
   ![Company dashboard](../screenshots/guides/director/company-company-dash.png)
2. Open **🔔 Notifications** and clear or act on compliance/budget alerts (dismiss with ✕ or
   **Mark all read**).
3. Open **🛡️ Approvals Queue** — this is your main morning task (step 2 below).

## 2. Clear the approvals queue

1. Open **Approvals Queue**. Use the tabs to triage: **Inbox: All / For me / By me / Overdue**.
   ![Approvals queue](../screenshots/guides/director/company-approvals.png)
2. For each pending item:
   - **🕓** opens the decision history; **📎** opens evidence attachments.
   - If the amount needs evidence and none is attached, the system refuses — attach the document
     first (📎 → Add evidence).
   - **✓ Approve** or **✕ Reject** (rejection requires a reason).
   - You cannot approve something you submitted yourself (segregation of duties).
3. Repeat until the queue is empty.

## 3. Financial health

1. Open **Financial Accounts** → Receivables, Payables, Balance Sheet, Profit & Loss.
   ![Financial accounts](../screenshots/guides/director/company-finance.png)
2. Check the **Balance Sheet** — it shows retained/released retention netted, and must show the
   green "Balanced" badge (assets = liabilities + equity).
3. Open **Management Exceptions** for the red flags: overdue approvals, unlinked costs, duplicate
   supplier invoices, committed-but-undelivered POs, open retention.
   ![Management exceptions](../screenshots/guides/director/company-management.png)

## 4. Suppliers, budget, people

1. **Suppliers & Contractors** — maintain the company-wide vendor master and link suppliers to
   projects (bank/TRN/terms live here).
   ![Suppliers](../screenshots/guides/director/company-suppliers.png)
2. **Company Budget** and **Expenses** — review spend vs budget and approve expenses.
3. **Workers & Staff** — maintain the register (salary, loan balance, permits).
4. **Compliance** — check expiring permits/visas and act on overdue items.

## 5. Work a project (pick one from the top bar)

1. Open a project → **Overview** for the project KPIs.
   ![Project overview](../screenshots/guides/director/project-project-dash.png)
2. **BOQ** — review budget vs **actual** vs **committed** (POs still Ordered/In Transit show as
   committed, not actual).
   ![BOQ](../screenshots/guides/director/project-boq.png)
3. **Progress Billing (IPC)** — create/certify IPCs. Certifying syncs the receivable into Payments.
   ![Progress billing](../screenshots/guides/director/project-progress-billing.png)
4. **Materials & POs** — approve POs; on a delivered/approved PO press **🧾** to convert it into a
   supplier payable invoice (5% VAT, 30-day terms). A goods receipt is required first (3-way match).
   ![Materials](../screenshots/guides/director/project-materials.png)
5. **Change Orders** — approve them; an approved CO auto-creates a **Variations** BOQ line.
   ![Change orders](../screenshots/guides/director/project-change-orders.png)
6. **Payment Requests** — approve subcontractor/supplier claims (submit → approve → mark paid).
   ![Payment requests](../screenshots/guides/director/project-payment-requests.png)

## 6. Field & labour

1. **Timesheets** — review submitted labour; approve.
2. **Payroll** — run the **Unified Monthly Payroll** (basic + 1.5× approved OT − loan) which updates
   each worker's loan balance and posts the salaries expense.
   ![Payroll](../screenshots/guides/director/project-payroll.png)
3. **Payslips** — generate per-worker slips and print/PDF.
4. **Site Reports** — review daily reports with photo evidence.
   ![Site reports](../screenshots/guides/director/project-site-reports.png)

## 7. Receiving, retention, certificates

1. **Receiving / GRN** — record goods received against POs (this unblocks PO billing and payment).
   ![Receiving](../screenshots/guides/director/project-grn.png)
2. **Retention** — release retention per project (amount ≤ open, reason required).
   ![Retention](../screenshots/guides/director/project-retention.png)
3. **Measurement & Certificates** — measure BOQ quantities, certify, and generate a subcontractor
   payment request.
   ![Subcontractor certificates](../screenshots/guides/director/project-subcertificates.png)

## 8. Month-end & governance

1. Open **🔒 Periods & SLA** (in the Approvals header) → close the month to lock writes, set the
   approval SLA in days.
2. **Users** — add/disable users, assign roles, reset passwords.
   ![Users](../screenshots/guides/director/company-users.png)
3. **History** — review the full audit trail (who did what, when).
   ![History](../screenshots/guides/director/company-history.png)
4. **Settings** — branding (logo), language, theme.

## 9. End of day

- Confirm the approvals queue is empty (or items are delegated/flagged).
- Check the Balance Sheet "Balanced" badge and the Management Exceptions screen for anything red.
- If it's month-end, close the period; if it's payroll day, certify the payroll run.
