// The CRM page. One string, no build step — see serve.ts for why.
//
// ═══ IT IS THE PRODUCT'S DESIGN SYSTEM, NOT A NEW ONE ═══
//
// Tokens below are lifted verbatim from growth/app/globals.css (which lifted them from cloud), both
// themes. Its rules, which this page follows: surfaces STEP rather than casting shadows; the accent
// is on primary actions and the active row and nowhere else; radius is 4px; every number is mono +
// tabular so columns do not jitter as they update.
//
// ═══ WHY A ROW DOES NOT DISAPPEAR WHEN YOU MARK IT ═══
//
// The first version filtered on `queued`, so pressing "sent" moved the person out of the view and
// the row vanished. Nothing was broken — the founder's reading was "I can't change status of lead,
// why?", which is the correct reading of a control that removes the thing you just acted on.
//
// So a row that has just been marked STAYS until the next filter change, flagged `just`. You see
// the status you set, on the row you set it on, and the count in the tab updates behind it.
export const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>rally</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{
  --background:oklch(0.992 0.001 250); --foreground:oklch(0.19 0.006 255);
  --surface-1:oklch(1 0 0); --surface-2:oklch(0.972 0.002 250); --surface-3:oklch(0.945 0.003 250);
  --primary:oklch(0.5 0.13 156); --primary-foreground:oklch(0.99 0 0); --primary-soft:oklch(0.955 0.03 156);
  --fg-muted:oklch(0.505 0.008 255); --fg-subtle:oklch(0.56 0.006 255);
  --destructive:oklch(0.55 0.21 25); --success:oklch(0.55 0.11 155);
  --warning:oklch(0.52 0.14 70); --info:oklch(0.56 0.12 240);
  --border:oklch(0.912 0.002 250); --border-strong:oklch(0.84 0.004 250);
  --sidebar:oklch(0.976 0.002 250);
  --radius:4px;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,monospace;
}
.dark{
  --background:oklch(0.148 0.004 255); --foreground:oklch(0.97 0.002 250);
  --surface-1:oklch(0.178 0.005 255); --surface-2:oklch(0.208 0.005 255); --surface-3:oklch(0.248 0.006 255);
  --primary:oklch(0.74 0.15 156); --primary-foreground:oklch(0.16 0.03 156); --primary-soft:oklch(0.255 0.045 157);
  --fg-muted:oklch(0.675 0.006 252); --fg-subtle:oklch(0.6 0.005 252);
  --destructive:oklch(0.68 0.19 24); --success:oklch(0.7 0.1 155);
  --warning:oklch(0.78 0.13 72); --info:oklch(0.7 0.11 238);
  --border:oklch(0.298 0.005 255); --border-strong:oklch(0.4 0.007 255);
  --sidebar:oklch(0.118 0.004 255);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--background);color:var(--foreground);font:13px/1.45 var(--sans);
  -webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button,select{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.app{display:grid;grid-template-columns:210px 1fr;height:100vh}

/* rail */
.rail{background:var(--sidebar);border-right:1px solid var(--border);padding:14px 10px;overflow-y:auto}
.mark{font-family:var(--mono);font-size:12px;letter-spacing:.14em;color:var(--primary);padding:0 6px 4px;text-transform:uppercase}
.sublede{padding:0 6px 12px;font-size:11px;color:var(--fg-subtle)}
.rl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--fg-subtle);padding:12px 6px 5px}
.sitem{display:block;width:100%;text-align:left;padding:6px 8px;border-radius:var(--radius);color:var(--fg-muted)}
.sitem:hover{background:var(--surface-2);color:var(--foreground)}
.sitem.on{background:var(--primary-soft);color:var(--foreground)}
.sitem .r1{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.sitem .nm{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sitem .r2{font-size:11px;color:var(--fg-subtle);margin-top:1px}
.mini{height:2px;background:var(--surface-3);border-radius:1px;margin-top:5px;overflow:hidden}
.mini i{display:block;height:100%;background:var(--primary)}
.goal{padding:8px;border:1px solid var(--border);border-radius:var(--radius);margin:4px 2px;background:var(--surface-1)}
.goal .big{font-family:var(--mono);font-size:20px;font-weight:600}
.goal .lbl{font-size:11px;color:var(--fg-muted);line-height:1.35;margin-top:2px}

/* header */
.main{display:flex;flex-direction:column;min-width:0;overflow:hidden}
.hd{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border);background:var(--surface-1)}
.h1{font-size:13px;font-weight:600}
.pill{font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;
  border-radius:var(--radius);border:1px solid var(--border-strong);color:var(--fg-muted)}
.pill.launch{color:var(--warning);border-color:var(--warning)}
.pill.over{color:var(--destructive);border-color:var(--destructive)}
.spacer{margin-left:auto}
.icon{padding:4px 8px;border-radius:var(--radius);color:var(--fg-muted);border:1px solid var(--border)}
.icon:hover{background:var(--surface-2);color:var(--foreground)}

/* stats */
.stats{display:flex;border-bottom:1px solid var(--border);background:var(--surface-1);overflow-x:auto}
.stat{padding:9px 14px;border-right:1px solid var(--border);min-width:118px}
.stat .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:17px;font-weight:600;letter-spacing:-.02em}
.stat .k{font-size:10.5px;color:var(--fg-subtle);margin-top:1px;line-height:1.3}
.stat .v.g{color:var(--success)} .stat .v.w{color:var(--warning)} .stat .v.d{color:var(--destructive)}
.stat.note{border-right:0;color:var(--fg-muted);display:flex;align-items:center;font-size:12px;max-width:560px}

