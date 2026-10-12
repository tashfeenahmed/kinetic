/**
 * The public tracking snippet served at /v.js?k=<site key>. Dependency-free, ~2 KB.
 * Sends pageviews (incl. SPA navigations), time on page (beacon when hidden),
 * key link clicks and identify calls as text/plain beacons so no CORS preflight is needed.
 */
export function trackerScript(opts: { endpoint: string; siteKey: string; respectDnt: boolean }): string {
  const cfg = JSON.stringify({ e: opts.endpoint, k: opts.siteKey, dnt: opts.respectDnt });
  return `/* Kinetic website visitors */
(function(w,d){
var C=${cfg},n=navigator,q=w.kinetic;
if(q&&q._loaded)return;
if(C.dnt&&(n.doNotTrack=="1"||w.doNotTrack=="1"||n.globalPrivacyControl))return;
if(n.webdriver)return;
function st(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){}if(v===undefined){var m=d.cookie.match(new RegExp("(?:^|; )"+k+"=([^;]*)"));return m?decodeURIComponent(m[1]):null}d.cookie=k+"="+encodeURIComponent(v)+";path=/;max-age=31536000;SameSite=Lax"}
function id(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36)}
var vid=st("_kn_vid");if(!vid){vid=id();st("_kn_vid",vid)}
var sid,s;try{s=JSON.parse(st("_kn_ses")||"null")}catch(e){s=null}
sid=s&&Date.now()-s.t<1800000?s.id:id();
function touch(){st("_kn_ses",JSON.stringify({id:sid,t:Date.now()}))}
touch();
var lead=null;
try{var u=new URL(location.href),kv=u.searchParams.get("k_vid");if(kv){st("_kn_lead",kv);u.searchParams.delete("k_vid");history.replaceState(history.state,"",u.pathname+u.search+u.hash)}}catch(e){}
lead=st("_kn_lead");
function send(t,x){var b={k:C.k,t:t,sid:sid,vid:vid,u:location.href,ti:d.title,r:d.referrer,kv:lead},s;for(var k in x)b[k]=x[k];s=JSON.stringify(b);touch();
try{if(n.sendBeacon&&n.sendBeacon(C.e,s))return}catch(e){}
try{fetch(C.e,{method:"POST",body:s,keepalive:true,mode:"no-cors",credentials:"omit"})}catch(e){}}
var start=Date.now(),last=location.href;
function leave(){var sec=Math.round((Date.now()-start)/1000);if(sec>0)send("leave",{d:sec});start=Date.now()}
function pv(){if(location.href===last&&arguments[0])return;last=location.href;start=Date.now();send("pv")}
send("pv");
var ps=history.pushState;history.pushState=function(){leave();var r=ps.apply(this,arguments);setTimeout(function(){pv(1)},0);return r};
w.addEventListener("popstate",function(){leave();pv(1)});
d.addEventListener("visibilitychange",function(){if(d.visibilityState==="hidden")leave();else start=Date.now()});
d.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a,button,[data-kinetic]");if(!a)return;
var h=a.href||"",tag=a.getAttribute("data-kinetic");
if(tag!==null||/pricing|demo|contact|sign-?up|register|book|trial|quote|calendly|cal\\.com|mailto:|tel:/i.test(h)||(h&&a.host&&a.host!==location.host))
send("click",{h:h,x:(tag||a.textContent||"").replace(/\\s+/g," ").trim().slice(0,80)})},true);
var api={_loaded:1,
identify:function(email){if(email&&/@/.test(email))send("id",{em:String(email).trim().slice(0,200)})},
track:function(name){send("click",{x:String(name).slice(0,80)})}};
w.kinetic=api;
if(q&&q.length)for(var i=0;i<q.length;i++){var c=q[i];if(c&&api[c[0]])api[c[0]].apply(null,[].slice.call(c,1))}
d.addEventListener("submit",function(e){var f=e.target,el=f&&f.querySelector&&f.querySelector("input[type=email],input[name*=email i]");if(el&&el.value&&f.hasAttribute("data-kinetic-identify"))api.identify(el.value)},true);
})(window,document);
`;
}

/** The HTML snippet users paste into their site's <head>. */
export function installSnippet(scriptUrl: string): string {
  return `<script>window.kinetic=window.kinetic||[];</script>\n<script async src="${scriptUrl}"></script>`;
}
