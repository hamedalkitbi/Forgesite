#!/usr/bin/env python3
"""
SiteForge ERP v28 -> v28.2  (18 exact-anchor patches, one file)

  A1-A11  v28.1 : date/time helpers, permission gate, slider, profiles.active,
                  BOQ null guard, 2x XSS in modal titles, IPC UTC shift,
                  reMapBOQ guard, #version overlay, timesheet edit, error buffer
  B1-B6   v28.2 : schema-drift self-heal (insertRow/updateRow), drop company_id,
                  scan button, bill-copy link, expense bill scanner + supplier register

Usage:  python3 apply_all.py index.html [-o out.html]
Idempotent. Writes nothing unless every anchor matches.
"""
import sys, io

PATCHES = []
def P(name, before, after):
    PATCHES.append((name, before, after))

# ============================================================
# B6 payload — expense bill scanner module (injected into the IIFE)
# ============================================================
M = r'''/* ===== v28.2 EXPENSE BILL SCANNER + SUPPLIER AUTO-REGISTER ===== */
var expScan={file:null,fileB64:null,mime:null};
function supplierKey(s){return String(s==null?'':s).trim().toLowerCase().replace(/\s+/g,' ');}
function base64ToBytes(b64){var bin=atob(String(b64||''));var n=bin.length;var out=new Uint8Array(n);for(var i=0;i<n;i++)out[i]=bin.charCodeAt(i);return out;}
function setBillStatus(txt){var el=document.getElementById('expBillStatus');if(el)el.innerHTML=esc(String(txt)).replace(/\n/g,'<br>');}
function guessExpenseCategory(text){
  var s=String(text||'').toLowerCase();
  var map=[[/cement|concrete|sand|aggregate|steel|rebar|block|brick|timber|plywood|paint|tile|insulation|pipe|cable|conduit|fixing|bolt|سمنت|حديد|رمل|طوب|اسمنت/,'Materials'],
    [/rental|hire|crane|excavator|generator|compressor|scaffold|forklift/,'Equipment'],
    [/diesel|fuel|petrol|transport|delivery|freight|truck|نقل|ديزل|وقود/,'Transport'],
    [/dewa|sewa|addc|electricity|water bill|utility|كهرباء|مياه/,'Utilities'],
    [/legal|consult|engineer|survey|audit|استشاري/,'Professional'],
    [/repair|service|maintenance|صيانة/,'Maintenance'],
    [/stationery|printer|paper|office|مكتبية|قرطاسية/,'Office Supplies'],
    [/insurance|تأمين/,'Insurance']];
  for(var i=0;i<map.length;i++){if(map[i][0].test(s))return map[i][1];}
  return 'Other';
}
function parseBillForExpense(text){
  var t2=String(text||'');
  var lines=t2.replace(/\r/g,'\n').split('\n').map(function(l){return l.trim();}).filter(Boolean);
  var cands=[],mm;
  var re=/(?:^|[^a-z])(grand\s+total|total(?:\s+(?:amount|due|incl(?:usive)?|payable|net))?|amount\s+due|balance\s+due|net\s+total|الإجمالي|المجموع)[^\d\n]{0,16}([A-Z]{0,3})?\s*([\d][\d,]*(?:\.\d{1,2})?)/gi;
  while((mm=re.exec(t2))!==null){
    var label=String(mm[1]||'').toLowerCase();
    var val=parseFloat(String(mm[3]||'').replace(/,/g,''));
    if(!isFinite(val)||val<=0)continue;
    var w=/(grand|amount\s+due|balance)/.test(label)?3:(/^total/.test(label)?2:1);
    cands.push({v:val,w:w});
  }
  var amount=0;
  if(cands.length){cands.sort(function(a,b){return b.w-a.w||b.v-a.v;});amount=cands[0].v;}
  else{var nums=t2.match(/\d[\d,]*(?:\.\d{1,2})?/g)||[];var best=0;for(var q=0;q<nums.length;q++){var n0=parseFloat(String(nums[q]).replace(/,/g,''));if(isFinite(n0)&&n0>best)best=n0;}amount=best;}
  var vatRate=null;
  var vm=t2.match(/(?:vat|tax|ضريبة|ضريبه)[^\d\n%]{0,16}([\d][\d,]*\.?\d{0,2})\s*(%)?/i);
  if(vm){var nv=parseFloat(String(vm[1]).replace(/,/g,''));if(isFinite(nv)&&(vm[2]||nv<=30))vatRate=nv;}
  var supplier='';
  var sm=t2.match(/(?:from|supplier|vendor|seller|billed\s+by|المورد|البائع)\s*[:#-]?\s*(.{2,60})/i);
  if(sm)supplier=sm[1].trim();
  if(!supplier){
    for(var i=0;i<Math.min(lines.length,4);i++){
      var l=lines[i];
      if(l.length>=3&&/[a-z\u0600-\u06FF]{3}/i.test(l)&&!/invoice|receipt|bill\s+to|date|tel|phone|trn|voucher|statement/i.test(l)){supplier=l;break;}
    }
  }
  if(supplier.length>60)supplier=supplier.slice(0,60);
  var date=today();
  var dm=t2.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/)||t2.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
  if(dm){
    if(String(dm[1]).length===4){date=dm[1]+'-'+String(dm[2]).padStart(2,'0')+'-'+String(dm[3]).padStart(2,'0');}
    else{var y=String(dm[3]).length===2?'20'+dm[3]:dm[3];date=y+'-'+String(dm[2]).padStart(2,'0')+'-'+String(dm[1]).padStart(2,'0');}
  }
  var desc='';
  for(var k=0;k<lines.length;k++){
    var ln=lines[k];
    if(ln.length>desc.length&&ln.length<=80&&/[a-z\u0600-\u06FF]{3}/i.test(ln)&&!/total|vat|tax|invoice|receipt|date|tel|phone|trn|balance|subtotal|amount|due|grand/i.test(ln)&&supplierKey(ln)!==supplierKey(supplier))desc=ln;
  }
  if(!desc)desc=supplier||'Scanned bill';
  return {supplier:supplier,amount:amount,date:date,desc:desc,vatRate:vatRate,category:guessExpenseCategory(t2)};
}
async function findSupplierByName(name){
  var key=supplierKey(name);if(!key)return null;
  var local=(state.parties||[]).filter(function(p){return p.type==='supplier'&&supplierKey(p.name)===key;});
  if(local.length)return local[0];
  if(!supabase)return null;
  try{
    var r=await supabase.from('project_parties').select('id,name,party_type,project_id').eq('party_type','supplier').limit(1000);
    if(!r.error&&r.data&&r.data.length){
      for(var i=0;i<r.data.length;i++){if(supplierKey(r.data[i].name)===key)return {id:r.data[i].id,name:r.data[i].name,type:'supplier'};}
    }
  }catch(e){}
  return null;
}
async function ensureSupplier(name,projectId){
  var n=String(name||'').trim();
  if(!n)return {party:null,created:false,reason:'empty'};
  var hit=await findSupplierByName(n);
  if(hit)return {party:hit,created:false};
  if(!projectId)return {party:null,created:false,reason:'no-project'};
  var ins=await insertRow('project_parties',{project_id:projectId,party_type:'supplier',name:n,company_name:n,notes:'Auto-registered from scanned bill'});
  if(state.currentProjectId===projectId){try{await reloadProjectTable('project_parties',null,true);}catch(e){}}
  return {party:{id:ins.id,name:n},created:true};
}
window.findSupplierByName=findSupplierByName;
window.ensureSupplier=ensureSupplier;
window.openBillCopy=async function(path){
  if(!path)return;
  try{
    var r=await supabase.storage.from('siteforge-files').createSignedUrl(path,3600);
    if(r.error)throw r.error;
    window.open(r.data.signedUrl,'_blank','noopener,noreferrer');
  }catch(e){toast('Bill copy unavailable','bad');}
};
function updateVatHint(){
  var a=document.getElementById('eb_amount'),h=document.getElementById('eb_vat');
  if(!a||!h)return;
  var v=Number(a.value);
  if(!(v>0)){h.textContent='';return;}
  var net=Math.round((v/1.05)*100)/100, vat=Math.round((v-net)*100)/100;
  h.textContent='Net '+money(net)+' + VAT 5% '+money(vat);
}
var _supHintTimer=null;
function checkSupplierHint(){
  var s=document.getElementById('eb_supplier'),h=document.getElementById('eb_supplier_hint');
  if(!s||!h)return;
  var name=s.value.trim();
  if(!name){h.textContent='';return;}
  clearTimeout(_supHintTimer);
  _supHintTimer=setTimeout(async function(){
    try{
      var hit=await findSupplierByName(name);
      if(hit){h.innerHTML='<span style="color:var(--ok)">\u2713 Existing supplier</span>';return;}
      var pv=document.getElementById('eb_project');
      if(pv&&pv.value){
        var pr=state.projects.filter(function(x){return x.id===pv.value;})[0];
        h.innerHTML='<span style="color:var(--accent)">+ Will register as new supplier under '+esc(pr?pr.code:'project')+'</span>';
      }else{h.innerHTML='<span class="mutc">Pick a project below to register this supplier</span>';}
    }catch(e){}
  },250);
}
function applyExpenseOcr(p){
  if(!p)return;
  var d=document.getElementById('eb_date'),s=document.getElementById('eb_supplier'),g=document.getElementById('eb_desc'),a=document.getElementById('eb_amount'),c=document.getElementById('eb_category');
  if(d&&p.date)d.value=p.date;
  if(s&&p.supplier)s.value=p.supplier;
  if(g&&p.desc)g.value=p.desc;
  if(a&&p.amount)a.value=(Math.round(p.amount*100)/100).toFixed(2);
  if(c&&p.category)c.value=p.category;
  updateVatHint();checkSupplierHint();
}
window.openExpenseScanner=function(){
  expScan={file:null,fileB64:null,mime:null};
  var defProj=state.currentProjectId||(state.projects.length===1?state.projects[0].id:'');
  var projOptions=state.projects.map(function(p){return '<option value="'+esc(p.id)+'" '+(defProj===p.id?'selected':'')+'>'+esc(p.code)+' \u00b7 '+esc(p.name)+'</option>';}).join('');
  var cats=['Materials','Equipment','Transport','Utilities','Professional','Maintenance','Office Supplies','Insurance','Other'];
  openModal('\ud83d\udcf7 Scan bill \u2192 Expense',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">'+
      '<div>'+
        '<div class="dropzone" onclick="document.getElementById(\'expBillFile\').click()">'+
          '<input type="file" id="expBillFile" accept="image/*" capture="environment" style="display:none" onchange="handleExpBillFile(event)">'+
          '<div style="font-size:32px">\ud83d\udcf7</div><div style="font-weight:800;margin-top:4px">Photo / upload the bill</div>'+
          '<div class="mutc" style="font-size:11px;margin-top:4px">Supplier invoice, receipt or delivery note</div>'+
        '</div>'+
        '<label style="display:flex;gap:7px;align-items:center;margin-top:10px;font-size:12px;font-weight:700;color:var(--muted);cursor:pointer"><input type="checkbox" id="eb_savecopy" checked style="width:15px;height:15px;accent-color:var(--accent)"> Save a copy of the bill</label>'+
        '<div id="expBillStatus" style="margin-top:10px;padding:10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;font-family:var(--font-mono);font-size:11px;line-height:1.55;max-height:140px;overflow:auto">Ready. The image is stored as the bill copy and attached to the expense.</div>'+
        '<div id="expBillThumb" style="margin-top:10px"></div>'+
      '</div>'+
      '<div class="fgrid" style="grid-template-columns:1fr;gap:10px">'+
        '<div class="field"><label>'+t('date')+'</label><input id="eb_date" type="date" value="'+today()+'"></div>'+
        '<div class="field"><label>'+t('supplier')+' / '+t('paidTo')+'</label><input id="eb_supplier" placeholder="Supplier name" autocomplete="off"><div id="eb_supplier_hint" class="mutc" style="font-size:10.5px;min-height:14px"></div></div>'+
        '<div class="field"><label>'+t('category')+'</label><select id="eb_category">'+cats.map(function(c){return '<option>'+c+'</option>';}).join('')+'</select></div>'+
        '<div class="field"><label>'+t('description')+'</label><input id="eb_desc" placeholder="What was bought"></div>'+
        '<div class="field"><label>'+t('amount')+' (AED, incl. VAT)</label><input id="eb_amount" type="number" step="0.01" min="0" placeholder="0.00"><div id="eb_vat" class="mutc" style="font-size:10.5px"></div></div>'+
        '<div class="field"><label>'+t('method')+'</label><select id="eb_method"><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>Credit Card</option><option>Other</option></select></div>'+
        '<div class="field"><label>Register supplier under project</label><select id="eb_project" onchange="checkSupplierHint()"><option value="">\u2014 do not register \u2014</option>'+projOptions+'</select></div>'+
      '</div>'+
    '</div>'+
    '<div class="ferror" id="eb_err"></div>',
    '<button class="btn ghost" onclick="closeModal()">'+t('cancel')+'</button><button class="btn" id="eb_save" onclick="saveScannedExpense()">Save expense</button>',
    {wide:true});
  setTimeout(function(){
    var a=document.getElementById('eb_amount');if(a)a.addEventListener('input',updateVatHint);
    var s=document.getElementById('eb_supplier');if(s)s.addEventListener('blur',checkSupplierHint);
    updateVatHint();
  },50);
};
window.handleExpBillFile=function(ev){
  var f=ev.target.files&&ev.target.files[0];if(!f)return;
  if(f.size>12*1024*1024){toast('Image too large (max 12 MB)','bad');return;}
  expScan.file=f;expScan.mime=f.type||'image/jpeg';
  var rd=new FileReader();
  rd.onload=function(e){
    var url=e.target.result;
    expScan.fileB64=String(url).split(',')[1]||null;
    var thumb=document.getElementById('expBillThumb');
    if(thumb)thumb.innerHTML='<img src="'+url+'" style="max-width:100%;max-height:170px;border-radius:8px;border:1px solid var(--line)">';
    runExpenseOcr(expScan.fileB64,expScan.mime);
  };
  rd.readAsDataURL(f);
};
async function runExpenseOcr(b64,mime){
  setBillStatus('\u27f3 Reading bill\u2026');
  try{
    var s=await supabase.auth.getSession();var tk=s&&s.data&&s.data.session?s.data.session.access_token:null;
    var r=await fetch(SUPABASE_URL+'/functions/v1/scan-invoice-real',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(tk||''),'apikey':SUPABASE_ANON_KEY},body:JSON.stringify({imageBase64:b64,mimeType:mime})});
    if(r.ok){
      var d=await r.json();
      if(d&&(d.vendor||d.lineItem)&&Number(d.unitPrice)>0){
        applyExpenseOcr({supplier:d.vendor||'',date:d.invoiceDate||today(),desc:d.lineItem||'',amount:(Number(d.quantity)||1)*(Number(d.unitPrice)||0),category:guessExpenseCategory((d.lineItem||'')+' '+(d.vendor||''))});
        setBillStatus('\u2713 Read by server. Check every field before saving.');
        return;
      }
    }
  }catch(e){}
  try{
    setBillStatus('\u27f3 Loading OCR engine\u2026');
    await loadTesseract();
    var res=await Tesseract.recognize('data:'+mime+';base64,'+b64,'eng',{logger:function(m){if(m.status==='recognizing text')setBillStatus('\u27f3 '+Math.round(m.progress*100)+'%');}});
    var text=(res.data&&res.data.text)||'';
    if(!text.trim())throw new Error('no readable text');
    var p=parseBillForExpense(text);
    if(!p.amount||p.amount<=0)throw new Error('no total found');
    applyExpenseOcr(p);
    setBillStatus('\u2713 Read in your browser. Check every field before saving.');
  }catch(err){
    setBillStatus('\u2717 Could not read this bill ('+(err.message||err)+'). Fill the fields manually - the image is still saved as the bill copy.');
  }
}
window.saveScannedExpense=async function(){
  var btn=document.getElementById('eb_save');if(btn&&btn.disabled)return;
  var errEl=document.getElementById('eb_err');if(errEl)errEl.textContent='';
  var date=document.getElementById('eb_date').value;
  var supplier=document.getElementById('eb_supplier').value.trim();
  var category=document.getElementById('eb_category').value;
  var desc=document.getElementById('eb_desc').value.trim()||supplier||'Scanned bill';
  var amount=Number(document.getElementById('eb_amount').value);
  var method=document.getElementById('eb_method').value;
  var projSel=document.getElementById('eb_project').value;
  var copyEl=document.getElementById('eb_savecopy');
  var keepCopy=copyEl?copyEl.checked:true;
  if(!date){if(errEl)errEl.textContent='Date is required';return;}
  if(!(amount>0)){if(errEl)errEl.textContent='Amount must be greater than zero';return;}
  if(btn){btn.disabled=true;btn.textContent='Saving\u2026';}
  try{
    var billPath=null;
    if(keepCopy&&expScan.fileB64){
      try{
        var ext=(expScan.mime&&expScan.mime.indexOf('png')>=0)?'png':'jpg';
        var path='company/bills/'+date.slice(0,7).replace('-','/')+'/'+Date.now()+'_'+String(supplier||'bill').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,40)+'.'+ext;
        var up=await supabase.storage.from('siteforge-files').upload(path,base64ToBytes(expScan.fileB64),{contentType:expScan.mime||'image/jpeg',upsert:false});
        if(up.error)throw up.error;
        billPath=path;
      }catch(e){
        setBillStatus('\u26a0 Image not uploaded ('+(e.message||e)+'). The expense is still saved.');
      }
    }
    var payload={category:category,description:desc,amount:amount,expense_date:date,paid_to:supplier||null,payment_method:method,created_by:userProfile.name,status:(isManagerRole()?'approved':'pending')};
    if(billPath)payload.bill_path=billPath;
    await insertRow('company_expenses',payload);
    var reg=null;
    if(supplier){try{reg=await ensureSupplier(supplier,projSel||null);}catch(e){console.warn('supplier register failed',e);}}
    await loadCompanyData();
    closeModal();render();
    var msg='Expense saved';
    if(reg&&reg.created)msg='Expense saved, supplier "'+supplier+'" registered';
    else if(reg&&reg.reason==='no-project'&&supplier)msg='Expense saved. Pick a project to register the supplier.';
    toast(msg,'ok');
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent='Save expense';}
    if(errEl)errEl.textContent='\u2717 '+(e.message||e);
  }
};
'''

