/* Checkout pop-up: before a monthly checkout, offer the same plan billed quarterly, which has no setup fee.
   Loaded on every page that has a Stripe payment link. */
(function(){
var SETUP=297;
/* monthly link id: [plan name, monthly price, quarterly price, quarterly link] */
var PLANS={
 '14AbJ19TSfwiaIacnS1wY07':['Essentials',147,427,'https://buy.stripe.com/eVq8wP0jiese3fI9bG1wY05'],
 'fZu6oH3vufwi7vYafK1wY0a':['All In One',279,829,'https://buy.stripe.com/8x25kD8PObg217A73y1wY09'],
 '8x214ngigabY4jM5Zu1wY02':['Dominance',497,1425,'https://buy.stripe.com/28E8wP5DC6ZM03w9bG1wY03']
};
function money(n){return '$'+n.toLocaleString('en-US')}
function find(href){for(var id in PLANS){if(href.indexOf(id)>=0)return PLANS[id]}return null}
function upsell(href,p){
 if(document.getElementById('bb-up'))return;
 var monthly3=p[1]*3+SETUP,save=monthly3-p[2];
 var o=document.createElement('div');o.id='bb-up';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','bb-up-t');
 o.innerHTML='<style>#bb-up{position:fixed;inset:0;z-index:2147483200;background:rgba(6,12,20,.62);display:grid;place-items:center;padding:16px;font-family:inherit}#bb-up .c{position:relative;width:min(480px,100%);background:#fff;color:#141b24;border-radius:22px;padding:28px 24px 22px;box-shadow:0 30px 80px -20px rgba(0,0,0,.55);max-height:calc(100vh - 32px);overflow:auto}#bb-up .x{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;border:0;background:#f1f3f6;color:#141b24;font-size:20px;cursor:pointer}#bb-up .k{display:inline-block;font-size:13px;font-weight:800;background:#f2a20c;color:#16191d;padding:6px 12px;border-radius:999px}#bb-up h3{margin:12px 30px 8px 0;font-size:23px;line-height:1.2;font-weight:800;letter-spacing:-.01em}#bb-up p{margin:0 0 10px;color:#5b6878;font-size:15px;line-height:1.55}#bb-up ul{margin:0 0 16px;padding-left:18px;color:#5b6878;font-size:14px;line-height:1.6}#bb-up .pr{display:flex;align-items:baseline;gap:10px;margin:4px 0 14px}#bb-up .pr b{font-size:38px;font-weight:800;letter-spacing:-.03em;line-height:1}#bb-up .pr s{color:#8a94a3}#bb-up .go{display:block;text-align:center;background:#f2a20c;color:#16191d;border-radius:999px;padding:15px;font-weight:800;font-size:16px;text-decoration:none}#bb-up .no{display:block;text-align:center;margin-top:12px;color:#5b6878;font-size:14px;font-weight:600;text-decoration:underline}</style>'+
 '<div class="c"><button class="x" type="button" aria-label="Close">&times;</button><span class="k">Before you check out</span>'+
 '<h3 id="bb-up-t">Pay quarterly and skip the '+money(SETUP)+' setup fee.</h3>'+
 '<p>You get 3 months of '+p[0]+' for one payment of '+money(p[2])+'. The same 3 months on the monthly plan come to '+money(monthly3)+' with the setup fee, so paying quarterly keeps '+money(save)+' in your pocket.</p>'+
 '<ul><li>We also update your Google Business Profile once your site is ready, so your site and your profile match.</li><li>It is billed every 3 months, and you can cancel before any renewal.</li></ul>'+
 '<div class="pr"><b>'+money(p[2])+'</b><s>'+money(monthly3)+'</s></div>'+
 '<a class="go" href="'+p[3]+'">Yes, pay quarterly for '+money(p[2])+'</a>'+
 '<a class="no" href="'+href+'">No thanks, continue with '+money(p[1])+' a month</a></div>';
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
 var h=a.href||'';var p=find(h);
 if(p){e.preventDefault();upsell(h,p);} /* monthly checkout only */
},true);
})();