/* toolbar */
.tb{display:flex;align-items:center;gap:5px;padding:7px 16px;border-bottom:1px solid var(--border);
  background:var(--surface-1);flex-wrap:wrap}
.tab{padding:4px 10px;border-radius:var(--radius);color:var(--fg-muted);font-size:12px;font-weight:520;border:1px solid transparent}
.tab:hover{background:var(--surface-2);color:var(--foreground)}
.tab.on{background:var(--surface-3);color:var(--foreground);border-color:var(--border-strong)}
.tab .c{font-family:var(--mono);font-size:11px;color:var(--fg-subtle);margin-left:5px}
input.q{background:var(--background);border:1px solid var(--border);border-radius:var(--radius);
  padding:5px 9px;color:var(--foreground);outline:none;width:240px;font-size:12px}
input.q:focus{border-color:var(--primary)}
.msg{padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface-1);
  color:var(--fg-muted);font-size:12px;display:flex;gap:10px;align-items:baseline}
.msg b{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-subtle);white-space:nowrap}
.msg span{flex:1;min-width:0}

/* table */
.scroll{flex:1;overflow-y:auto}
table{width:100%;border-collapse:collapse}
thead th{position:sticky;top:0;z-index:1;background:var(--surface-2);text-align:left;font-size:10px;
  text-transform:uppercase;letter-spacing:.06em;color:var(--fg-subtle);font-weight:600;padding:6px 10px;
  border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none}
thead th:hover{color:var(--foreground)}
thead th .ar{opacity:.5;font-size:9px}
tbody tr{border-bottom:1px solid var(--border)}
tbody tr:hover{background:var(--surface-2)}
tbody tr.muted{opacity:.5}
tbody tr.just{background:var(--primary-soft)}
tbody tr.cur{box-shadow:inset 3px 0 0 var(--primary)}
.bulk{display:flex;align-items:center;gap:6px;padding:7px 16px;background:var(--primary-soft);
  border-bottom:1px solid var(--border);font-size:12px}
.bulk b{font-size:14px;margin-right:2px}
.note{font-size:11px;color:var(--fg-subtle);line-height:1.4;padding:8px 8px 0;border-top:1px solid var(--border);margin-top:8px}
.num.over{color:var(--warning)}
tr.rampline td{background:var(--surface-2);color:var(--fg-subtle);font-size:11px;text-align:center;
  padding:5px 10px;border-top:1px solid var(--border-strong)}