# ============================================================
# A — v28.1 fixes
# ============================================================
P("A1 date/time helpers",
r'''function toLocalDate(v){
  if(v===null||v===undefined||v==='')return null;
  if(v instanceof Date)return isNaN(v.getTime())?null:v;
  var s=String(v).trim();
  var m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
  var d=new Date(s);
  return isNaN(d.getTime())?null:d;
}''',
r'''function toLocalDate(v){
  if(v===null||v===undefined||v==='')return null;
  if(v instanceof Date)return isNaN(v.getTime())?null:v;
  if(typeof v==='number'){var nd=new Date(v);return isNaN(nd.getTime())?null:nd;}
  var s=String(v).trim();
  if(/^\d{10}$|^\d{13}$/.test(s)){var np=new Date(Number(s));return isNaN(np.getTime())?null:np;}
  if(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)){var dt=new Date(s);return isNaN(dt.getTime())?null:dt;}
  var m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
  var d=new Date(s);
  return isNaN(d.getTime())?null:d;
}''')

P("A2 render() permission gate",
r'''  if(!state.currentProjectId&&['project-dash','boq','drawings','timeline','materials','payments','parties','change-orders','timesheets','payroll','audit','reports','progress-billing','site-reports'].indexOf(v)>=0){v='company-dash';currentView='company-dash';}''',
r'''  if(!state.currentProjectId&&['project-dash','boq','drawings','timeline','materials','payments','parties','change-orders','timesheets','payroll','audit','reports','progress-billing','site-reports'].indexOf(v)>=0){v='company-dash';currentView='company-dash';}
  if(!hasView(v)){var _ord=(state.currentProjectId?['project-dash','site-reports','boq','drawings','progress-billing','timeline','materials','payments','parties','change-orders','timesheets','payroll','audit','reports','approvals']:['company-dash','projects-list','expenses','company-budget','workers','compliance','approvals']).concat(['settings','history']);for(var _i=0;_i<_ord.length;_i++){if(hasView(_ord[_i])){v=_ord[_i];currentView=v;break;}}}''')

