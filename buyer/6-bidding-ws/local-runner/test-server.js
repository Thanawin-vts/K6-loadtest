#!/usr/bin/env node
/**
 * Test-suite for local-runner server.js
 *
 * Coverage:
 *   - static GET / (index.html)
 *   - validation  → POST /api/runs with bad params (expect 400 + errors[])
 *   - valid+occupied → 409 when a run is already running
 *   - dry-run     → 201, streaming synthetic logs, final status done
 *   - SSE         → GET /api/runs/:id/events (replay + live log events, status event)
 *   - stop        → POST /api/runs/:id/stop on running (200) then again (409)
 *   - status/list → GET /api/runs/:id, GET /api/runs, 404 for unknown id
 *
 * Usage:
 *   node test-server.js                # default http://localhost:3101
 *   PORT=3101 node test-server.js      # explicit
 *   node test-server.js http://localhost:3199
 */
'use strict';

const http = require('http');

const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 3101}`;

console.log(`base url → ${BASE}`);

// ---------------------------------------------------------------- helpers
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra ? '  → ' + JSON.stringify(extra) : ''}`);
    failures.push(name);
  }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Open SSE, resolve with { events: [{event, data}] } once run reaches a non-running status. */
function collectSSE(runId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/runs/${runId}/events`, BASE);
    const events = [];
    let buf = '';
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('SSE timeout — never saw terminal status'));
    }, timeoutMs);

    const req = http.get(url, (res) => {
      res.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;              // heartbeat comment
            const sep = line.indexOf(':');
            if (sep === -1) continue;
            const key = line.slice(0, sep).trim();
            const val = line.slice(sep + 1).trim();
            if (key === 'event') ev.event = val;
            else if (key === 'data') ev.data = val;
          }
          if (!ev.event) continue;
          let data = null;
          try { data = JSON.parse(ev.data); } catch { /* keep raw */ }
          ev.parsed = data;
          events.push(ev);
          if (ev.event === 'status' && data && data.status !== 'running') {
            clearTimeout(timer);
            req.destroy();
            resolve(events);
          }
        }
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// ------------------------------------------------------------------ cases
async function testValidation() {
  console.log('\n[validation]');
  const base = { lotLineId: '10637', auctionNo: '1', startLoopIndex: '1', endLoopIndex: '100' };

  const cases = [
    ['missing lotLineId', { ...base, lotLineId: '' }, /lotLineId/],
    ['auctionNo = abc', { ...base, auctionNo: 'abc' }, /auctionNo/],
    ['auctionNo = 0', { ...base, auctionNo: '0' }, /auctionNo/],
    ['startLoopIndex = 0', { ...base, startLoopIndex: '0' }, /startLoopIndex/],
    ['endLoopIndex = abc', { ...base, endLoopIndex: 'abc' }, /endLoopIndex/],
    ['endLoopIndex < startLoopIndex', { ...base, startLoopIndex: '5', endLoopIndex: '3' }, /endLoopIndex/],
    ['vus = abc', { ...base, vus: 'abc' }, /vus/],
    ['vus = 0', { ...base, vus: '0' }, /vus/],
    ['biddingDelayMs = -1', { ...base, biddingDelayMs: '-1' }, /biddingDelayMs/],
    ['biddingDelayMs = 0.5', { ...base, biddingDelayMs: '0.5' }, /biddingDelayMs/],
  ];

  for (const [name, body, re] of cases) {
    const r = await request('POST', '/api/runs', body);
    ok(`${name} → HTTP 400`, r.status === 400, r.status);
    ok(`  .errors มีข้อความ "${re}"`, Array.isArray(r.json?.errors) && r.json.errors.some((e) => re.test(e)), r.json?.errors);
  }

  // invalid JSON body → 500 (server rejects via readBody throw)
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/runs', BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 4 },
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write('{bad'); req.end();
  });
  ok('invalid JSON body → HTTP 500', raw.status === 500, raw.status);
}

async function testStaticAnd404() {
  console.log('\n[static / 404]');
  const home = await request('GET', '/');
  ok('GET / → 200 text/html', home.status === 200 && /text\/html/.test(home.headers['content-type']), home.status);
  ok('  index.html โหลดขึ้น', /Local Runner/.test(home.body), 'no local-runner html');
  const nf = await request('GET', '/api/runs/unknown-run-id');
  ok('GET unknown run → 404', nf.status === 404, nf.status);
  const nfStop = await request('POST', '/api/runs/unknown-run-id/stop');
  ok('POST stop unknown run → 404', nfStop.status === 404, nfStop.status);
}
async function testBusyThenStop() {
  console.log('\n[busy 409 + stop]');
  const body = {
    lotId: '1079', lotLineId: '10637', auctionNo: '1', wsHold: '10m',
    startLoopIndex: '1', endLoopIndex: '100', usernamePrefix: 'bltuser',
    vus: '100', biddingDelayMs: '100', dryRun: true,
  };
  const a = await request('POST', '/api/runs', body);
  ok(`create run (dryRun) → 201`, a.status === 201, a.status);
  ok('  response มี id/status=running/buyerCount', a.json?.id && a.json?.status === 'running' && a.json?.buyerCount === 100, a.json);
  const runId = a.json.id;
  ok('  cmd ถูก b64 ว่าเป็น script เดิม', /buyer-send-bidding-buffer-2-script\.sh/.test(a.json.cmd), a.json.cmd);

  const b = await request('POST', '/api/runs', body);
  ok(`create 2nd while running → 409`, b.status === 409, b.status);
  ok('  409 มี busyRunId + ข้อความแจ้ง', b.json?.busyRunId === runId && Array.isArray(b.json?.errors), b.json);

  await sleep(1200); // let some dry-run logs flush
  const s1 = await request('GET', `/api/runs/${runId}`);
  ok('GET run status → running + recentLines', s1.json?.status === 'running' && Array.isArray(s1.json?.recentLines) && s1.json.recentLines.length > 0, s1.json);

  const st = await request('POST', `/api/runs/${runId}/stop`);
  ok(`POST stop running → 200 stopped`, st.status === 200 && st.json?.status === 'stopped', st.json);

  const st2 = await request('POST', `/api/runs/${runId}/stop`);
  ok(`POST stop again → 409`, st2.status === 409, st2.status);

  const after = await request('GET', `/api/runs/${runId}`);
  ok('  history รอบนี้จบ status=stopped', after.json?.status === 'stopped' && after.json?.counts, after.json && after.json.status);
}
async function testDryRunAndSSE() {
  console.log('\n[dry-run + SSE]');
  const body = {
    lotId: '1079', lotLineId: '10637', auctionNo: '1', wsHold: '10m',
    startLoopIndex: '1', endLoopIndex: '10', usernamePrefix: 'bltuser',
    vus: '10', biddingDelayMs: '100', dryRun: true,
  };
  const c = await request('POST', '/api/runs', body);
  ok(`create dry-run → 201`, c.status === 201 && c.json?.status === 'running', c.json);
  const runId = c.json.id;

  const events = await collectSSE(runId);   // connects while running
  ok('SSE: มีทั้ง status event และ log events', events.length >= 2, events.length);
  const statusEvents = events.filter((e) => e.event === 'status');
  const logEvents = events.filter((e) => e.event === 'log');
  ok(`SSE: มี log events (${logEvents.length})`, logEvents.length >= 15, logEvents.length);
  ok('SSE: status ลำดับแรกเป็น running', statusEvents[0]?.parsed?.status === 'running', statusEvents[0] && statusEvents[0].parsed);
  const finalStatus = statusEvents[statusEvents.length - 1].parsed;
  ok('SSE: status สุดท้าย = done', finalStatus.status === 'done', finalStatus);

  const texts = logEvents.map((e) => e.parsed?.text || '');
  ok('SSE: มีบรรทัด [DRY-RUN]', texts.some((t) => /DRY-RUN/.test(t)));
  const levels = {};
  for (const e of logEvents) levels[e.parsed.level] = (levels[e.parsed.level] || 0) + 1;
  ok('Log จำแนกสีได้ (error + warn + setup + info + sys + k6)', levels.error >= 2 && levels.warn >= 1 && levels.setup >= 1 && levels.info >= 5 && levels.sys >= 2 && levels.k6 >= 3, levels);

  // after done: verify counts match what we saw and run is closed
  const after = await request('GET', `/api/runs/${runId}`);
  ok('GET run → done, exitCode 0', after.json?.status === 'done' && after.json?.exitCode === 0, after.json && after.json.status);
  ok(`counts.error = ${after.json?.counts?.error} (ตรงกับที่เห็น)`, after.json?.counts?.error === (levels.error || 0), after.json?.counts);

  // replay for a second client that connects after finish
  const ev2 = await (async () => {
    const url = new URL(`/api/runs/${runId}/events`, BASE);
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let buf = ''; const evs = [];
        const done = setTimeout(() => { req.destroy(); resolve(evs); }, 2500);
        res.on('data', (c) => {
          buf += c.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = {};
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) continue;
              const sep = line.indexOf(':');
              if (sep === -1) continue;
              const k = line.slice(0, sep).trim();
              const v = line.slice(sep + 1).trim();
              if (k === 'event') ev.event = v;
              else if (k === 'data') ev.data = v;
            }
            if (!ev.event) continue;
            evs.push(ev);
            if (ev.event === 'log' && evs.length >= 25) { clearTimeout(done); req.destroy(); resolve(evs); }
          }
        });
        res.on('error', (e) => { clearTimeout(done); reject(e); });
      });
      req.on('error', (e) => { clearTimeout(done); reject(e); });
    });
  })();
  const replayLogs = ev2.filter((e) => e.event === 'log');
  const replayStatus = ev2.find((e) => e.event === 'status');
  ok('SSE replay หลังจบ: ได้ log ย้อนหลัง', replayLogs.length >= 10, replayLogs.length);
  ok('SSE replay หลังจบ: status บอก done', replayStatus && /"status":"done"/.test(replayStatus.data || ''), replayStatus && replayStatus.data);
}

async function testList() {
  console.log('\n[history list]');
  const r = await request('GET', '/api/runs');
  ok('GET /api/runs → 200 array', r.status === 200 && Array.isArray(r.json?.runs) && r.json.runs.length >= 2, r.status);
  const first = r.json.runs[0];
  ok('  เรียงลำดับใหม่สุดก่อน + มี status buffer', ['done', 'stopped', 'error', 'running'].includes(first.status), first.status);
  ok('  มี cmd/params/buyerCount/counts', first.cmd && first.params && Number.isInteger(first.buyerCount) && first.counts, Object.keys(first));
}

// ------------------------------------------------------------------- main
(async () => {
  console.log(`local-runner test → ${BASE}`);
  await testStaticAnd404();
  await testValidation();
  await testBusyThenStop();
  await testDryRunAndSSE();
  await testList();

  console.log(`\n========================================`);
  console.log(`passed: ${passed}   failed: ${failed}`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('ALL TESTS PASSED ✅');
})().catch((e) => {
  console.error('TEST RUNNER ERROR:', e);
  process.exit(1);
});