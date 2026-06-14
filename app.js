pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);

let QUEUE=[];          // [{id, src, file, pwd, status, txns, label}]
let CONSOLIDATED=[];   // merged rows for tab 1
let qid=0;

/* ---------- Upload queue ---------- */
const drop=$('#drop'), fileInput=$('#file');
drop.onclick=()=>fileInput.click();
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',ev=>{ev.preventDefault();addFiles(ev.dataTransfer.files)});
fileInput.onchange=()=>{addFiles(fileInput.files);fileInput.value='';};

function addFiles(list){
  const src=$('#srcSel').value;
  const pwd=$('#pwd').value;
  Array.from(list).forEach(f=>{
    if(f.type!=='application/pdf' && !/\.pdf$/i.test(f.name)) return;
    QUEUE.push({id:++qid, src, file:f, pwd, status:'queued', txns:null, label:''});
  });
  renderQueue();
}
function renderQueue(){
  const q=$('#queue'); q.innerHTML='';
  QUEUE.forEach(item=>{
    const div=document.createElement('div');
    div.className='qitem';
    div.innerHTML=
      '<span class="src">'+srcLabel(item.src)+'</span>'+
      '<span class="nm">'+esc(item.file.name)+'</span>'+
      '<span class="st '+(item.status==='done'?'ok':item.status==='error'?'err':'')+'">'+item.status+'</span>';
    const btn=document.createElement('button');
    btn.className='danger'; btn.textContent='remove';
    btn.onclick=()=>{QUEUE=QUEUE.filter(x=>x.id!==item.id);renderQueue();};
    div.appendChild(btn);
    q.appendChild(div);
  });
  $('#parseAllBtn').disabled = QUEUE.length===0;
}
$('#clearQueueBtn').onclick=()=>{QUEUE=[];renderQueue();$('#uploadMsg').textContent='';};

function srcLabel(s){return {phonepe:'PhonePe',gpay:'GPay',hdfc:'HDFC',axis:'Axis',sbi:'SBI',generic:'Bank'}[s]||s;}

/* ---------- Parse all ---------- */
$('#parseAllBtn').onclick=async()=>{
  $('#uploadMsg').className='msg'; $('#uploadMsg').textContent='Parsing '+QUEUE.length+' file(s)\u2026';
  for(const item of QUEUE){
    try{
      item.status='reading'; renderQueue();
      const rows=await pdfToRows(item.file, item.pwd);
      let parsed;
      if(item.src==='phonepe') parsed=PARSERS.phonepe(rows.map(r=>r.text));
      else if(item.src==='gpay') parsed=PARSERS.gpay(rows);
      else parsed=PARSERS.bank(rows,{bank:item.src});
      // tag each txn with its file id + source
      parsed.forEach(t=>{t._file=item.id; t.source=item.src; t._d=parseTxnDate(t.date);});
      item.txns=parsed;
      item.label=buildLabel(item.src, parsed);
      item.status= parsed.length? 'done' : 'no txns';
    }catch(e){
      item.status='error';
      item.txns=[];
      console.error(e);
    }
    renderQueue();
  }
  buildResults();
  const total=QUEUE.reduce((n,i)=>n+(i.txns?i.txns.length:0),0);
  $('#uploadMsg').className='msg ok';
  $('#uploadMsg').textContent='Parsed '+total+' transactions across '+QUEUE.length+' file(s). See the Consolidated tab and per-file tabs above.';
};

function buildLabel(src, txns){
  const dates=txns.map(t=>t._d).filter(Boolean).sort((a,b)=>a-b);
  if(!dates.length) return srcLabel(src);
  const f=dates[0], l=dates[dates.length-1];
  const fmt=d=>d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
  const range = (f.getTime()===l.getTime())? fmt(f) : fmt(f)+' \u2013 '+fmt(l);
  return srcLabel(src)+' ('+range+')';
}