P("A3 font-size slider",
r'''window.setS=function(k,v){var prevLang=appSettings.language;appSettings[k]=v;saveSettings();applySettings();switchTab(k==='language'?'lang':'app');if(k==='language'&&prevLang!==v&&userProfile)render();toast(t('savedOk'),'ok');};''',
r'''window.setS=function(k,v){var prevLang=appSettings.language;appSettings[k]=v;saveSettings();applySettings();if(k==='fontSize'){var _d=document.querySelector('#sBody .srow .desc');if(_d)_d.textContent=appSettings.fontSize+'px';return;}switchTab(k==='language'?'lang':'app');if(k==='language'&&prevLang!==v&&userProfile)render();toast(t('savedOk'),'ok');};''')

P("A4 profiles.active truthiness",
r'''if(!prof.data.active)throw new Error('Account disabled');''',
r'''if(prof.data.active===false)throw new Error('Account disabled');''')

P("A5 BOQ description null guard",
r'''desc:x.description,unit:x.unit''',
r'''desc:String(x.description||''),unit:x.unit''')

P("A6a escape worker name in modal title",
r'''openFormModal({title:t('edit')+' \u2014 '+w.name,wide:true,values:workerFormValues(w),fields:workerFormFields(),''',
r'''openFormModal({title:t('edit')+' \u2014 '+esc(w.name),wide:true,values:workerFormValues(w),fields:workerFormFields(),''')

