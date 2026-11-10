// Verification for the v29.7.0 expense-bill / PO-reference / submission-notification
// and site-report-photo fixes.
//
//   node tools/checks/expenses-notifications.mjs
//
// Layers
//   1. Static — supabase/migrations/202611100001_expense_po_notifications.sql is
//      idempotent, adds the four company_expenses columns, replaces the
//      closed-period guard defensively (to_jsonb(NEW) ->> 'company_id' instead of
//      NEW.company_id), re-creates sf_notify_submission with `exception when
//      others`, drops+creates the three submission triggers and reloads the
//      PostgREST schema cache. scripts/app.js must expose the SF.expenses bridge
//      and store bills under company/bills/.
//   2. Headless — the real app against the mock Supabase (no network):
//      * New expense modal exposes the bill upload (#expBillFile), the PO # field
//        (#eb_po + #eb_po_list datalist) and #eb_save; a controller save inserts
//        exactly ONE company_expenses row carrying company_id / po_number /
//        bill_path (status approved for a manager).
//      * Re-opening the saved expense prefills the PO #, offers #eb_removebill and
//        the bill_path survives an amount edit.
//      * A material PO submitted by a non-manager (lead) and a saved site report
//        each refresh window.SF.state.notifications: a marker row planted in
//        window.__MOCK_DB.notifications before the write appears in the app state
//        afterwards. (The mock has no DB trigger, so trigger-created rows cannot be
//        asserted here; the migration SQL is covered statically above.)
//      * A site report saved with a real 1x1 PNG stores photos[0].path.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withApp, assert, assertEqual, ROOT } from '../lib/testkit.mjs';

const MIGRATION = join(ROOT, 'supabase', 'migrations', '202611100001_expense_po_notifications.sql');
const APP = join(ROOT, 'scripts', 'app.js');

