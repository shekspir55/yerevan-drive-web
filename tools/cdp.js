// Headless Chromium test harness (software GL). usage: CDP=9333 node tools/cdp.js "<url>" <waitSec> <out.png> "<js expression>"
// Prints console log/warning lines and "EVAL: <result>". The temporary profile is removed on exit.
const { spawn } = require('child_process'), os = require('os'), fs = require('fs');
const [url, waitSec = 15, out = '/tmp/cdp.png', expr] = process.argv.slice(2), port = +(process.env.CDP || 9333);
const PROF = os.tmpdir() + '/cdpprof' + Date.now();
const rm = () => { try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) { } };
const ch = spawn('chromium', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=' + port, '--window-size=1024,768', '--user-data-dir=' + PROF, 'about:blank'], { stdio: 'ignore' });
const done = c => { rm(); try { ch.kill('SIGKILL'); } catch (e) { } process.exit(c || 0); };
process.on('exit', rm); process.on('SIGINT', () => done(1)); process.on('SIGTERM', () => done(1));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let tabs; for (let i = 0; i < 60; i++) { try { tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json(); if (tabs.length) break; } catch (e) { } await sleep(250); }
  const tab = tabs.find(t => t.type === 'page'); const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(); const send = (method, params) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.type; if (t === 'warning' || t === 'error' || t === 'log') console.log(t + ': ' + m.params.args.map(a => a.value !== undefined ? a.value : a.description).join(' ')); } else if (m.method === 'Runtime.exceptionThrown') console.log('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text)); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url }); await sleep(waitSec * 1000);
  if (expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 170000 }); if (r.exceptionDetails) console.log('EVAL EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); console.log('EVAL: ' + JSON.stringify(r.result ? r.result.value : r)); }
  const shot = await send('Page.captureScreenshot', { format: 'png' }); if (shot.data) fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  done(0);
})().catch(e => { console.log('cdp error', e); done(1); });