/* ---------- Consolidation with ref-number merge ---------- */
function normRef(t){
  // best available reference for cross-source matching
  const cand=[t.utr, t.txnId].filter(Boolean).map(x=>String(x).replace(/^0+/,'').trim()).filter(Boolean);
  return cand;
}
function buildResults(){
  const all=[];
  QUEUE.forEach(i=>{ if(i.txns) all.push(...i.txns); });

  // index by reference; merge rows that share any ref AND same amount
  const byRef=new Map();
  const merged=[];
  let linkedCount=0;

  all.forEach(t=>{
    const refs=normRef(t);
    let hit=null;
    for(const r of refs){
      const key=r+'|'+Math.round(t.amount*100);
      if(byRef.has(key)){ hit=byRef.get(key); break; }
    }
    if(hit){
      mergeInto(hit, t);
      if(!hit._linked){hit._linked=true;linkedCount++;}
    }else{
      const row=cloneRow(t);
      merged.push(row);
      refs.forEach(r=>byRef.set(r+'|'+Math.round(t.amount*100), row));
    }
  });

  // sort newest first
  merged.sort((a,b)=>{
    const da=a._d?a._d.getTime():0, db=b._d?b._d.getTime():0;
    return db-da;
  });
  CONSOLIDATED=merged;
  renderTabs();
  renderConsolidated();
}

function cloneRow(t){
  return {
    sources:[t.source], _files:[t._file], _linked:false, _d:t._d,
    date:t.date, time:t.time||'', party:t.party||'', direction:t.direction||'',
    type:t.type||'', note:t.note||'', paidBy:t.paidBy||'',
    txnId:t.txnId||'', utr:t.utr||'', amount:t.amount||0,
    balance:(t.balance!=null?t.balance:''),
    extra:{}  // source-specific extras keyed by "source.field"
  };
}
function mergeInto(row, t){
  if(!row.sources.includes(t.source)) row.sources.push(t.source);
  if(!row._files.includes(t._file)) row._files.push(t._file);
  // fill blanks from the new source; if both present and differ, stash in extra
  const fields=['time','party','direction','type','note','paidBy','txnId','utr','balance'];
  fields.forEach(f=>{
    const cur=row[f], inc=t[f];
    if((cur===''||cur==null||cur===0) && inc!=null && inc!=='') row[f]=inc;
    else if(inc!=null && inc!=='' && String(cur)!==String(inc)){
      row.extra[t.source+'.'+f]=inc;  // keep the differing value as an extra column
    }
  });
  if((row.balance===''||row.balance==null) && t.balance!=null) row.balance=t.balance;
}