P("A6b escape billing no in modal title",
r'''openFormModal({title:t('edit')+' IPC \u2014 '+b.billingNo,wide:true,''',
r'''openFormModal({title:t('edit')+' IPC \u2014 '+esc(b.billingNo),wide:true,''')

P("A7 IPC default period local",
r'''  var t2=today();var s=new Date(Date.now()-30*86400000).toISOString().slice(0,10);''',
r'''  var t2=today();var s=(function(){var x=new Date();x.setDate(x.getDate()-30);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');})();''')

P("A8 reMapBOQ null guard",
r'''  var sheetName=sel?sel.value:window._boqWorkbook.SheetNames[0];''',
r'''  if(!window._boqWorkbook||!window._boqWorkbook.SheetNames||!window._boqWorkbook.SheetNames.length)return;
  var sheetName=sel?sel.value:window._boqWorkbook.SheetNames[0];''')

P("A9 version badge position",
r'''#version{position:fixed;top:6px;right:10px;''',
r'''#version{position:fixed;bottom:4px;right:10px;''')

P("A10 timesheet edit for managers",
r"""'</td><td class="tright" style="white-space:nowrap">'+(canApprove&&x.status==='pending'?'<button class="btn ok sm" onclick="approveTimesheet(\''+esc(x.id)+'\')">\u2713</button> <button class="btn bad sm" onclick="rejectTimesheet(\''+esc(x.id)+'\')">\u2715</button>':(canEdit?'<button class="btn ghost sm" onclick="editTimesheet(\''+esc(x.id)+'\')">\u270e</button> <button class="btn bad sm" onclick="deleteTimesheet(\''+esc(x.id)+'\')">\u2715</button>':''))+""",
r"""'</td><td class="tright" style="white-space:nowrap">'+(canApprove&&x.status==='pending'?'<button class="btn ok sm" onclick="approveTimesheet(\''+esc(x.id)+'\')">\u2713</button> <button class="btn bad sm" onclick="rejectTimesheet(\''+esc(x.id)+'\')">\u2715</button> ':'')+(canEdit?'<button class="btn ghost sm" onclick="editTimesheet(\''+esc(x.id)+'\')">\u270e</button> <button class="btn bad sm" onclick="deleteTimesheet(\''+esc(x.id)+'\')">\u2715</button>':'')+""")

