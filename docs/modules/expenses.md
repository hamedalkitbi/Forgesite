# Company expenses — bills, purchase orders, approval

Company expenses are company-level overheads (`company_expenses` table), not project costs.
They live under **Company → Expenses** and feed the finance statement payables through the
approval queue.

## Bill upload / OCR scan

The New and Edit expense dialogs share one form (`openExpenseEditor` in `scripts/app.js`):

- **Bill dropzone** — accepts a photo (invoice/receipt) or a PDF. A chosen image is read with
  the server OCR function (`/functions/v1/scan-invoice-real`) and falls back to in-browser
  Tesseract if the function is unavailable; the parsed vendor/date/line item/amount prefill the
  fields for review. PDFs are attached without OCR.
- **Storage** — the file is uploaded to the private `siteforge-files` bucket under
  `company/bills/<yyyy>/<mm>/…` and the row stores the path as `bill_path`. The 📎 button in the
  list opens a short-lived signed URL.
- On Edit the current bill can be opened, kept, replaced, or removed. A failed upload never
  loses the expense — it saves and reports the upload error.
- PDFs and undecodable images are kept as-is so a bill is never silently dropped.

## Purchase order reference

`company_expenses.po_number` optionally links an overhead purchase to a purchase order. The field
is a free-text input with a datalist of existing PO numbers (from `materials.po_number` across the
projects plus earlier expenses), edited inline, shown as a **PO #** column in the expenses table,
included in the printed expense statement and in the list search.

## Approval + notifications

- A director/controller saving an expense stores `status='approved'`; anyone else stores
  `status='pending'` and the row appears in Approvals/Expenses for a manager to approve or reject.
- Migration `202611100001_expense_po_notifications.sql` adds `company_id` (the Phase 2 period
  guard and escalation job assume it), the PO/bill columns and a `sf_notify_submission()` trigger
  that notifies directors/controllers on a pending submission. The trigger is exception-guarded:
  a notification failure never blocks the expense write. The client refreshes the bell after save.

## Empty state / migrations

Until `202611100001_expense_po_notifications.sql` is applied, **every** company-expense
INSERT/UPDATE is still rejected by the Phase 2 closed-period trigger (`record "new" has no field
"company_id"`), so the fix must be run before expenses can be saved at all. The app's
dropped-column fallback only covers the optional new columns once the trigger is fixed; it cannot
work around the trigger. Run the file after `202611050003_phase3.sql` to get the fix, the PO
column and submission notifications.