/* ---------- Tabs ---------- */
function renderTabs(){
  // remove old result tabs
  $$('#tabBar .tab').forEach(t=>{ if(t.dataset.tab!=='upload') t.remove(); });
  $('#fileViews').innerHTML='';

  // consolidated tab
  addTab('all','Consolidated');
  $('#view-all').style.display='none';

  // per-file tabs
  QUEUE.forEach(item=>{
    if(!item.txns || !item.txns.length) return;
    const id='file-'+item.id;
    addTab(id, item.label);
    const view=document.createElement('div');
    view.id='view-'+id; view.style.display='none';
    view.innerHTML='<div class="card"><div class="scroll"><table><thead>'+fileHead()+'</thead><tbody></tbody></table></div></div>';
    $('#fileViews').appendChild(view);
    fillFileTable(view.querySelector('tbody'), item.txns);
  });

  // populate source filter
  const sf=$('#srcFilter'); sf.innerHTML='<option value="">All sources</option>';
  [...new Set(CONSOLIDATED.flatMap(r=>r.sources))].forEach(s=>{
    const o=document.createElement('option'); o.value=s; o.textContent=srcLabel(s); sf.appendChild(o);
  });
}
function addTab(tab,label){
  const el=document.createElement('div');
  el.className='tab'; el.dataset.tab=tab; el.textContent=label;
  el.onclick=()=>switchTab(tab);
  $('#tabBar').appendChild(el);
}
function switchTab(tab){
  $$('#tabBar .tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab));
  $('#view-upload').style.display = tab==='upload'?'block':'none';
  $('#view-all').style.display = tab==='all'?'block':'none';
  $$('#fileViews > div').forEach(v=>v.style.display='none');
  if(tab.startsWith('file-')){ const v=$('#view-'+tab); if(v)v.style.display='block'; }
}
$$('#tabBar .tab')[0].onclick=()=>switchTab('upload');

/* ---------- Render consolidated ---------- */
function consolidatedColumns(){
  const base=['Sources','Date','Time','Party','Type','Note','Paid By / Account','Txn ID','UTR / Ref','Amount','Balance'];
  const extraKeys=[...new Set(CONSOLIDATED.flatMap(r=>Object.keys(r.extra)))].sort();
  return {base, extraKeys};
}
function renderConsolidated(){
  const {base,extraKeys}=consolidatedColumns();
  $('#allHead').innerHTML='<tr>'+base.map(h=>'<th class="'+(h==='Amount'||h==='Balance'?'amt':'')+'">'+h+'</th>').join('')+
    extraKeys.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';

  const q=($('#search').value||'').toLowerCase();
  const sf=$('#srcFilter').value, tf=$('#typeFilter').value;
  const tb=$('#allBody'); tb.innerHTML='';
  let d=0,c=0,linked=0;
  CONSOLIDATED.forEach((r,idx)=>{
    if(sf && !r.sources.includes(sf)) return;
    if(tf && r.type!==tf) return;
    if(q){
      const hay=(r.party+' '+r.note+' '+r.txnId+' '+r.utr+' '+r.paidBy).toLowerCase();
      if(!hay.includes(q)) return;
    }
    if(r.type==='CREDIT')c+=r.amount; else if(r.type==='DEBIT')d+=r.amount;
    if(r._linked)linked++;
    const srcBadges=r.sources.map(s=>'<span class="badge">'+srcLabel(s)+'</span>').join(' ')+(r._linked?' <span class="badge link">linked</span>':'');
    let row='<tr>'+
      '<td>'+srcBadges+'</td>'+
      '<td>'+esc(r.date)+'</td><td>'+esc(r.time)+'</td>'+
      '<td>'+esc(r.party)+'</td>'+
      '<td class="'+(r.type==='CREDIT'?'credit':'debit')+'">'+esc(r.type)+'</td>'+
      '<td contenteditable data-i="'+idx+'" class="noteCell">'+esc(r.note)+'</td>'+
      '<td>'+esc(r.paidBy)+'</td>'+
      '<td>'+esc(r.txnId)+'</td><td>'+esc(r.utr)+'</td>'+
      '<td class="amt '+(r.type==='CREDIT'?'credit':'debit')+'">'+money(r.amount)+'</td>'+
      '<td class="amt">'+(r.balance!==''&&r.balance!=null?money(r.balance):'')+'</td>'+
      extraKeys.map(k=>'<td>'+esc(r.extra[k]!=null?r.extra[k]:'')+'</td>').join('')+
      '</tr>';
    tb.insertAdjacentHTML('beforeend',row);
  });
  tb.querySelectorAll('.noteCell').forEach(cell=>{
    cell.addEventListener('input',()=>{CONSOLIDATED[+cell.dataset.i].note=cell.textContent.trim();});
  });
  $('#sCount').textContent=CONSOLIDATED.length;
  $('#sDebit').textContent=money(d);
  $('#sCredit').textContent=money(c);
  $('#sLinked').textContent=linked;
}
['#search','#srcFilter','#typeFilter'].forEach(s=>$(s).addEventListener('input',renderConsolidated));

/* ---------- Per-file tables ---------- */
function fileHead(){
  return '<tr><th>Date</th><th>Time</th><th>Party</th><th>Type</th><th>Note</th><th>Paid By / VPA</th><th>Txn ID</th><th>UTR / Ref</th><th class="amt">Amount</th><th class="amt">Balance</th></tr>';
}
function fillFileTable(tb, txns){
  txns.slice().sort((a,b)=>{const da=a._d?a._d:0,db=b._d?b._d:0;return db-da;}).forEach(t=>{
    tb.insertAdjacentHTML('beforeend','<tr>'+
      '<td>'+esc(t.date)+'</td><td>'+esc(t.time||'')+'</td>'+
      '<td>'+esc(t.party)+'</td>'+
      '<td class="'+(t.type==='CREDIT'?'credit':'debit')+'">'+esc(t.type)+'</td>'+
      '<td>'+esc(t.note||'')+'</td>'+
      '<td>'+esc(t.paidBy||'')+'</td>'+
      '<td>'+esc(t.txnId||'')+'</td><td>'+esc(t.utr||'')+'</td>'+
      '<td class="amt '+(t.type==='CREDIT'?'credit':'debit')+'">'+money(t.amount)+'</td>'+
      '<td class="amt">'+(t.balance!=null&&t.balance!==''?money(t.balance):'')+'</td>'+
      '</tr>');
  });
}

/* ---------- helpers ---------- */
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const money=v=>'\u20b9'+(Number(v)||0).toLocaleString('en-IN',{minimumFractionDigits:2});

/* ---------- PDF -> positioned rows ---------- */
async function pdfToRows(file, password){
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:buf,password:password||undefined}).promise;
  let rows=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const tc=await page.getTextContent();
    const byY={};
    for(const it of tc.items){
      if(!it.str || !it.str.trim()) continue;
      const y=Math.round(it.transform[5]); const x=it.transform[4];
      (byY[y]=byY[y]||[]).push({x,str:it.str});
    }
    const pageRows=Object.keys(byY).sort((a,b)=>b-a).map(y=>{
      const items=byY[y].sort((a,b)=>a.x-b.x);
      return {y:+y, items, text:items.map(o=>o.str).join(' ').replace(/\s+/g,' ').trim()};
    }).filter(r=>r.text);
    rows=rows.concat(pageRows);
  }
  return rows;
}