P("A11 early-error buffer",
r'''window.onerror=function(m,u,l){var b=document.getElementById('globalError');if(b){b.style.display='block';b.textContent='\u274c '+m+' (line '+l+')';}return false;};''',
r'''window.__errQ=[];window.onerror=function(m,u,l){var b=document.getElementById('globalError');if(b){b.style.display='block';b.textContent='\u274c '+m+' (line '+l+')';}else{window.__errQ.push('\u274c '+m+' (line '+l+')');}return false;};(function(){function f(){var b=document.getElementById('globalError');if(b&&window.__errQ.length){b.style.display='block';b.textContent=window.__errQ.join('\n');}}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',f);}else{f();}})();''')

# ============================================================
# B — v28.2 expense scanner + schema drift
# ============================================================
P("B1 insertRow schema-drift retry",
r'''async function insertRow(table,data){
  if(!data.id)data.id=genUUID();
  var r=await supabase.from(table).insert(data).select();
  if(r.error)throw new Error(r.error.message);
  var inserted=r.data&&r.data[0]?r.data[0]:data;
  logTransaction('create',table,inserted.id,humanLabel(table,inserted),data.project_id||null,null,inserted);
  return inserted;
}''',
r'''function unknownColumnOf(err){
  var m=String((err&&err.message)||err||'').match(/Could not find the '([^']+)' column of '([^']+)' in the schema cache/i);
  return m?{column:m[1],table:m[2]}:null;
}
var _droppedCols={};
function noteDroppedColumn(table,col){
  var k=table+'.'+col;
  if(_droppedCols[k])return;
  _droppedCols[k]=true;
  console.warn('[SiteForge] column "'+col+'" missing on "'+table+'" - value skipped');
  toast('Column '+table+'.'+col+' is not in your database; that value was skipped','bad');
}
async function insertRow(table,data){
  if(!data.id)data.id=genUUID();
  var payload=Object.assign({},data);
  for(var attempt=0;attempt<10;attempt++){
    var r=await supabase.from(table).insert(payload).select();
    if(!r.error){
      var inserted=r.data&&r.data[0]?r.data[0]:payload;
      logTransaction('create',table,inserted.id,humanLabel(table,inserted),payload.project_id||null,null,inserted);
      return inserted;
    }
    var miss=unknownColumnOf(r.error);
    if(miss&&Object.prototype.hasOwnProperty.call(payload,miss.column)){delete payload[miss.column];noteDroppedColumn(table,miss.column);continue;}
    throw new Error(r.error.message);
  }
  throw new Error('Insert failed on "'+table+'": too many unknown columns.');
}''')

