// All prices in this file are deterministic TEST FIXTURES intercepted only by CDP.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { newPage, closePage, goto, evaluate, evalAsync, setValue, setViewport, clickSel, waitForExpr, interceptNetwork, screenshot, cleanErrors } from '../../../tests/browser/cdp.mjs';
import { VERTICALS } from '../js/model.js';
import { normalizeEasyPost } from '../../../netlify/functions/lib/quotescout/adapters.mjs';
export async function run({base,cdpPort}) {
  const R=[],t=(name,pass,detail='')=>R.push({name:`Quote Scout ${name}`,pass:!!pass,detail});
  const s=await newPage(cdpPort);const requests=[];let scenario='quotes';
  const capabilities={vehicleData:true,verticals:VERTICALS.map(v=>({...v,capability:['package-shipping','health-insurance'].includes(v.id)?'Beta':'Requires provider integration'}))};
  const input={originZip:'90210',destinationZip:'10001',weight:16,length:10,width:5,height:3};
  const quotes=()=>normalizeEasyPost({rates:[4,1,3,2].map(n=>({mode:'production',rate:String(n+10),currency:'USD',carrier:`TEST carrier ${n}`,service:`TEST service ${n}`,delivery_days:n}))},input,Date.now()).quotes;
  const wire=events=>({contentType:'application/x-ndjson',body:events.map(e=>JSON.stringify(e)).join('\n')+'\n'});
  await interceptNetwork(s,(url,req)=>{
    if (/firestore|firebaseio|identitytoolkit|securetoken/.test(url))return 'fail';
    if(!url.includes('/.netlify/functions/quotescout'))return null;
    if(req.method==='GET')return {body:capabilities};
    const body=JSON.parse(req.postData);requests.push(body);
    if(scenario==='error')return {status:429,body:{message:'The comparison limit has been reached. Please try again later.'}};
    const start={type:'start',providers:[{id:'fixture',enabled:true}]},done={type:'done',checked:1};
    if(body.vertical==='vehicle-data')return wire([start,{type:'provider',provider:'vpic',name:'NHTSA vPIC',status:'OK',quotes:[],vehicle:{year:'2003',make:'HONDA',model:'Accord',source:'NHTSA vPIC (TEST FIXTURE)',warning:'TEST DATA'}},done]);
    if(body.vertical==='health-insurance'&&!body.input.county)return wire([start,{type:'provider',provider:'cms',name:'CMS Marketplace',status:'ADDITIONAL',quotes:[],questions:[{field:'county',label:'Which county?',options:[{value:'37057',label:'TEST Davidson'},{value:'37081',label:'TEST Guilford'}]}]},done]);
    if(body.vertical==='health-insurance')return wire([start,{type:'provider',provider:'cms',name:'CMS Marketplace',status:'UNSUPPORTED',quotes:[],message:'No plans for this location.'},done]);
    return wire([start,{type:'provider',provider:'easypost',name:'EasyPost',status:'OK',quotes:quotes(),cached:requests.length>2,warning:'One carrier did not return a rate.'},done]);
  });
  try {
    await setViewport(s,1280,900);await goto(s,base+'/apps/quotescout/',{settle:800});await waitForExpr(s,"!document.getElementById('qs-form').hidden");
    t('minimum VIN form',await evaluate(s,"document.querySelectorAll('#qs-fields input').length===1"));
    t('no email or phone gate',await evaluate(s,"!document.querySelector('#quotescout input[type=email],#quotescout input[type=tel]')"));
    t('unsupported categories are disclosed',await evaluate(s,"document.getElementById('qs-unavailable').textContent.includes('licensed insurance partner')"));
    await setValue(s,'#qs-vin','bad');await clickSel(s,'#qs-submit');t('invalid input does not call API',requests.length===0);
    await setValue(s,'#qs-vin','1HGCM82633A004352');await clickSel(s,'#qs-submit');await waitForExpr(s,"document.getElementById('qs-results').textContent.includes('HONDA')");t('vehicle decode renders',true);
    await mkdir(new URL('../.reports/',import.meta.url),{recursive:true});
    await screenshot(s,new URL('../.reports/desktop.png',import.meta.url).pathname);
    await clickSel(s,'#qs-modify');await setValue(s,'#qs-vin','');
    await setViewport(s,720,450);await evaluate(s,'window.scrollTo(0,320)');
    const preview=await s.send('Page.captureScreenshot',{format:'webp',quality:85});
    await writeFile(new URL('../.reports/preview.webp',import.meta.url),Buffer.from(preview.data,'base64'));
    if (process.env.QUOTESCOUT_UPDATE_PREVIEW === '1') await writeFile(new URL('../../../images/app-previews/quotescout.webp',import.meta.url),Buffer.from(preview.data,'base64'));
    await setViewport(s,1280,900);await setValue(s,'#qs-category','package-shipping');
    for(const [key,value]of Object.entries(input))await setValue(s,`#qs-${key}`,String(value));
    await clickSel(s,'#qs-submit');await waitForExpr(s,"document.querySelectorAll('.qs-result').length===3");
    t('Top 3 rather than all rates',await evaluate(s,"document.querySelectorAll('.qs-result').length===3"));
    t('lowest rate first',await evaluate(s,"document.querySelector('.qs-result').textContent.includes('$11.00')"));
    t('estimate and purchase limits',await evaluate(s,"document.querySelector('.qs-result').textContent.includes('ESTIMATE') && document.querySelector('.qs-result').textContent.includes('does not sell labels')"));
    t('partial carrier failure stays visible',await evaluate(s,"document.getElementById('qs-results').textContent.includes('One carrier')"));
    await evaluate(s,"Array.from(document.querySelectorAll('#qs-results button')).find(b=>b.textContent.includes('See all')).click()");t('all results expand',await evaluate(s,"document.querySelectorAll('.qs-result').length===4"));
    await setValue(s,'#qs-mode','best-value');t('ranking explains tradeoff',await evaluate(s,"document.getElementById('qs-results').textContent.includes('$1 for each')"));
    await clickSel(s,'#qs-refresh');await waitForExpr(s,"!document.getElementById('qs-refresh').disabled");t('refresh explicitly requests new prices',requests.at(-1).refresh===true);
    await clickSel(s,'#qs-modify');t('modify focuses initial field',await evaluate(s,"document.activeElement.id==='qs-originZip'"));
    const axe=await readFile(new URL('../../../tests/browser/vendor/axe.min.js',import.meta.url),'utf8');await s.send('Runtime.evaluate',{expression:axe});
    const violations=await evalAsync(s,"axe.run(document.getElementById('quotescout'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}).then(r=>r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})))");t('results accessibility',Array.isArray(violations)&&violations.length===0,JSON.stringify(violations));
    await evaluate(s,"(()=>{document.getElementById('qs-form').hidden=true; document.getElementById('qs-results').scrollIntoView(); return true})()");
    await screenshot(s,new URL('../.reports/desktop-results.png',import.meta.url).pathname);
    await setViewport(s,390,844);await evaluate(s,'window.scrollTo(0,0)');await screenshot(s,new URL('../.reports/mobile.png',import.meta.url).pathname);
    t('mobile no horizontal overflow',await evaluate(s,'document.documentElement.scrollWidth<=390'));
    t('button colors resist shared CSS',await evaluate(s,"getComputedStyle(document.getElementById('qs-submit')).color==='rgb(16, 35, 53)'"));
    await setValue(s,'#qs-category','health-insurance');for(const [k,v]of Object.entries({zip:'27360',age:'27',tobacco:'false',year:String(new Date().getUTCFullYear())}))await setValue(s,`#qs-${k}`,v);
    t('county not initially requested',await evaluate(s,"!document.querySelector('[name=county]')"));
    await clickSel(s,'#qs-submit');await waitForExpr(s,"!!document.querySelector('[name=county]')");t('provider question appears progressively',true);
    await setValue(s,'[name=county]','37057');await clickSel(s,'.qs-question button');await waitForExpr(s,"document.getElementById('qs-results').textContent.includes('No plans')");
    t('additional answer only targets requesting provider',requests.at(-1).provider==='cms'&&requests.at(-1).input.county==='37057');
    t('empty results explain no guessed prices',await evaluate(s,"document.getElementById('qs-results').textContent.includes('guessed prices')"));
    scenario='error';await clickSel(s,'#qs-refresh');await waitForExpr(s,"document.getElementById('qs-error').textContent.includes('limit')");t('rate limit actionable',true);
    t('no persistent quote data',await evaluate(s,"!Object.keys(localStorage).some(k=>/quotescout/.test(k))"));
    t('no uncaught JS errors',cleanErrors(s).length===0,JSON.stringify(cleanErrors(s)));
  } catch(e){t('flow completes',false,String(e.stack||e));} finally {await closePage(cdpPort,s);}
  return R;
}
