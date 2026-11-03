// Lead's independent calculation audit.
//
// Deliberately does NOT reuse the feature authors' fixtures or expected values:
// a small dataset is hand-computed here and driven through the modules' exported
// pure functions in a real page (mock Supabase, headless Chrome). This is the
// "check all calculations" gate for the financial wave:
//   - finance-statements: AR, AP, cash, retention, VAT, balance-sheet identity, P&L
//   - payment-requests:   retention / net / 2dp rounding
//   - payslips:           OT 1.5x, gross, loan cap, net, shortfall carry
//   - cross-module:       an approved payment request feeds AP with its net amount
//
// Usage: node tools/checks/cross-module-math.mjs
import { withApp } from '../lib/testkit.mjs';

const r2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// ---- hand-computed expectations (independent of module code) ----------------
const DATA = {
  payments: [
    { id: 'p1', payment_type: 'received', amount: 4000, status: 'paid', due_date: '2026-02-01' },
    { id: 'p2', payment_type: 'invoice', amount: 2000, status: 'paid', due_date: '2026-02-10' },
    { id: 'p3', payment_type: 'pending', amount: 3000, status: 'pending', due_date: '2026-03-01' }
  ],
  progress_billings: [
    { id: 'b1', billing_no: 'PB-001', status: 'certified', net_payable: 9000, retention_amount: 1000, vat_amount: 450, total_claim: 9000, current_net_excl_vat: 9000, due_date: '2026-02-01', project_id: 'pr1' },
    { id: 'b2', billing_no: 'PB-002', status: 'certified', net_payable: 4500, retention_amount: 500, vat_amount: 225, total_claim: 4500, current_net_excl_vat: 4500, due_date: '2026-03-01', project_id: 'pr1' }
  ],
  materials: [],
  timesheets: [{ status: 'approved', total_cost_aed: 2500, project_id: 'pr1' }],
  company_expenses: [{ amount: 1500, status: 'approved' }],
  payment_requests: [{ id: 'r1', status: 'approved', amount_aed: 1000, retention_aed: 100, net_aed: 900, due_date: '2026-02-15' }],
  finance_settings: [{ fiscal_year: 2026, opening_cash_aed: 0, opening_equity_aed: 0 }],
  projects: [{ id: 'pr1', code: 'PRJ-001', name: 'Alpha' }]
};

const certifiedNet = 9000 + 4500;              // 13500
const received = 4000;
const expectedAR = r2(certifiedNet - received);           // 9500
const expectedAP = r2(900 + 0 + 3000);                    // 3900 (PR net + material residual + unpaid supplier invoice)
const expectedCash = r2(0 + received - 2000 - 1500 - 0);  // 500 (opening + received - paid supplier - expenses - paid PRs)
const expectedRetention = r2(1000 + 500);                 // 1500
const expectedVAT = r2(450 + 225);                        // 675
const expectedAssets = r2(expectedCash + expectedAR);     // 10000
const expectedLiabilities = r2(expectedAP + expectedRetention + expectedVAT); // 6075
const expectedEquity = r2(expectedAssets - expectedLiabilities);              // 3925

const expectedRevenue = r2(9000 + 4500);                  // 13500
const expectedLabour = 2500;
const expectedExpenses = 1500;
const expectedGross = r2(expectedRevenue - expectedLabour);        // 11000
const expectedNet = r2(expectedRevenue - expectedLabour - expectedExpenses); // 9000
const expectedGrossMargin = r2((expectedGross / expectedRevenue) * 100);   // 81.48
const expectedNetMargin = r2((expectedNet / expectedRevenue) * 100);       // 66.67