P("B2 updateRow schema-drift retry",
r'''async function updateRow(table,id,data,expectedUpdatedAt){
  var before=null;
  try{var b=await supabase.from(table).select('*').eq('id',id).single();before=b.data;}catch(e){}
  var q=supabase.from(table).update(data).eq('id',id);
  if(expectedUpdatedAt)q=q.eq('updated_at',expectedUpdatedAt);
  var r=await q.select('id');
  if(r.error)throw r.error;
  if(!r.data||!r.data.length)throw new Error(expectedUpdatedAt?'Record was modified by another user. Refresh and try again.':'Update affected 0 rows on "'+table+'" \u2014 check permissions.');
  var after=Object.assign({},before||{},data);
  logTransaction('update',table,id,humanLabel(table,after),after.project_id||null,before,after);
  return true;
}''',
r'''async function updateRow(table,id,data,expectedUpdatedAt){
  var before=null;
  try{var b=await supabase.from(table).select('*').eq('id',id).single();before=b.data;}catch(e){}
  var payload=Object.assign({},data);
  for(var attempt=0;attempt<10;attempt++){
    var q=supabase.from(table).update(payload).eq('id',id);
    if(expectedUpdatedAt)q=q.eq('updated_at',expectedUpdatedAt);
    var r=await q.select('id');
    if(!r.error){
      if(!r.data||!r.data.length)throw new Error(expectedUpdatedAt?'Record was modified by another user. Refresh and try again.':'Update affected 0 rows on "'+table+'" \u2014 check permissions.');
      var after=Object.assign({},before||{},payload);
      logTransaction('update',table,id,humanLabel(table,after),after.project_id||null,before,after);
      return true;
    }
    var miss=unknownColumnOf(r.error);
    if(miss&&Object.prototype.hasOwnProperty.call(payload,miss.column)){delete payload[miss.column];noteDroppedColumn(table,miss.column);continue;}
    throw r.error;
  }
  throw new Error('Update failed on "'+table+'": too many unknown columns.');
}''')