tbody tr.past{opacity:.62}
.over-bar{padding:7px 16px;background:color-mix(in oklch,var(--warning) 14%,transparent);border-bottom:1px solid var(--border);color:var(--foreground);font-size:12px}
input[type=checkbox]{accent-color:var(--primary);cursor:pointer;margin:0}
.tab.go{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}
.tab.go:hover{opacity:.9;background:var(--primary);color:var(--primary-foreground)}
td{padding:4px 10px;vertical-align:middle;white-space:nowrap}
.who{display:flex;align-items:center;gap:8px;min-width:0}
.av{width:24px;height:24px;border-radius:var(--radius);flex:0 0 24px;object-fit:cover;background:var(--surface-3);
  display:grid;place-items:center;color:var(--fg-subtle);font-size:9.5px;font-weight:700;font-family:var(--mono)}
.nm{font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}
.sub{color:var(--fg-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px}
.why{color:var(--fg-subtle);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.seatc{font-family:var(--mono);font-size:11px;color:var(--fg-muted)}
.lk{color:var(--fg-muted);padding:2px 6px;border-radius:var(--radius);font-size:11px;font-family:var(--mono);
  border:1px solid var(--border)}
.lk:hover{background:var(--surface-3);color:var(--foreground);border-color:var(--border-strong)}
.lk.go{color:var(--primary);border-color:var(--primary)}
.lk.pl{border-color:var(--border-strong);font-family:var(--sans);font-size:11.5px}
.lk.go:hover{background:var(--primary);color:var(--primary-foreground)}
.lk.seatopen{margin-left:4px;font-size:10.5px}
select.st{border:1px solid var(--border);border-radius:var(--radius);padding:3px 6px;font-size:11.5px;
  background:var(--surface-1);color:var(--fg-muted);min-width:104px}
select.st:hover{border-color:var(--border-strong);color:var(--foreground)}
select.st.s-invited{color:var(--info);border-color:var(--info)}
select.st.s-accepted{color:var(--success);border-color:var(--success)}
select.st.s-messaged{color:var(--warning);border-color:var(--warning)}
select.st.s-replied{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}
.empty{padding:56px;text-align:center;color:var(--fg-subtle)}
.foot{padding:7px 16px;border-top:1px solid var(--border);color:var(--fg-subtle);font-size:11.5px;
  background:var(--surface-1);display:flex;gap:14px;align-items:center}
kbd{font-family:var(--mono);font-size:10.5px;background:var(--surface-3);border:1px solid var(--border);
  border-radius:3px;padding:0 4px}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--foreground);
  color:var(--background);padding:7px 14px;border-radius:var(--radius);font-size:12.5px;font-weight:550;
  opacity:0;transition:opacity 160ms;pointer-events:none;z-index:9}