// 1x1 transparent PNG (same fixture the mock seeds site-report photos with).
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) console.log(`  ✗ ${name}\n      ${String(detail).replace(/\n/g, '\n      ')}`);
  else console.log(`  ✓ ${name}`);
}
async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error && error.message ? error.message : String(error));
  }
}
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}
function unique(prefix) {
  return `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ------------------------------------------------------------------ static */

async function staticChecks() {
  console.log('\nStatic — migration 202611100001 + app bridge');
  const sql = await readFile(MIGRATION, 'utf8').catch(() => '');
  const appSrc = await readFile(APP, 'utf8').catch(() => '');

  await check('migration file exists and is non-trivial SQL', () => {
    assert(sql.trim().length > 1000, 'migration missing or too small');
    const code = stripSqlComments(sql);
    assert(code.trim().length > 500, 'migration has almost no executable SQL after comments');
  });

  await check('migration 202611100001 is idempotent (add column if not exists)', () => {
    const code = stripSqlComments(sql);
    assert(/alter\s+table\s+public\.company_expenses\s+add\s+column\s+if\s+not\s+exists\s+company_id\s+uuid/i.test(code), 'company_id add-column-if-not-exists missing');
    assert(/alter\s+table\s+public\.company_expenses\s+add\s+column\s+if\s+not\s+exists\s+po_number\s+text/i.test(code), 'po_number add-column-if-not-exists missing');
    assert(/alter\s+table\s+public\.company_expenses\s+add\s+column\s+if\s+not\s+exists\s+po_date\s+date/i.test(code), 'po_date add-column-if-not-exists missing');
    assert(/alter\s+table\s+public\.company_expenses\s+add\s+column\s+if\s+not\s+exists\s+bill_path\s+text/i.test(code), 'bill_path add-column-if-not-exists missing');
    assert(/create\s+index\s+if\s+not\s+exists\s+company_expenses_company_id_idx/i.test(code), 'company_id index missing');
    assert(/create\s+index\s+if\s+not\s+exists\s+company_expenses_po_number_idx/i.test(code), 'po_number index missing');
  });

  await check('migration re-creates sf_guard_closed_period with the defensive to_jsonb fix', () => {
    const code = stripSqlComments(sql);
    assert(/create\s+or\s+replace\s+function\s+public\.sf_guard_closed_period\b/i.test(code), 'create or replace function public.sf_guard_closed_period missing');
    assert(/to_jsonb\s*\(\s*new\s*\)\s*->>\s*'company_id'/i.test(code), 'defensive to_jsonb(NEW) ->> company_id resolution missing');
    assert(!/\bnew\s*\.\s*company_id\b/i.test(code), 'the guard must not read NEW.company_id directly again (that was the regression)');
  });

  await check('migration defines sf_notify_submission with exception when others', () => {
    const code = stripSqlComments(sql);
    assert(/create\s+or\s+replace\s+function\s+public\.sf_notify_submission\b/i.test(code), 'create or replace function public.sf_notify_submission missing');
    assert(/exception\s+when\s+others\s+then/i.test(code), 'exception when others then ... (best-effort notification) missing');
    // The failure handler must return NEW so the business write is never rolled back.
    const body = code.slice(code.search(/create\s+or\s+replace\s+function\s+public\.sf_notify_submission\b/i));
    assert(/exception\s+when\s+others\s+then[\s\S]*?return\s+new\b/i.test(body), 'exception handler must return NEW');
    assert(/public\.profiles\s+p/i.test(body), 'notifications must be addressed from public.profiles');
    assert(/p\.role\s+in\s*\(\s*''?director''?\s*,\s*''?controller''?\s*\)/i.test(body), 'notification recipients must be director/controller profiles');
  });

  await check('migration installs the three submission triggers idempotently', () => {
    const code = stripSqlComments(sql);
    for (const trigger of ['trg_notify_materials', 'trg_notify_company_expenses', 'trg_notify_site_reports']) {
      assert(new RegExp(`drop\\s+trigger\\s+if\\s+exists\\s+${trigger}\\s+on\\s+public\\.`, 'i').test(code), `drop trigger if exists ${trigger} missing`);
      assert(new RegExp(`create\\s+trigger\\s+${trigger}\\b`, 'i').test(code), `create trigger ${trigger} missing`);
    }
    assert(/after\s+insert\s+or\s+update\s+on\s+public\.materials/i.test(code), 'materials trigger must fire on insert or update');
    assert(/after\s+insert\s+or\s+update\s+on\s+public\.company_expenses/i.test(code), 'company_expenses trigger must fire on insert or update');
    assert(/after\s+insert\s+on\s+public\.site_reports/i.test(code), 'site_reports trigger must fire on insert');
  });

  await check("migration reloads PostgREST's schema cache (notify pgrst)", () => {
    assert(/notify\s+pgrst\s*,\s*'reload\s+schema'/i.test(sql), "notify pgrst, 'reload schema' missing");
  });

  await check('app.js exposes SF.expenses and stores bills under company/bills/', () => {
    assert(/window\.SF\.expenses\s*=\s*\{/.test(appSrc), 'window.SF.expenses bridge missing');
    for (const fn of ['open:', 'poNumbers:', 'uploadBill:', 'setPendingBill:', 'pendingBill:', 'billPath:']) {
      assert(appSrc.indexOf(fn) >= 0, `SF.expenses.${fn.replace(':', '')} missing`);
    }
    assert(/company\/bills\//.test(appSrc), "bill_path prefix company/bills/ missing");
    assert(/po_number\s*:\s*po/i.test(appSrc), 'company_expenses payload must include po_number');
    assert(/company_id\s*:\s*state\.company/i.test(appSrc), 'company_expenses payload must include company_id');
  });
}

/* -------------------------------------------------------- expenses (manager) */

async function expenseChecks() {
  console.log('\nHeadless — expense editor (controller)');
  await withApp({ role: 'controller', project: 0 }, async ({ evaluate, goView, waitFor, diagnostics }) => {
    diagnostics.clear();
    await goView('expenses');
    const po = unique('PO-QA');

    await check('expenses view opens the New/Scan expense entry points', async () => {
      const surface = await evaluate(`(function(){
        return {
          newExpense: typeof window.newExpense === 'function',
          scanBtn: !!document.querySelector('#main button[onclick*="openExpenseScanner"]'),
          bridge: !!(window.SF && window.SF.expenses),
          open: typeof (window.SF && window.SF.expenses && window.SF.expenses.open),
          setPendingBill: typeof (window.SF && window.SF.expenses && window.SF.expenses.setPendingBill),
          billPath: typeof (window.SF && window.SF.expenses && window.SF.expenses.billPath)
        };
      })()`);
      assert(surface.newExpense, 'window.newExpense missing');
      assert(surface.scanBtn, 'expenses view has no "Scan bill" (openExpenseScanner) button');
      assert(surface.bridge, 'window.SF.expenses bridge missing');
      assert(surface.open === 'function', 'SF.expenses.open missing');
      assert(surface.setPendingBill === 'function', 'SF.expenses.setPendingBill missing');
      assert(surface.billPath === 'function', 'SF.expenses.billPath missing');
    });

    await check('New expense modal exposes bill upload, PO # + datalist and save', async () => {
      await evaluate('window.newExpense(); true');
      const fields = await evaluate(`(function(){
        var ids = ['expBillFile','eb_po','eb_po_list','eb_save','eb_date','eb_supplier','eb_desc','eb_amount','eb_category','eb_method','eb_savecopy'];
        var out = {};
        ids.forEach(function(id){ out[id] = !!document.getElementById(id); });
        var dz = document.querySelector('#modalRoot .dropzone');
        out.dropzoneText = dz ? dz.textContent : '';
        return out;
      })()`);
      for (const id of ['expBillFile', 'eb_po', 'eb_po_list', 'eb_save', 'eb_date', 'eb_supplier', 'eb_desc', 'eb_amount']) {
        assert(fields[id], `#${id} missing from the New expense modal`);
      }
      assert(/upload or scan/i.test(fields.dropzoneText), 'bill dropzone does not advertise upload/scan');
      await waitFor(
        `(function(){var dl=document.getElementById('eb_po_list');return !!dl && dl.options && dl.options.length>0;})()`,
        { label: 'PO # datalist populated from materials', timeout: 10000 }
      );
    });

    let beforeIds = [];
    let savedRow = null;
    await check('controller save inserts ONE company_expenses row with company_id/po_number/bill_path', async () => {
      beforeIds = await evaluate('window.__MOCK_DB.company_expenses.map(function(x){return x.id;})');
      const filled = await evaluate(`(function(){
        function set(id,v){var el=document.getElementById(id);if(!el)return false;el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}
        var d=new Date();
        var today=d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
        var ok = set('eb_date',today) && set('eb_supplier','QA Bill Vendor') && set('eb_desc','QA bill cost')
              && set('eb_amount','123.45') && set('eb_po', ${JSON.stringify(po)});
        var cat=document.getElementById('eb_category'); if(cat)cat.value='Utilities';
        var proj=document.getElementById('eb_project'); if(proj)proj.value=''; // do not register a supplier
        return ok;
      })()`);
      assert(filled, 'expense form fields are missing');
      await evaluate(`window.SF.expenses.setPendingBill(btoa('fake-bill-bytes'),'image/png'); true`);
      const pending = await evaluate('window.SF.expenses.pendingBill()');
      assertEqual(pending && pending.mime, 'image/png', 'SF.expenses.pendingBill mime');
      await evaluate('window.saveExpenseForm()');
      await waitFor(
        `(window.__MOCK_DB.company_expenses||[]).length === ${beforeIds.length + 1}`,
        { label: 'exactly one new company_expenses row', timeout: 15000 }
      );
      const delta = await evaluate(`(function(){
        var before = ${JSON.stringify(beforeIds)};
        var rows = (window.__MOCK_DB.company_expenses||[]).filter(function(x){return before.indexOf(x.id)<0;});
        return { count: rows.length, row: rows[0]||null, companyId: (window.__MOCK_DB.companies[0]||{}).id };
      })()`);
      assertEqual(delta.count, 1, 'company_expenses rows created by one save');
      savedRow = delta.row;
      assert(savedRow, 'saved expense row missing');
      assert(savedRow.company_id === delta.companyId, `company_id must be the current company (got ${JSON.stringify(savedRow.company_id)})`);
      assertEqual(savedRow.po_number, po, 'po_number round-trips');
      assert(/^company\/bills\//.test(String(savedRow.bill_path || '')), `bill_path must start with company/bills/ (got ${JSON.stringify(savedRow.bill_path)})`);
      assertEqual(savedRow.status, 'approved', 'controller expense status');
      assertEqual(Number(savedRow.amount), 123.45, 'saved amount');
      await waitFor(
        `(window.SF.state.expenses||[]).some(function(e){return e.id===${JSON.stringify(savedRow.id)};})`,
        { label: 'saved expense reloaded into app state', timeout: 10000 }
      );
    });

    await check('edit expense prefills the PO #, offers Remove bill and preserves bill_path', async () => {
      assert(savedRow, 'no saved row to edit');
      await evaluate(`window.editExpense(${JSON.stringify(savedRow.id || '')}); true`);
      const edit = await evaluate(`(function(){
        var po=document.getElementById('eb_po');
        var amt=document.getElementById('eb_amount');
        var del=document.getElementById('eb_removebill');
        var open=document.querySelector('#modalRoot button[onclick*="openBillCopy"]');
        return {
          po: po ? po.value : null,
          amount: amt ? Number(amt.value) : null,
          removeBill: !!del,
          openBill: !!open,
          billPath: window.SF.expenses.billPath()
        };
      })()`);
      assertEqual(edit.po, po, 'PO # prefilled on edit');
      assertEqual(edit.amount, 123.45, 'amount prefilled on edit');
      assert(edit.removeBill, '#eb_removebill missing for an expense that has a bill');
      assert(edit.openBill, '"Open current bill" affordance missing');
      assertEqual(edit.billPath, savedRow.bill_path, 'SF.expenses.billPath exposes the existing bill');
      const editedAmount = await evaluate(`(function(){
        var el=document.getElementById('eb_amount');
        if(!el)return false;
        el.value='200.50';
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
      assert(editedAmount, '#eb_amount missing on edit');
      await evaluate('window.saveExpenseForm()');
      await waitFor(
        `(function(){var r=(window.__MOCK_DB.company_expenses||[]).filter(function(x){return x.id===${JSON.stringify(savedRow.id || '')};})[0];return !!r && Number(r.amount)===200.5;})()`,
        { label: 'edited amount persisted', timeout: 15000 }
      );
      const after = await evaluate(`(function(){
        var rows=(window.__MOCK_DB.company_expenses||[]);
        var mine=rows.filter(function(x){return x.id===${JSON.stringify(savedRow.id || '')};})[0];
        var unwanted=rows.filter(function(x){return ${JSON.stringify(beforeIds)}.indexOf(x.id)<0 && x.id!==${JSON.stringify(savedRow.id || '')};});
        return { count: rows.length, row: mine, extra: unwanted.length };
      })()`);
      assertEqual(after.extra, 0, 'edit must not insert another company_expenses row');
      assertEqual(Number(after.row.amount), 200.5, 'edited amount');
      assertEqual(after.row.bill_path, savedRow.bill_path, 'bill_path must be preserved when the amount is edited');
      assertEqual(after.row.po_number, po, 'po_number must be preserved when the amount is edited');
    });

    await check('no JS exceptions in the expense session', () => {
      assertEqual(diagnostics.errors.length, 0, 'JS exceptions: ' + diagnostics.errors.join(' | '));
    });
  });
}

/* ------------------------------------- notifications refresh (non-manager) */

async function notificationChecks() {
  console.log('\nHeadless — submission notifications + site-report photo (lead)');
  await withApp({ role: 'lead', project: 0 }, async ({ evaluate, goView, waitFor, diagnostics }) => {
    diagnostics.clear();
    // Wait until the post-login notifications load has completed so a marker
    // planted afterwards is provably absent from app state until a re-read runs.
    await waitFor(
      `(function(){var db=(window.__MOCK_DB.notifications||[]).length;var st=(window.SF.state.notifications||[]).length;return db>0 && st===db;})()`,
      { label: 'initial notifications loaded', timeout: 10000 }
    );

    const marker1 = unique('QA marker materials');
    const marker1StateBefore = await evaluate(`(function(){
      var title=${JSON.stringify(marker1)};
      var already=(window.SF.state.notifications||[]).some(function(n){return n.title===title;});
      window.__MOCK_DB.notifications.push({id:'qa-marker-mat-'+Date.now(),title:title,body:'planted by expenses-notifications check',is_read:false,created_at:new Date().toISOString()});
      return already;
    })()`);
    assertEqual(marker1StateBefore, false, 'marker must not be in app state before the material submission');

    const matPo = unique('QA-PO-MAT');
    await check('material PO submitted as lead saves pending and refreshes notifications', async () => {
      await evaluate('window.newMaterial(); true');
      const filled = await evaluate(`(function(){
        function set(id,v){var el=document.getElementById(id);if(!el)return false;el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}
        return set('f_po',${JSON.stringify(matPo)}) && set('f_supplier','QA Supplier') && set('f_description','QA notification probe')
            && set('f_quantity','2') && set('f_unit','EA') && set('f_unit_cost_aed','150');
      })()`);
      assert(filled, 'newMaterial form fields (#f_po/#f_supplier/...) missing');
      await evaluate('document.getElementById("formSubmitBtn").click(); true');
      await waitFor(
        `(function(){var m=(window.__MOCK_DB.materials||[]).filter(function(x){return x.po_number===${JSON.stringify(matPo)};});return m.length===1 && m[0].status==='pending';})()`,
        { label: 'material PO saved as pending', timeout: 15000 }
      );
      await waitFor(
        `(window.SF.state.notifications||[]).some(function(n){return n.title===${JSON.stringify(marker1)};})`,
        { label: 'materials submission refreshed notifications', timeout: 10000 }
      );
    });

    const marker2 = unique('QA marker site report');
    const reportTitle = unique('QA site report');
    const marker2StateBefore = await evaluate(`(function(){
      var title=${JSON.stringify(marker2)};
      var already=(window.SF.state.notifications||[]).some(function(n){return n.title===title;});
      window.__MOCK_DB.notifications.push({id:'qa-marker-sr-'+Date.now(),title:title,body:'planted by expenses-notifications check',is_read:false,created_at:new Date().toISOString()});
      return already;
    })()`);
    assertEqual(marker2StateBefore, false, 'second marker must not be in app state before the site-report save');

    await check('site report photo uploads, stores photos[0].path and refreshes notifications', async () => {
      await goView('site-reports');
      await evaluate('window.newSiteReport(); true');
      const titleSet = await evaluate(`(function(){var t=document.getElementById('sr_title');if(!t)return false;t.value=${JSON.stringify(reportTitle)};t.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      assert(titleSet, '#sr_title missing from the New site report modal');
      const photoInjected = await evaluate(`(function(){
        var b64=${JSON.stringify(PNG_1X1)};
        var bin=atob(b64);
        var arr=new Uint8Array(bin.length);
        for(var i=0;i<bin.length;i+=1)arr[i]=bin.charCodeAt(i);
        var file=new File([arr],'qa-1x1.png',{type:'image/png'});
        var dt=new DataTransfer();
        dt.items.add(file);
        var input=document.getElementById('sr_photos');
        if(!input)return false;
        input.files=dt.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
      assert(photoInjected, '#sr_photos input missing from the New site report modal');
      await waitFor('(window._reportPhotos||[]).length===1', { label: 'site report photo processed by the browser', timeout: 15000 });
      const pendingPhoto = await evaluate(`(function(){var p=(window._reportPhotos||[])[0]||{};return {name:p.name,mime:p.mime,size:p.size};})()`);
      assert(pendingPhoto.size > 0, 'processed photo has no bytes');
      assert(/^image\/(webp|jpeg)$/.test(String(pendingPhoto.mime)), `processed photo mime (canvas re-encode) got ${JSON.stringify(pendingPhoto.mime)}`);
      await evaluate('window.saveSiteReport()');
      await waitFor(
        `(window.__MOCK_DB.site_reports||[]).some(function(r){return r.title===${JSON.stringify(reportTitle)};})`,
        { label: 'site report row saved', timeout: 15000 }
      );
      const report = await evaluate(`(function(){
        var rows=(window.__MOCK_DB.site_reports||[]).filter(function(r){return r.title===${JSON.stringify(reportTitle)};});
        return { count: rows.length, row: rows[0]||null, projectId: window.SF.currentProjectId };
      })()`);
      assertEqual(report.count, 1, 'exactly one site report row for the title');
      assert(Array.isArray(report.row.photos), 'site_reports.photos must be an array');
      assertEqual(report.row.photos.length, 1, 'one photo stored on the report');
      assert(report.row.photos[0].path, 'photo entry has no storage path');
      assert(
        String(report.row.photos[0].path).indexOf(String(report.projectId) + '/site-reports/') === 0,
        `photo path must live under <project>/site-reports/ (got ${JSON.stringify(report.row.photos[0].path)})`
      );
      assertEqual(report.row.project_id, report.projectId, 'site report project_id');
      assert(report.row.created_by, 'site report created_by missing');
      await waitFor(
        `(window.SF.state.notifications||[]).some(function(n){return n.title===${JSON.stringify(marker2)};})`,
        { label: 'site report save refreshed notifications', timeout: 10000 }
      );
    });

    await check('no JS exceptions in the submission session', () => {
      assertEqual(diagnostics.errors.length, 0, 'JS exceptions: ' + diagnostics.errors.join(' | '));
    });
  });
}

/* ----------------------------------------------------------------- summary */

async function main() {
  console.log('\nExpenses / PO / notifications / site-report photos — v29.7.0');
  await staticChecks();
  await expenseChecks();
  await notificationChecks();

  const failed = results.filter((r) => !r.ok);
  console.log(`\nExpenses & notifications: ${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    console.log('Failures:');
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error('\n✗ expenses-notifications checks crashed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
