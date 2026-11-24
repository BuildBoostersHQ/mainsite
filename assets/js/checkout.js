/* Checkout upsell: before the monthly checkout, offer the 90-day prepay. Loaded on pages with payment links. */
(function(){
var PREPAY='https://api.buildboosters.com/payment-link/6af8a16121a48a3872d2610c';
var IDS=['6af64c63906a8b62055d610d','6af8a48f21a48a3872d26115'];
/* checkout upsell: shown before the monthly checkout only, on every page */
function upsell(href){
 if(document.getElementById('bb-up'))return;
 var yr=href.indexOf(IDS[1])>=0;
 var o=document.createElement('div');o.id='bb-up';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','bb-up-t');
 o.innerHTML='<style>#bb-up{position:fixed;inset:0;z-index:2147483200;background:rgba(6,12,20,.62);display:grid;place-items:center;padding:16px;font-family:inherit}#bb-up .c{position:relative;width:min(480px,100%);background:#fff;color:#141b24;border-radius:22px;padding:28px 24px 22px;box-shadow:0 30px 80px -20px rgba(0,0,0,.55);max-height:calc(100vh - 32px);overflow:auto}#bb-up .x{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;border:0;background:#f1f3f6;color:#141b24;font-size:20px;cursor:pointer}#bb-up .k{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;background:#f2a20c;color:#16191d;padding:6px 10px;border-radius:999px}#bb-up h3{margin:12px 30px 8px 0;font-size:23px;line-height:1.2;font-weight:800;letter-spacing:-.01em}#bb-up p{margin:0 0 10px;color:#5b6878;font-size:15px;line-height:1.55}#bb-up ul{margin:0 0 16px;padding-left:18px;color:#5b6878;font-size:14px;line-height:1.6}#bb-up .pr{display:flex;align-items:baseline;gap:10px;margin:4px 0 14px}#bb-up .pr b{font-size:38px;font-weight:800;letter-spacing:-.03em;line-height:1}#bb-up .pr s{color:#8a94a3}#bb-up .go{display:block;text-align:center;background:#f2a20c;color:#16191d;border-radius:999px;padding:15px;font-weight:800;font-size:16px;text-decoration:none}#bb-up .no{display:block;text-align:center;margin-top:12px;color:#5b6878;font-size:14px;font-weight:600;text-decoration:underline}</style>'+
 '<div class="c"><button class="x" type="button" aria-label="Close">&times;</button><span class="k">Before you check out</span>'+
 '<h3 id="bb-up-t">'+(yr?'Not sure about a full year? Start with 90 days and get your Google profile cleaned up free.':'Prepay 90 days and get your Google Business Profile cleaned up free.')+'</h3>'+
 '<p>3 months of the full All-In-One system for one payment of $591 ($197 x 3), plus a free Google Business Profile optimization (normally $349).</p>'+
 '<ul><li>Covers categories, services, service areas, description, hours, up to 20 of your photos, and a review link.</li><li>Not included: verification, suspension appeals, or ranking guarantees.</li><li>No auto-renewal. Continue monthly after 90 days only if you want to.</li></ul>'+
 '<div class="pr"><b>$591</b><s>$940 value</s></div>'+
 '<a class="go" href="'+PREPAY+'">Yes, prepay 90 days for $591</a>'+
 '<a class="no" href="'+href+'">No thanks, continue to '+(yr?'$1,970/year':'$197/month')+'</a></div>';
 document.body.appendChild(o);
 function close(){o.remove();removeEventListener('keydown',k)}
 function k(e){if(e.key==='Escape')close()}
 addEventListener('keydown',k);
 o.querySelector('.x').addEventListener('click',close);
 o.addEventListener('click',function(e){if(e.target===o)close()});
 setTimeout(function(){var g=o.querySelector('.go');if(g)g.focus()},50);
}
document.addEventListener('click',function(e){
 var a=e.target.closest&&e.target.closest('a[href]');if(!a||a.closest('#bb-up'))return;
 var h=a.getAttribute('href')||'';
 if(h.indexOf(IDS[0])>=0){e.preventDefault();upsell(h);} /* monthly checkout only */
},true);
})();