.toast.on{opacity:1}
</style></head><body><div class="app" id="app"></div><div class="toast" id="toast"></div>
<script>
let S=null, seat='all', filter='queued', q='', limit=200, sort='priority', dir=-1;
let cur=0, view=[], batch=10;
const sel=new Set();            // person_keys ticked for a bulk action
let lastTick=-1;                // for shift-click ranges            // cur = keyboard cursor into the visible rows
const just=new Set();                    // marked in this view — kept visible so the click is legible
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const init=n=>(String(n||'?').match(/\p{L}[\p{L}'-]*/gu)||['?']).slice(0,2).map(w=>w[0]).join('').toUpperCase();
const STATES=['queued','supported','invited','accepted','messaged','replied','declined'];
const LABEL={queued:'Not asked',supported:'Commented on theirs',invited:'Invite sent',accepted:'Accepted',messaged:'Messaged',replied:'Replied',
  seen_no_reply:'Went quiet',followed_up:'Followed up',declined:'Skipped',failed:'Failed'};

const theme=localStorage.getItem('rally.theme')||'light';
if(theme==='dark') document.documentElement.classList.add('dark');
function toggleTheme(){const d=document.documentElement.classList.toggle('dark');
  localStorage.setItem('rally.theme',d?'dark':'light');render();}

let toastT;
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('on');
  clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('on'),1600);}

async function load(){ S=await (await fetch('/api/state')).json(); render(); }
/**
 * Open the next N, in the background, each in its seat's browser.
 *
 * This is the unit of work — queue ten tabs, walk them, come back and mark. Doing it one at a
 * time means alternating between two windows six hundred times.
 */
async function openNext(n){
  const items=view.slice(cur,cur+n).map(p=>({link:p.linkedin_url,
    browser:(S.seats.find(s=>s.name===p.seat)||{}).browser||''}));
  if(!items.length){toast('Nothing left in this view');return}
  // Select and say so IMMEDIATELY. The server staggers the tabs by 250ms so macOS does not drop
  // them, which is two and a half seconds for ten — long enough that waiting for it reads as a
  // dead button. The selection is ours to make and does not depend on the OS.
  view.slice(cur,cur+n).forEach(p=>sel.add(p.person_key));
  render();
  toast('Opening '+items.length+' tabs — connect, then mark all '+items.length+' below');
  await fetch('/api/open-batch',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({items})}).catch(()=>toast('Could not open the tabs'));
}

/** Mark and step to the next row, so a run of invitations is one key per person. */
/**
 * Open every selected row in a background tab.
 *
 * "Open next N" takes what is at the top; this takes what you picked. They are different jobs —
 * tick six people across the list, open exactly those six, connect, mark those six. The bulk bar
 * had the marking half and not the opening half, which made selection useful only after the fact.
 */
async function openSel(){
  if(!sel.size) return;
  const items=S.people.filter(p=>sel.has(p.person_key))
    .map(p=>({link:p.linkedin_url,browser:(S.seats.find(s=>s.name===p.seat)||{}).browser||''}));
  // Forty-odd tabs is a lot of browser. Say the number and the time rather than either capping
  // it silently or letting a mis-click open three hundred.
  if(items.length>40 && !confirm('Open '+items.length+' tabs? That is about '+
     Math.ceil(items.length*0.25)+' seconds of opening and a lot of memory.')) return;
  toast('Opening '+items.length+' tabs — they stay selected');
  const r=await (await fetch('/api/open-batch',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({items})})).json().catch(()=>({}));
  if(r&&r.error) toast(r.error);
}

async function markSel(to){
  if(!sel.size) return;
  const keys=[...sel];
  keys.forEach(k=>just.add(k));
  const r=await (await fetch('/api/mark-batch',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({keys,to})})).json();
  S=r.state; sel.clear(); lastTick=-1;
  toast(r.marked+' marked as '+LABEL[to]); render();
}
function tick(i,ev){
  const p=view[i]; if(!p) return;
  if(ev&&ev.shiftKey&&lastTick>=0){
    const [a,b]=[Math.min(lastTick,i),Math.max(lastTick,i)];
    for(let k=a;k<=b;k++) if(view[k]) sel.add(view[k].person_key);
  } else {
    sel.has(p.person_key)?sel.delete(p.person_key):sel.add(p.person_key);
    lastTick=i;
  }
  render();
}
function tickAll(){
  const shown=view.slice(0,limit);
  const all=shown.every(p=>sel.has(p.person_key));
  shown.forEach(p=>all?sel.delete(p.person_key):sel.add(p.person_key));
  render();
}

async function markAt(i,to){
  const p=view[i]; if(!p) return;
  await mark(p.person_key,to,p.seat||'',p.name);
  cur=Math.min(i+1,view.length-1); focusRow();
}
function focusRow(){
  const el=document.querySelector('tbody tr[data-i="'+cur+'"]');
  if(el) el.scrollIntoView({block:'nearest'});
  document.querySelectorAll('tbody tr').forEach(r=>r.classList.toggle('cur',r.dataset.i==String(cur)));
}

