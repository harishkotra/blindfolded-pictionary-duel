import { chromium } from 'playwright';
let ctx=null;
for (const o of [{},{channel:'chrome'}]) { try { ctx=await chromium.launchPersistentContext('.bpd-browser',{headless:true,viewport:{width:1500,height:1150},...o}); break; } catch {} }
const page=await ctx.newPage();

// Capture the raw API response so we can scan the wire, not just the DOM.
let rawBody='';
page.on('response', async (r)=>{
  if (r.url().includes('/api/draw')) { try { rawBody = await r.text(); } catch {} }
});

await page.goto('http://localhost:5201/',{waitUntil:'networkidle'});
await page.click('.rung:has-text("R1")');
await page.waitForFunction(()=>document.querySelectorAll('.frame').length>0,undefined,{timeout:300000});
await page.waitForTimeout(6000);

const PAT = /(\/Users\/|\/home\/|[A-Za-z]:\\\\|server\/logs|\/server\/|raw-model-output|\/private\/|\/var\/folders)/;

const domText = await page.evaluate(()=>document.body.innerText);
console.log('--- the log line as rendered ---');
console.log(' ', JSON.stringify((domText.match(/Raw JSON[^\n]*/)||['(not found)'])[0]));
console.log('--- path-pattern scan ---');
console.log('  DOM text     :', PAT.test(domText) ? 'LEAK -> '+domText.match(PAT)[0] : 'clean');
console.log('  API response :', PAT.test(rawBody) ? 'LEAK -> '+rawBody.match(PAT)[0] : 'clean');
const keys = rawBody ? Object.keys(JSON.parse(rawBody)).join(', ') : 'n/a';
console.log('  response keys:', keys);
console.log('  logged field :', rawBody ? JSON.stringify(JSON.parse(rawBody).logged) : 'n/a');
await ctx.close();
