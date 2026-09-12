// A bookmarklet: one click, on the LinkedIn tab you are already looking at, that presses Connect
// and then "Send without a note" for you.
//
// ═══ WHY THIS IS NOT THE AUTOMATION THAT WAS DELETED ═══
//
// The deleted driver opened its own browser, walked a list unattended and sent while nobody
// watched. This does none of that. It runs only when a person clicks it, on a page that person
// already opened, in their own browser and session, once per profile. It presses the same two
// buttons they would have pressed, in the same order, with the same session.
//
// It is still a script clicking LinkedIn's buttons, and LinkedIn's terms do not distinguish
// finely. The honest position: this is materially lower risk than a driver — no unattended
// running, no pacing to get wrong, no session to replay — and it is not zero. It is offered
// because the founder asked for it and it is their accounts; the pacing brakes in the CRM still
// govern how many times a day it gets clicked.
//
// It reports back to the CRM so the row is marked without the founder switching windows, which is
// the actual productivity win — not the click, the bookkeeping.

const SRC = `(function(){
  var say=function(m,ok){
    var d=document.createElement('div');
    d.textContent=m;
    d.style.cssText='position:fixed;z-index:2147483647;top:14px;right:14px;padding:9px 14px;'+
      'border-radius:6px;font:600 13px -apple-system,system-ui,sans-serif;color:#fff;'+
      'background:'+(ok?'#137a4e':'#a3341f')+';box-shadow:0 4px 16px rgba(0,0,0,.28)';
    document.body.appendChild(d); setTimeout(function(){d.remove()},2600);
  };
  var pick=function(list){
    for(var i=0;i<list.length;i++){
      var els=document.querySelectorAll(list[i]);
      for(var j=0;j<els.length;j++){
        var e=els[j], r=e.getBoundingClientRect();
        if(r.width>0&&r.height>0&&!e.disabled) return e;
      }
    }
    return null;
  };
  var byText=function(tag,re){
    var els=document.querySelectorAll(tag);
    for(var i=0;i<els.length;i++){
      var t=(els[i].innerText||'').trim();
      if(re.test(t)){ var r=els[i].getBoundingClientRect(); if(r.width>0) return els[i]; }
    }
    return null;
  };
  if(/\\/(login|checkpoint|authwall)/.test(location.pathname)) return say('Not signed in on this profile',0);
  if(byText('button,span',/^Pending$/i)) return say('Already pending',0);

  var connect = pick(['button[aria-label^="Invite"][aria-label*="connect"]']) || byText('button',/^Connect$/i);
  if(!connect){
    var more = byText('button',/^More$/i) || pick(['button[aria-label="More actions"]']);
    if(more){ more.click(); }
    setTimeout(function(){
      var c = byText('div[role="menu"] *,span',/^Connect$/i);
      if(!c) return say('No Connect on this profile',0);
      c.click(); setTimeout(finish,900);
    },700);
    return;
  }
  connect.click();
  setTimeout(finish,900);

  function finish(){
    var send = pick(['button[aria-label="Send without a note"]']) || byText('button',/^Send without a note$/i)
            || pick(['button[aria-label="Send invitation"]']) || byText('button',/^Send$/i);
    if(!send) return say('Clicked Connect — finish the dialog',0);
    send.click();
    setTimeout(function(){
      var body=document.body.innerText||'';
      if(/weekly invitation limit|try again later/i.test(body)) return say('LinkedIn refused: limit reached',0);
      say('Invitation sent',1);
    },900);
  }
})();`;

/** The `javascript:` URL for the bookmark bar. Whitespace collapsed so it survives a paste. */
export const BOOKMARKLET = "javascript:" + encodeURIComponent(SRC.replace(/\s*\n\s*/g, " "));
