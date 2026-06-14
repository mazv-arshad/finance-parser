/* ===== Transaction parsers ===== */
/* Each parser takes an array of {page, lines:[{x,y,str}...]} and returns
   normalized txns: {source,date,time,party,direction,type,note,paidBy,txnId,utr,amount} */

const PARSERS = {};

/* ---- PhonePe ----
   Layout (from real statement):
     Line: "May 24, 2026 Paid to kailasam DEBIT 25"   (date + party + type + amount on one visual row)
     Line: "11:14 PM Transaction ID T2605242314558648824283"
     Line: "UTR No. 410635030966"
     Line: "Paid by [icon] XXXXXX1489"
   We anchor on a date line, then read the following ~4 lines as one block.
*/
PARSERS.phonepe = function(lines){
  const out=[];
  const dateRe=/([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/;
  const timeRe=/\b(\d{1,2}:\d{2}\s?(?:AM|PM|am|pm))\b/;
  const amtRe=/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/;
  const partyRe=/(Paid to|Received from|Paid by)\s+(.+?)(?=\s+(?:DEBIT|CREDIT)\b|$)/i;
  const txnIdRe=/Transaction ID\s*([A-Za-z0-9]+)/i;
  const utrRe=/UTR No\.?\s*([0-9]+)/i;
  const paidByRe=/Paid by\s*(?:[^\w]*)?(X{2,}\d+|\d{3,})/i;

  for(let i=0;i<lines.length;i++){
    const L=lines[i];
    const dm=L.match(dateRe);
    if(!dm)continue;
    // direction + party + type + amount usually on this same line
    const dir=/Received from/i.test(L)?'Received from':/Paid to/i.test(L)?'Paid to':'';
    const type=/CREDIT/i.test(L)?'CREDIT':/DEBIT/i.test(L)?'DEBIT':'';
    // window of following lines
    const win=[L,lines[i+1]||'',lines[i+2]||'',lines[i+3]||'',lines[i+4]||''];
    const winStr=win.join(' \u23AF ');

    // party name: text between "Paid to"/"Received from" and the type/amount
    let party='';
    const pm=L.match(/(?:Paid to|Received from)\s+(.+?)(?=\s+(?:DEBIT|CREDIT)\b|\s+(?:₹|Rs|INR)|$)/i);
    if(pm)party=pm[1].trim();

    const am=(winStr.match(amtRe)||[,''])[1];
    if(!am && !type) continue; // not a real txn block

    const time=(winStr.match(timeRe)||[,''])[1]||'';
    const txnId=(winStr.match(txnIdRe)||[,''])[1]||'';
    const utr=(winStr.match(utrRe)||[,''])[1]||'';
    const paidBy=(winStr.match(paidByRe)||[,''])[1]||'';

    out.push({
      source:'phonepe',
      date:dm[1],
      time,
      party:party||'\u2014',
      direction:dir||(type==='CREDIT'?'Received from':'Paid to'),
      type:type||(dir==='Received from'?'CREDIT':'DEBIT'),
      note:'',
      paidBy,
      txnId,
      utr,
      amount:parseFloat((am||'').replace(/,/g,''))||0
    });
    i+=3;
  }
  return dedupe(out);
};

/* ---- Bank statement parser (HDFC columnar layout + generic UPI fallback) ----
   HDFC columns: Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt | Deposit Amt | Closing Balance
   A single transaction's narration wraps across several physical PDF lines; only the
   first line carries the Date + amounts. We stitch wrapped narration lines together,
   then decompose the narration string.

   IMPORTANT: this parser expects POSITIONED rows: an array of
     { y, items:[{x,str}], text }   (text = items joined left-to-right)
   so we can tell Withdrawal vs Deposit by x-position. app.js passes this in when
   source === 'bank'. If it instead receives plain strings, it falls back to text mode.
*/
PARSERS.bank = function(rows, opts){
  opts = opts || {};
  const bank = opts.bank || 'generic';
  // Normalize: accept either positioned rows or plain strings
  const positioned = rows.length && typeof rows[0]==='object' && rows[0].items;
  if(!positioned){
    return genericUpiText(rows);
  }
  return parseColumnar(rows, opts);
};

function num(s){ return parseFloat(String(s).replace(/,/g,'')) || 0; }

function parseColumnar(rows, opts){
  const out=[];
  const bank=(opts&&opts.bank)||'generic';
  const dateRe=/^(\d{2}[\/-]\d{2}[\/-]\d{2,4})$/;
  const amtRe=/^[\d,]+\.\d{2}$/;

  // Determine column x-boundaries from the header row.
  // HDFC: Withdrawal / Deposit / Closing Balance.  Axis: Debit / Credit / Balance.
  let colDebit=null, colCredit=null, colBalance=null;
  for(const r of rows){
    const t=r.text.toLowerCase();
    const isHdr=(t.includes('withdrawal')&&t.includes('deposit'))||(t.includes('debit')&&t.includes('credit')&&t.includes('balance'));
    if(isHdr){
      r.items.forEach(it=>{
        const s=it.str.toLowerCase();
        if(s.includes('withdrawal')||s==='debit'||s.includes('debit')) colDebit=it.x;
        else if(s.includes('deposit')||s==='credit'||s.includes('credit')) colCredit=it.x;
        else if(s.includes('closing')||s.includes('balance')) colBalance=it.x;
      });
      break;
    }
  }

  // For Axis & SBI, the ref number lives INSIDE the narration text, so we must not strip
  // long-digit tokens. For HDFC, the Chq./Ref.No. is a separate column.
  const refInNarration = (bank==='axis' || bank==='sbi');

  let cur=null;
  const flush=()=>{ if(cur) out.push(finishTxn(cur, bank)); cur=null; };

  for(const r of rows){
    const first=r.items[0];
    const startsWithDate = first && dateRe.test(first.str.trim());
    const headerish=/particulars|narration|closing balance|statement of|page no|opening balance|value date|post date/i.test(r.text);
    if(headerish && !startsWithDate) {
      continue;
    }

    if(startsWithDate){
      flush();
      cur={date:first.str.trim(), narrParts:[], withdraw:0, deposit:0, balance:0, ref:''};
      let seenDate=false;
      r.items.forEach(it=>{
        const s=it.str.trim();
        if(amtRe.test(s)){
          const v=num(s);
          const dDeb=colDebit!=null?Math.abs(it.x-colDebit):1e9;
          const dCre=colCredit!=null?Math.abs(it.x-colCredit):1e9;
          const dBal=colBalance!=null?Math.abs(it.x-colBalance):1e9;
          const m=Math.min(dDeb,dCre,dBal);
          if(m===dBal) cur.balance=v;
          else if(m===dCre) cur.deposit=v;
          else cur.withdraw=v;
        } else if(!refInNarration && /^\d{6,}$/.test(s) && !cur.ref){
          cur.ref=s;
        }
      });
      const narr=r.items.filter(it=>{
        const s=it.str.trim();
        if(s===cur.date) return false;
        if(dateRe.test(s)) return false;          // drop second date (SBI Post Date)
        if(s==='-' || s==='\u2014') return false; // drop dash placeholders
        if(amtRe.test(s)) return false;
        if(!refInNarration && /^\d{6,}$/.test(s)) return false;
        if(/^\d{2,4}$/.test(s)) return false;
        return true;
      }).map(it=>it.str).join(' ');
      if(narr.trim()) cur.narrParts.push(narr.trim());
    } else if(cur){
      const narr=r.items.filter(it=>{
        const s=it.str.trim();
        if(s==='-' || s==='\u2014') return false;
        if(amtRe.test(s)) return false;
        if(!refInNarration && /^\d{6,}$/.test(s)) return false;
        if(/^\d{2,4}$/.test(s)) return false;
        return true;
      }).map(it=>it.str).join(' ');
      if(narr.trim()) cur.narrParts.push(narr.trim());
    }
  }
  flush();
  return dedupe(out);
}

function finishTxn(c, bank){
  const narration=c.narrParts.join(' ').replace(/\s+/g,' ').trim();
  const d=parseBankNarration(narration, bank);
  // Type: narration-derived (SBI DEP/WDL) wins; else column position (deposit>0 => credit)
  let type;
  if(d._type) type=d._type;
  else type = c.deposit>0 ? 'CREDIT' : 'DEBIT';
  const amount = (type==='CREDIT') ? (c.deposit||c.withdraw) : (c.withdraw||c.deposit);
  return {
    source:'bank',
    date:c.date,
    time:'',
    party:d.party||'\u2014',
    direction: type==='CREDIT'?'Received from':'Paid to',
    type,
    note:d.note||'',
    paidBy:d.vpa||d.bank||'',
    txnId:'',
    utr:c.ref||d.ref||'',
    amount,
    balance:c.balance,
    narration
  };
}

/* Decompose a bank narration string. Dispatches by bank format. */
function parseBankNarration(narrRaw, bank){
  let narr=(narrRaw||'').replace(/\s+/g,' ').trim();

  // SBI: "<DEP|WDL> TFR UPI/CR|DR/<ref>/<name>/<bankcode>/<vpaprefix>/Paym <n> AT <branch>"
  if(bank==='sbi' || /^(DEP|WDL)\s+TFR\b/i.test(narr)){
    const kind = /^DEP/i.test(narr)?'CREDIT':/^WDL/i.test(narr)?'DEBIT':'';
    let body=narr.replace(/^(DEP|WDL)\s+TFR\s+/i,'');
    if(/^UPI\//i.test(body)){
      const segs=body.split('/');
      const drcr=(segs[1]||'').toUpperCase();
      const ref=(segs[2]||'').trim();
      const name=(segs[3]||'').replace(/\s+/g,' ').trim();
      const vpaprefix=(segs[5]||'').trim();
      const tail=segs.slice(6).join('/').trim();
      const branch=(tail.match(/AT\s+\d*\s*(.+)$/i)||[,''])[1].trim();
      return {party:name||'\u2014', vpa:vpaprefix, ref, branch, note:'', _type:kind||(drcr==='CR'?'CREDIT':'DEBIT')};
    }
    return {party:body.slice(0,50), vpa:'', ref:'', note:'', _type:kind};
  }

  // Axis: slash-delimited  UPI/P2M|P2A/<ref>/<name>/<descriptor>/<bank>
  if(bank==='axis' || /^UPI\/P2[MA]\//i.test(narr)){
    if(/^UPI\//i.test(narr)){
      const segs=narr.split('/');
      const ref=(segs[2]||'').match(/\d{6,}/)?segs[2].trim():'';
      const name=(segs[3]||'').trim();
      const counterBank=segs.slice(4).join('/').replace(/\/+$/,'').trim();
      return {party:name||'\u2014', vpa:'', ref, bank:counterBank, note:''};
    }
    if(/^SB:/i.test(narr) || /Int\.Pd/i.test(narr)) return {party:'Interest / Bank', vpa:'', ref:'', bank:'', note:''};
    return {party:narr.slice(0,50), vpa:'', ref:'', bank:'', note:''};
  }

  // HDFC / generic: POS + hyphen-delimited UPI
  if(/^POS\b/i.test(narr)){
    const m=narr.match(/^POS\s+(\S+)\s+(\d+)\s+(\d{2}[A-Z]{3}\d{2})\s+(\d{1,2}:\d{2}:\d{2})\s+(.+)$/i);
    if(m) return {party:m[5].trim(), vpa:'', ref:m[2], note:''};
    let t=narr.replace(/^POS\s+\S+\s+\d+\s+/i,'');
    t=t.replace(/^\d{2}[A-Z]{3}\d?\s*\d?\s*\d{1,2}:\d{2}:\d{2}\s+/i,'');
    t=t.replace(/^\d{1,2}:\d{2}:\d{2}\s+/,'');
    return {party:t.trim()||narr, vpa:'', ref:'', note:''};
  }
  if(/^UPI-/i.test(narr)){
    const body=narr.replace(/^UPI-/i,'');
    const segs=body.split('-').map(s=>s.replace(/\s+/g,' ').trim());
    const vpaIdx=segs.findIndex(s=>s.includes('@'));
    let party='',vpa='',ref='';
    if(vpaIdx>=0){
      party=segs.slice(0,vpaIdx).join('-').replace(/\s+/g,' ').trim();
      vpa=segs[vpaIdx].replace(/\s+/g,'').replace(/(@[A-Za-z0-9.]+).*/,'$1');
      const after=segs.slice(vpaIdx+1).join('-');
      ref=(after.match(/(\d{9,})/)||[,''])[1];
    }else{
      party=segs[0]; ref=(body.match(/(\d{9,})/)||[,''])[1];
    }
    return {party, vpa, ref, note:''};
  }
  if(/^SB:/i.test(narr) || /Int\.Pd/i.test(narr)) return {party:'Interest / Bank', vpa:'', ref:'', note:''};
  return {party:narr.slice(0,50), vpa:'', ref:'', note:''};
}

/* Generic NPCI-format fallback when only plain text lines are available */
function genericUpiText(lines){
  const out=[];
  const dateRe=/\b(\d{2}[-\/]\d{2}[-\/]\d{2,4})\b/;
  const amtRe=/([\d,]+\.\d{2})/g;
  const upiRe=/UPI[\/-](DR|CR|D|C)[\/-]([0-9]+)[\/-]([^\/]+)(?:[\/-]([^\/]+))?(?:[\/-](.+))?/i;
  for(const L of lines){
    const um=L.match(upiRe); if(!um) continue;
    const type=/^C/i.test(um[1])?'CREDIT':'DEBIT';
    const amts=L.match(amtRe)||[];
    out.push({source:'bank',date:(L.match(dateRe)||[,''])[1],time:'',
      party:(um[3]||'').trim()||'\u2014',direction:type==='CREDIT'?'Received from':'Paid to',
      type,note:(um[5]||'').trim(),paidBy:'',txnId:'',utr:um[2]||'',
      amount:amts.length?num(amts[amts.length-1]):0});
  }
  return dedupe(out);
}

/* ---- GPay parser ----
   Layout (per block):
     "04 Mar, 2026 Received from MOHAMMED SHAHID ₹1,500"
     "12:38 PM UPI Transaction ID: 784855201678"
     "Paid to State Bank of India 9610"     <- YOUR account (credit) / "Paid by ..." (debit)
   Direction from the party line's "Received from"/"Paid to"; the second
   "Paid to/by <Bank> <digits>" line is your own account, not the counterparty.
*/
PARSERS.gpay = function(rows){
  const lines = (rows.length && typeof rows[0]==='object' && rows[0].text!=null) ? rows.map(r=>r.text) : rows;
  const out=[];
  const dateRe=/(\d{1,2}\s+[A-Z][a-z]{2},?\s+\d{4})/;
  const timeRe=/\b(\d{1,2}:\d{2}\s?(?:AM|PM|am|pm))\b/;
  const amtRe=/(?:\u20b9|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/;
  const idRe=/UPI Transaction ID:?\s*([0-9]+)/i;
  const bankWords=/bank|india|hdfc|axis|sbi|kotak|icici|union|canara|baroda|paytm|yes\b/i;

  const anchors=[];
  for(let i=0;i<lines.length;i++) if(dateRe.test(lines[i])) anchors.push(i);

  for(let a=0;a<anchors.length;a++){
    const start=anchors[a];
    const end=(a+1<anchors.length)?anchors[a+1]:lines.length;
    const win=lines.slice(start,end);
    const winStr=win.join(' \u23AF ');
    const dm=lines[start].match(dateRe);

    let party='',direction='',type='';
    for(const seg of win){
      const m=seg.match(/(Received from|Paid to)\s+(.+)$/i);
      if(m){
        let cand=m[2].trim();
        if(/\d{3,4}\s*$/.test(cand) && bankWords.test(cand)) continue; // that's the account line
        cand=cand.replace(amtRe,'').replace(/UPI Transaction.*/i,'').replace(/\s+/g,' ').trim();
        party=cand;
        direction=/Received from/i.test(m[1])?'Received from':'Paid to';
        type=/Received from/i.test(m[1])?'CREDIT':'DEBIT';
        break;
      }
    }
    if(!direction) continue;

    const time=(winStr.match(timeRe)||[,''])[1]||'';
    const txnId=(winStr.match(idRe)||[,''])[1]||'';
    const amt=(winStr.match(amtRe)||[,''])[1]||'';
    let account='';
    for(const seg of win){
      const am=seg.match(/Paid (?:by|to)\s+(.+?\d{3,4})\s*$/i);
      if(am){ account=am[1].trim(); break; }
    }
    out.push({source:'gpay',date:dm[1],time,party:party||'\u2014',direction,type,
      note:'',paidBy:account,txnId,utr:'',amount:parseFloat((amt||'').replace(/,/g,''))||0});
  }
  return dedupe(out);
};

function dedupe(arr){
  const seen=new Set();
  return arr.filter(t=>{
    const k=(t.txnId||(t.date+t.time+t.party))+'|'+t.amount;
    if(seen.has(k))return false;seen.add(k);return true;
  });
}

/* ===== Shared date helper: normalize the various source date formats to a JS Date ===== */
function parseTxnDate(s){
  if(!s) return null;
  s=String(s).trim();
  const months={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  let m;
  // "May 24, 2026"  /  "24 Mar, 2026" / "04 Mar 2026"
  if(m=s.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/)) return new Date(+m[3],months[m[1].toLowerCase()],+m[2]);
  if(m=s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})$/)) return new Date(+m[3],months[m[2].toLowerCase()],+m[1]);
  // "01/05/26" or "01/05/2026" or "19-04-2026" (dd/mm/yy[yy])
  if(m=s.match(/^(\d{2})[\/-](\d{2})[\/-](\d{2,4})$/)){
    let y=+m[3]; if(y<100) y+=2000;
    return new Date(y,+m[2]-1,+m[1]);
  }
  const d=new Date(s); return isNaN(d)?null:d;
}
