#!/usr/bin/env node
// Automated metro test (Yeritasardakan): drives every case headless and prints PASS/FAIL per case. Exit code = number of failures.
// usage: node metro_test.js [port=8171]    (starts server.js on the port if nothing answers there, stops it by PID at the end)
// Needs chromium. The browser profile lives next to this script and is deleted on exit. Audio muted.
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const HERE = __dirname, ROOT = path.resolve(HERE, '..', '..', '..'), PORT = +(process.argv[2] || 8171), CDP = +(process.env.CDP || 9481);
const URL = `http://127.0.0.1:${PORT}/?auto=1&car=G500&traffic=0&opps=0&fixedq=1&at=-44,936,3.14`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv = null, ch = null; const PROF = path.join(HERE, 'prof_test' + process.pid);
const cleanup = () => { try { ch && ch.kill('SIGKILL'); } catch (e) { } try { srv && srv.kill('SIGTERM'); } catch (e) { } setTimeout(() => { try { fs.rmSync(PROF, { recursive: true, force: true }); } catch (e) { } }, 300); };
process.on('SIGINT', () => { cleanup(); process.exit(99); });
(async () => {
  let up = false; try { up = (await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok; } catch (e) { }
  if (!up) { srv = spawn('node', [path.join(ROOT, 'server.js'), String(PORT)], { stdio: 'ignore' }); for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok; } catch (e) { } } }
  ch = spawn('chromium', ['--headless=new', '--no-sandbox', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--remote-debugging-port=' + CDP, '--window-size=800,600', '--user-data-dir=' + PROF, 'about:blank'], { stdio: 'ignore' });
  let tabs; for (let i = 0; i < 80; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); if (tabs.length) break; } catch (e) { } await sleep(250); }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(); const send = (method, params) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); } else if (m.method === 'Runtime.exceptionThrown') console.log('page exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text)); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url: URL });
  let ready = false; for (let i = 0; i < 240 && !ready; i++) { await sleep(500); const r = await send('Runtime.evaluate', { expression: '!!(window.G && G.phys && G.world)', returnByValue: true }); ready = !!(r.result && r.result.value); }
  if (!ready) { console.log('FAIL: game did not load'); cleanup(); process.exit(98); }
  await sleep(1500);
  const body = fs.readFileSync(path.join(HERE, 'drv.js'), 'utf8') + '\n' + fs.readFileSync(path.join(HERE, 'page_tests.js'), 'utf8');
  const r = await send('Runtime.evaluate', { expression: '(async () => {' + body + '\n})()', awaitPromise: true, returnByValue: true, timeout: 900000 });
  if (r.exceptionDetails) { console.log('EVAL EXCEPTION ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)); cleanup(); process.exit(97); }
  let fails = 0;
  for (const t of r.result.value.results) { const s = t.pass === null ? 'SKIP' : t.pass ? 'PASS' : 'FAIL'; if (t.pass === false) fails++; console.log(s.padEnd(5), t.id.padEnd(40), JSON.stringify(t.info)); }
  console.log(fails ? fails + ' failing' : 'all passed');
  cleanup(); setTimeout(() => process.exit(fails), 600);
})().catch(e => { console.log('harness error', e); cleanup(); process.exit(96); });