document.addEventListener('keydown',e=>{
  if(/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k=e.key;
  if(k==='j'||k==='ArrowDown'){cur=Math.min(cur+1,view.length-1);focusRow();e.preventDefault()}
  else if(k==='k'||k==='ArrowUp'){cur=Math.max(cur-1,0);focusRow();e.preventDefault()}
  else if(k==='o'){const p=view[cur];if(p)openLink(p.linkedin_url,(S.seats.find(s=>s.name===p.seat)||{}).browser||'',p.seat)}
  else if(k==='O'){openNext(batch)}
  else if(k>='1'&&k<='6'){markAt(cur,['supported','invited','accepted','messaged','replied','declined'][+k-1])}
  else if(k==='c'){const p=view[cur];if(p&&p.product_url)window.open(p.product_url,'_blank')}
  else if(k==='x'){tick(cur)}
  else if(k==='a'){view.slice(0,limit).forEach(p=>sel.add(p.person_key));render()}
  else if(k==='Enter'){openSel()}
  else if(k==='Escape'){sel.clear();lastTick=-1;render()}
  else if(k==='/'){const i=document.querySelector('input.q');if(i){i.focus();e.preventDefault()}}
});

async function sync(btn){
  if(btn){btn.textContent='Syncing…';btn.disabled=true}
  const r=await (await fetch('/api/sync',{method:'POST'})).json();
  if(r.error){toast('Sync failed: '+r.error);}
  else{S=r.state;toast(r.imported+' people in the list'+(r.retired?', '+r.retired+' dropped':''));}
  render();
}
async function mark(k,to,st,name){
  just.add(k);                            // survive the filter so the change is visible where it happened
  S=await (await fetch('/api/mark',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({personKey:k,to,seat:st})})).json();
  toast(esc(name)+' → '+LABEL[to]); render();
}
async function openLink(link,browser,seatName){
  const r=await (await fetch('/api/open',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({link,browser})})).json();
  toast(r.ok ? 'Opened in '+browser+(seatName?' — you are '+seatName:'') : (r.error||'Could not open'));
}
function setFilter(f){filter=f;limit=200;just.clear();render()}
function setSort(k){ if(sort===k) dir=-dir; else {sort=k;dir=k==='name'?1:-1;} render(); }