/* ---------- Export ---------- */
function consolidatedAOA(){
  const {base,extraKeys}=consolidatedColumns();
  const head=['Sources',...base.slice(1),...extraKeys];
  const body=CONSOLIDATED.map(r=>[
    r.sources.map(srcLabel).join('+')+(r._linked?' (linked)':''),
    r.date,r.time,r.party,r.type,r.note,r.paidBy,r.txnId,r.utr,r.amount,r.balance,
    ...extraKeys.map(k=>r.extra[k]!=null?r.extra[k]:'')
  ]);
  return [head,...body];
}
$('#csvBtn').onclick=()=>{
  const aoa=consolidatedAOA();
  const csv=aoa.map(row=>row.map(c=>{const s=String(c==null?'':c);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n');
  dl(new Blob([csv],{type:'text/csv'}),'consolidated.csv');
};
$('#xlsxBtn').onclick=()=>{
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(consolidatedAOA()), 'Consolidated');
  QUEUE.forEach(item=>{
    if(!item.txns||!item.txns.length) return;
    const head=['Date','Time','Party','Direction','Type','Note','Paid By / VPA','Txn ID','UTR / Ref','Amount','Balance'];
    const body=item.txns.map(t=>[t.date,t.time||'',t.party,t.direction||'',t.type,t.note||'',t.paidBy||'',t.txnId||'',t.utr||'',t.amount,t.balance!=null?t.balance:'']);
    const name=(item.label||srcLabel(item.src)).replace(/[\\\/?*\[\]:]/g,' ').slice(0,31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head,...body]), name);
  });
  XLSX.writeFile(wb,'transactions.xlsx');
};
$('#copyBtn').onclick=async()=>{
  const aoa=consolidatedAOA();
  await navigator.clipboard.writeText(aoa.map(r=>r.join('\t')).join('\n'));
  $('#msg2').className='msg ok'; $('#msg2').textContent='Consolidated sheet copied. Paste into Google Sheets with Ctrl/Cmd+V.';
};
function dl(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();}

/* ---------- PWA ---------- */
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('#installBtn').style.display='inline-block';});
$('#installBtn').onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('#installBtn').style.display='none';};
if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));}