P("B3 drop company_id from expense insert",
r'''      await insertRow('company_expenses',{company_id:state.company?state.company.id:null,category:d.category,description:d.description,amount:Number(d.amount),expense_date:d.expense_date,paid_to:d.paid_to||null,payment_method:d.payment_method,created_by:userProfile.name,status:status});''',
r'''      await insertRow('company_expenses',{category:d.category,description:d.description,amount:Number(d.amount),expense_date:d.expense_date,paid_to:d.paid_to||null,payment_method:d.payment_method,created_by:userProfile.name,status:status});''')

P("B4 scan button on expenses",
r'''  el.innerHTML='<h2 class="vt">💸 '+t('expenses')+'</h2><div class="vsub">'+state.expenses.length+(canEdit?'<span class="spacer"></span><button class="btn" onclick="newExpense()">'+t('newItem')+'</button>':'')+'</div>'+''',
r'''  el.innerHTML='<h2 class="vt">💸 '+t('expenses')+'</h2><div class="vsub">'+state.expenses.length+(canEdit?'<span class="spacer"></span><button class="btn ghost sm" onclick="openExpenseScanner()">📷 Scan bill</button> <button class="btn" onclick="newExpense()">'+t('newItem')+'</button>':'')+'</div>'+''')

P("B5 bill-copy link in expense row",
r"""'</td><td class="tright mono">'+money(e.amount)+'</td><td class="tright" style="white-space:nowrap">'+(isManagerRole()""",
r"""'</td><td class="tright mono">'+money(e.amount)+'</td><td class="tright" style="white-space:nowrap">'+(e.bill_path?'<button class="btn ghost sm" title="Bill copy" onclick="openBillCopy(\''+esc(e.bill_path)+'\')">📎</button> ':'')+(isManagerRole()""")