const results = [];
const eq = (name, actual, expected) => {
  const ok = typeof expected === 'number'
    ? Math.abs(Number(actual) - expected) <= 0.005
    : actual === expected;
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : ` — expected ${expected}, got ${actual}`}`);
};

const main = async () => {
  const app = await withApp({ role: 'director' }, async ({ evaluate }) => {
    const out = await evaluate(`(() => {
      const F = window.SF_modules.finance;
      const P = window.SF_modules.payslips;
      const R = window.SF_modules['payment-requests'];
      const data = ${JSON.stringify(DATA)};
      const bs = F.balanceSheet(data);
      const pl = F.pnl(data);
      const slip = P.computeLine({ worker_name: 'Hand Check', rate: 25, reg_hours: 8, ot_hours: 2, loan_balance: 500 });
      const slipNoLoan = P.computeLine({ worker_name: 'Hand Check', rate: 25, reg_hours: 8, ot_hours: 2, loan_balance: 0 });
      return {
        bs: { ar: bs.ar, ap: bs.ap, cash: bs.cash, retention: bs.retentionPayable, vat: bs.vatPayable,
              assets: bs.assets, liabilities: bs.liabilities, equity: bs.equity, diff: bs.diff,
              apFromRequests: bs.apBreakdown && bs.apBreakdown.paymentRequests },
        pl: { revenue: pl.revenue, labour: pl.labour, expenses: pl.expenses, grossProfit: pl.grossProfit,
              netProfit: pl.netProfit, grossMargin: pl.grossMargin, netMargin: pl.netMargin },
        slip: { otRate: slip.ot_rate, gross: slip.gross, loanDeduction: slip.loan_deduction, net: slip.net, shortfall: slip.shortfall },
        slipNoLoan: { gross: slipNoLoan.gross, net: slipNoLoan.net },
        pr: { retention: R.computeRetention(1000, 2.5), net: R.computeNet(1000, 25, 0),
              retentionOdd: R.computeRetention(333.33, 7.5), netOdd: R.computeNet(333.33, 25, 0) }
      };
    })()`);
    return out;
  });

  const { bs, pl, slip, slipNoLoan, pr } = app;

  console.log('\nFinance — hand-computed fixture (AED)');
  eq('AR = certified net 13,500 − received 4,000', bs.ar, expectedAR);
  eq('AP = PR net 900 + unpaid supplier invoice 3,000', bs.ap, expectedAP);
  eq('AP includes the approved payment request net', bs.apFromRequests, 900);
  eq('Cash = opening 0 + 4,000 − 2,000 − 1,500', bs.cash, expectedCash);
  eq('Retention payable', bs.retention, expectedRetention);
  eq('VAT payable', bs.vat, expectedVAT);
  eq('Assets = cash + AR', bs.assets, expectedAssets);
  eq('Liabilities = AP + retention + VAT', bs.liabilities, expectedLiabilities);
  eq('Equity = assets − liabilities', bs.equity, expectedEquity);
  eq('Balance-sheet identity diff', Math.abs(bs.diff), 0);

  console.log('\nP&L — hand-computed (AED)');
  eq('Revenue (ex VAT)', pl.revenue, expectedRevenue);
  eq('Labour', pl.labour, expectedLabour);
  eq('Overhead', pl.expenses, expectedExpenses);
  eq('Gross profit', pl.grossProfit, expectedGross);
  eq('Net profit', pl.netProfit, expectedNet);
  eq('Gross margin %', pl.grossMargin, expectedGrossMargin);
  eq('Net margin %', pl.netMargin, expectedNetMargin);

  console.log('\nPayment requests — retention/net rounding');
  eq('1000 @ 2.5% retention', pr.retention, 25);
  eq('1000 − 25 net', pr.net, 975);
  eq('333.33 @ 7.5% rounds to 25.00', pr.retentionOdd, 25);
  eq('333.33 − 25.00 net', pr.netOdd, 308.33);

  console.log('\nPayslips — OT, loan cap, carry-forward');
  eq('OT rate = 25 × 1.5', slip.otRate, 37.5);
  eq('Gross = 8×25 + 2×37.50', slip.gross, 275);
  eq('Loan deduction capped at gross', slip.loanDeduction, 275);
  eq('Net floors at 0', slip.net, 0);
  eq('Shortfall carried = 500 − 275', slip.shortfall, 225);
  eq('No-loan gross', slipNoLoan.gross, 275);
  eq('No-loan net', slipNoLoan.net, 275);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} independent checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) process.exitCode = 1;
};

main().catch((error) => { console.error('Independent math audit failed to run:', error); process.exit(1); });