function render(){
  if(!S) return;
  const L=S.launch,P=S.plan,T=S.total;
  const isLive=p=>/launched (today|[1-9]d ago)/.test(p.why||'')&&p.product_url;
  let rows=S.people.filter(p=>(seat==='all'||p.seat===seat)&&
    (filter==='all'||(filter==='launches'?isLive(p):p.state===filter)||just.has(p.person_key))&&
    (!q||(p.name+' '+(p.headline||'')+' '+(p.product||'')).toLowerCase().includes(q)));
  const key=p=>sort==='name'?p.name.toLowerCase():sort==='product'?(p.product||'').toLowerCase():
    sort==='status'?STATES.indexOf(p.state):p.priority;
  rows.sort((a,b)=>{const x=key(a),y=key(b);return x<y?-dir:x>y?dir:0});
  view=rows; if(cur>=view.length) cur=Math.max(0,view.length-1);
  const counts={}; for(const p of S.people) if(seat==='all'||p.seat===seat){
    counts[p.state]=(counts[p.state]||0)+1;
    if(isLive(p)) counts.launches=(counts.launches||0)+1;
  }

  const stat=(v,k,c='')=>'<div class="stat"><div class="v '+c+'">'+v+'</div><div class="k">'+k+'</div></div>';
  const tab=(id,l)=>'<button class="tab'+(filter===id?' on':'')+'" onclick="setFilter(\''+id+'\')">'+l+
    (counts[id]!==undefined?'<span class="c">'+counts[id]+'</span>':'')+'</button>';
  const th=(k,l,extra='')=>'<th onclick="setSort(\''+k+'\')" '+extra+'>'+l+(sort===k?'<span class="ar"> '+(dir>0?'▲':'▼')+'</span>':'')+'</th>';

  const rail='<div class="mark">rally</div><div class="sublede">Product Hunt launch rally</div>'+
    '<div class="rl">accounts</div>'+
    '<button class="sitem'+(seat==='all'?' on':'')+'" onclick="seat=\'all\';just.clear();render()">'+
      '<div class="r1"><span class="nm">All accounts</span><span class="num">'+S.people.length+'</span></div>'+
      '<div class="r2">'+T.invited+' invited so far</div></button>'+
    S.seats.map(s=>{const cap=s.sentToday+s.remainingToday,pc=cap?Math.round(s.sentToday/cap*100):0;
      return '<button class="sitem'+(seat===s.name?' on':'')+'" onclick="seat=\''+s.name+'\';just.clear();render()">'+
      '<div class="r1"><span class="nm">'+esc(s.name)+'</span><span class="num'+(s.remainingToday===0?' over':'')+'">'+
        s.sentToday+'/'+s.rampEndsAt+'</span></div>'+
      '<div class="r2">'+(s.remainingToday===0?'past today’s ramp':'today’s ramp')+' · '+
        s.sentThisWeek+'/'+(s.weekCap??'~100')+' this week</div>'+
      '<div class="mini"><i style="width:'+pc+'%"></i></div></button>';}).join('')+
    '<div class="note">The ramp is advice, not a wall. LinkedIn’s ~100/week is the real limit, so '+
      '12/day and 98-in-one-day both end the week at 100 — the ramp just spends it in a shape that '+
      'looks like a person.</div>'+
    '<div class="rl">today’s goal</div>'+
    '<div class="goal"><div class="big">'+P.perDayToClearQueue+'</div>'+
      '<div class="lbl">LinkedIn invites to send today, across all '+S.seats.length+' accounts, to ask everyone before '+(L?L.at:'launch')+'.</div></div>'+
    '<div class="goal"><div class="big">'+P.capacityPerDay+'</div>'+
      '<div class="lbl">what the accounts can actually send today, at a safe rate.</div></div>';

  const head='<div class="hd"><span class="h1">Product Hunt rally</span>'+
    (L?'<span class="pill '+L.phase+'">'+(L.phase==='launch'?'launch day':L.phase==='eve'?'launch tomorrow':L.phase==='over'?'launch passed':'pre-launch')+'</span>':'')+
    '<span class="spacer"></span>'+
    (L?'<span class="num" style="font-size:12px;color:var(--fg-muted)">'+L.days+' days to '+L.at+'</span>':'')+
    (S.bookmarklet?'<a class="icon" href="'+S.bookmarklet+'" onclick="toast(\'Drag this to your bookmarks bar — do not click it here\');return false" '+
      'title="Drag to the bookmarks bar. On a LinkedIn profile it presses Connect for you.">⚡ Connect</a>':'')+
    '<button class="icon" onclick="sync(this)" title="Re-read the list from the database">Sync</button>'+
    '<button class="icon" onclick="toggleTheme()" title="Light / dark">'+
      (document.documentElement.classList.contains('dark')?'☀':'☾')+'</button></div>';

  const stats='<div class="stats">'+
    stat(P.perDayToClearQueue,'invites/day to<br>reach everyone','w')+
    stat(P.capacityPerDay,'invites/day the<br>accounts allow')+
    stat(T.supported,'launches you<br>commented on','g')+
    stat(T.invited,'invites<br>sent')+
    stat(T.accepted+(P.acceptRate!==null?'<span style="font-size:11px;color:var(--fg-subtle)"> '+P.acceptRate+'%</span>':''),'accepted the<br>invite','g')+
    stat(T.replied+(P.replyRate!==null?'<span style="font-size:11px;color:var(--fg-subtle)"> '+P.replyRate+'%</span>':''),'replied to<br>a message')+
    (P.unreachable>0?stat(P.unreachable,'people we will not<br>reach in time','d'):'')+
    '<div class="stat note">'+esc(P.verdict)+'</div></div>';

  const msg=S.sample?'<div class="msg"><b>today’s message</b><span id="samp">'+esc(S.sample.first)+'</span>'+
    '<button class="lk" onclick="navigator.clipboard.writeText(document.getElementById(\'samp\').textContent);toast(\'Message copied\')">copy</button></div>':'';

  const tb='<div class="tb">'+
    '<button class="tab'+(filter==='launches'?' on':'')+'" onclick="setFilter(\'launches\')" '+
      'title="Their launch is still live — upvote and leave a real comment first">Live launches'+
      (counts.launches?'<span class="c">'+counts.launches+'</span>':'')+'</button>'+
    tab('supported','Commented')+tab('queued','Not asked')+tab('invited','Invite sent')+tab('accepted','Accepted')+
    tab('messaged','Messaged')+tab('replied','Replied')+tab('declined','Skipped')+
    '<button class="tab'+(filter==='all'?' on':'')+'" onclick="setFilter(\'all\')">All</button>'+
    '<span class="spacer"></span>'+
    '<button class="tab go" onclick="openNext(batch)" title="Opens in the background — you stay here">'+
      'Open next '+batch+' ↗</button>'+
    '<select class="st" style="min-width:64px" onchange="batch=+this.value;render()">'+
      [5,10,15,20].map(n=>'<option value="'+n+'"'+(batch===n?' selected':'')+'>'+n+'</option>').join('')+'</select>'+
    '<input class="q" placeholder="Search  ( / )" value="'+esc(q)+'" oninput="q=this.value.toLowerCase();limit=200;render()">'+
    '</div>';

  const body=rows.length?'<table><thead><tr>'+
    '<th style="width:26px"><input type="checkbox" onclick="tickAll()"'+
      (view.length&&view.slice(0,limit).every(p=>sel.has(p.person_key))?' checked':'')+'></th>'+
    th('name','Person','style="width:26%"')+th('product','Launched','style="width:15%"')+
    th('priority','Why ranked','style="width:20%"')+
    '<th style="width:7%">Account</th>'+th('status','Status','style="width:11%"')+
    '<th style="text-align:right">Open</th></tr></thead><tbody>'+
    rows.slice(0,limit).map((p,i)=>{
      const st=S.seats.find(x=>x.name===p.seat);
      const past=seat!=='all'&&st&&i>=st.remainingToday;
      const b=(S.seats.find(s=>s.name===p.seat)||{}).browser||'';
      const opts=STATES.map(v=>'<option value="'+v+'"'+(p.state===v?' selected':'')+'>'+LABEL[v]+'</option>').join('');
      return (seat!=='all'&&st&&i===st.remainingToday&&st.remainingToday>0
        ? '<tr class="rampline"><td colspan="7">'+esc(seat)+'’s ramp for today ends here — '+st.rampEndsAt+
          ' invites. Below is tomorrow’s work. Carrying on is your call; LinkedIn’s ~'+(st.weekCap??100)+
          '/week is the limit that actually stops you.</td></tr>'
        : '')+
      '<tr data-i="'+i+'" class="'+(p.state==='declined'?'muted ':'')+(just.has(p.person_key)?'just ':'')+(past?'past ':'')+(i===cur?'cur':'')+'">'+
      '<td><input type="checkbox" class="tk"'+(sel.has(p.person_key)?' checked':'')+
        ' onclick="tick('+i+',event)"></td>'+
      '<td><div class="who">'+(p.avatar_url?'<img class="av" src="'+esc(p.avatar_url)+'" loading="lazy" alt="">':'<div class="av">'+init(p.name)+'</div>')+
        '<div style="min-width:0"><div class="nm">'+esc(p.name)+'</div>'+
        (p.headline&&p.headline!==p.product?'<div class="sub" style="font-size:11px">'+esc(p.headline)+'</div>':'')+
        '</div></div></td>'+
      '<td class="sub">'+(p.product_url
        ? '<a class="lk pl" href="'+esc(p.product_url)+'" target="_blank" rel="noreferrer" '+
          'title="Open their launch — upvote and leave a real comment">'+esc(p.product||'launch')+' &#8599;</a>'
        : esc(p.product||''))+'</td>'+
      '<td class="why">'+esc(p.why||'')+'</td>'+
      '<td class="seatc">'+esc(p.seat||'')+'</td>'+
      '<td><select class="st s-'+p.state+'" onchange="mark(\''+p.person_key+'\',this.value,\''+(p.seat||'')+'\',\''+esc(p.name).replace(/'/g,"")+'\')">'+opts+'</select></td>'+
      '<td style="text-align:right">'+
        // A REAL href, not href="#" with a handler. The first version was a dead link by every
        // normal test — cmd-click, middle-click, right-click → copy link, and "open in new tab"
        // all did nothing, and a plain click opened a window that need not come to the front.
        // Ordinary click behaviour is not a feature to be re-implemented in JavaScript.
        '<a class="lk go" href="'+esc(p.linkedin_url)+'" target="_blank" rel="noreferrer">LinkedIn</a>'+
        // The per-account open stays, as its own control, for when the point is WHICH account.
        (b?'<button class="lk seatopen" title="Open in '+esc(p.seat||'')+'’s browser ('+esc(b)+')" '+
           'onclick="openLink(\''+p.linkedin_url+'\',\''+b+'\',\''+esc(p.seat||'')+'\')">→'+esc(b.split(':')[0])+'</button>':'')+
        (p.ph_url?' <a class="lk" href="'+esc(p.ph_url)+'" target="_blank" rel="noreferrer">PH</a>':'')+
        (p.x_handle?' <a class="lk" href="https://x.com/'+esc(p.x_handle)+'" target="_blank" rel="noreferrer">X</a>':'')+'</td>'+
      '</tr>';}).join('')+'</tbody></table>'+
    (rows.length>limit?'<div style="padding:12px 16px"><button class="tab" onclick="limit+=400;render()">Show '+Math.min(400,rows.length-limit)+' more — '+(rows.length-limit)+' hidden</button></div>':'')
    :'<div class="empty">Nothing in this view.</div>';

  const st0=seat!=='all'?S.seats.find(x=>x.name===seat):null;
  const overBar=(st0&&st0.remainingToday===0)?'<div class="over-bar">'+esc(seat)+' has sent '+st0.sentToday+
    ' today, past its ramp of '+st0.rampEndsAt+'. Nothing here stops you — LinkedIn’s ~'+(st0.weekCap??100)+
    '/week does, and '+st0.sentThisWeek+' of it is spent.</div>':'';

  const bulk=sel.size?'<div class="bulk"><b class="num">'+sel.size+'</b> selected'+
    '<button class="tab go" onclick="openSel()">Open '+sel.size+' in tabs ↗</button>'+
    '<span style="color:var(--fg-subtle)">then mark them</span>'+
    ['supported','invited','accepted','messaged','replied','declined'].map(v=>
      '<button class="tab" onclick="markSel(\''+v+'\')">'+LABEL[v]+'</button>').join('')+
    '<button class="tab" style="margin-left:auto" onclick="sel.clear();lastTick=-1;render()">Clear</button></div>':'';

  document.getElementById('app').innerHTML='<div class="rail">'+rail+'</div>'+
    '<div class="main">'+head+stats+msg+tb+overBar+bulk+'<div class="scroll">'+body+'</div>'+
    '<div class="foot"><span class="num">'+rows.length+'</span><span>shown</span>'+
    '<span>·</span><span><kbd>j</kbd><kbd>k</kbd> move · <kbd>o</kbd> open · <kbd>O</kbd> open next '+batch+
' · <kbd>x</kbd> select · <kbd>a</kbd> all · <kbd>⏎</kbd> open selected in tabs · <kbd>1</kbd>–<kbd>5</kbd> set status · <kbd>/</kbd> search</span>'+
    '<span class="spacer"></span><span>Refreshes every 30s</span></div></div>';
}
load(); setInterval(load,30000);
</script></body></html>`;