P("B6 inject expense scanner module",
r'''function renderExpenses(el){''',
M + r'''function renderExpenses(el){''')

PATCHES = [p for p in PATCHES if not p[0].startswith('A10')]
def main():
    if len(sys.argv) < 2:
        print('usage: python3 apply_all.py <index.html> [-o out.html]')
        return 2
    src = sys.argv[1]
    out = sys.argv[sys.argv.index('-o')+1] if '-o' in sys.argv else src
    try:
        html = io.open(src, encoding='utf-8').read()
    except Exception as e:
        print('  cannot read %s: %s' % (src, e)); return 2

    n0 = len(html); applied = skipped = failed = 0
    for name, before, after in PATCHES:
        if after and after in html:
            print('  =  %-42s already applied' % name); skipped += 1; continue
        if before not in html:
            print('  !  %-42s ANCHOR NOT FOUND' % name); failed += 1; continue
        html = html.replace(before, after, 1); applied += 1
        print('  +  %-42s patched' % name)

    print('\n  applied %d | skipped %d | failed %d' % (applied, skipped, failed))
    if failed:
        print('  ABORTED - nothing written. Your file is untouched.')
        return 1

    io.open(out, 'w', encoding='utf-8').write(html)
    print('  wrote %s (%d bytes, %+d)' % (out, len(html), len(html) - n0))
    print('  version badge still says v28 - bump #version to v28.2 if you want it reflected.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
