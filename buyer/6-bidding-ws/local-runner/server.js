#!/usr/bin/env node
/**
 * Local runner for buyer-send-bidding-buffer-2-script.sh
 *
 * Zero-dependency Node server (stdlib only):
 *  - Serves index.html (form + progress + live logs)
 *  - POST /api/runs        → validate params → spawn .sh → return { runId }
 *  - GET  /api/runs        → list runs (history)
 *  - GET  /api/runs/:id    → run status + meta
 *  - GET  /api/runs/:id/events (SSE) → replay logs then stream live
 *  - POST /api/runs/:id/stop → kill running k6
 *
 * Usage:
 *   node server.js            # → http://localhost:3101
 *   PORT=3200 node server.js
 *
 * Test: node test-server.js <base-url>
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('console');

const PORT = Number(process.env.PORT || 3101);
const ROOT = __dirname;
const SCRIPT_DIR = path.join(ROOT, '..');
const SCRIPT = path.join(SCRIPT_DIR, 'buyer-send-bidding-buffer-2-script.sh');

const MAX_LINES = 50000;   // per-run in-memory cap
const REPLAY_CAP = 5000;   // max lines replayed to a new SSE client

// ---------------------------------------------------------------- state
let seq = 0;
const runs = new Map(); // id -> run

function newId() {
  seq += 1;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${seq}`;
}

// ------------------------------------------------------------ validation
const POS_INT = /^[1-9][0-9]*$/;
const NON_NEG_INT = /^[0-9]+$/;

function validateParams(p) {
  const errors = [];
  const disconnectedRaw = p.disconnected;
  // default true (เหมือน checkbox ใน HTML) — ยกเลิกเฉพาะเมื่อส่ง false ชัดเจน
  const disconnected =
    disconnectedRaw === false || disconnectedRaw === 'false' || disconnectedRaw === '0' || disconnectedRaw === 'no'
      ? false
      : true;
  const v = {
    lotId: String(p.lotId ?? '975').trim() || '975',
    lotLineId: String(p.lotLineId ?? '').trim(),
    auctionNo: String(p.auctionNo ?? '1').trim() || '1',
    wsHold: String(p.wsHold ?? '30m').trim() || '30m',
    startLoopIndex: String(p.startLoopIndex ?? '1').trim() || '1',
    endLoopIndex: String(p.endLoopIndex ?? '100').trim() || '100',
    usernamePrefix: String(p.usernamePrefix ?? 'loadtestuser').trim() || 'loadtestuser',
    vus: String(p.vus ?? '').trim(),
    biddingDelayMs: String(p.biddingDelayMs ?? '').trim(),
    biddingTurnMs: String(p.biddingTurnMs ?? '').trim(),
    disconnected,
    dryRun: p.dryRun === true,
  };
  if (!v.lotLineId) errors.push('lotLineId จำเป็นต้องกรอก (arg2)');
  if (!POS_INT.test(v.auctionNo)) errors.push(`auctionNo ต้องเป็นจำนวนเต็มบวก (ได้: ${v.auctionNo})`);
  if (!POS_INT.test(v.startLoopIndex)) errors.push(`startLoopIndex ต้องเป็นจำนวนเต็มบวก (ได้: ${v.startLoopIndex})`);
  if (!POS_INT.test(v.endLoopIndex)) errors.push(`endLoopIndex ต้องเป็นจำนวนเต็มบวก (ได้: ${v.endLoopIndex})`);
  if (POS_INT.test(v.startLoopIndex) && POS_INT.test(v.endLoopIndex) && Number(v.endLoopIndex) < Number(v.startLoopIndex)) {
    errors.push(`endLoopIndex (${v.endLoopIndex}) ต้อง >= startLoopIndex (${v.startLoopIndex})`);
  }
  if (v.vus !== '' && !POS_INT.test(v.vus)) errors.push(`vus ต้องเป็นจำนวนเต็มบวก (ได้: ${v.vus})`);
  if (v.biddingDelayMs !== '' && !NON_NEG_INT.test(v.biddingDelayMs)) {
    errors.push(`biddingDelayMs ต้องเป็นจำนวนเต็ม >= 0 (ms) (ได้: ${v.biddingDelayMs})`);
  }
  if (v.biddingTurnMs !== '' && !NON_NEG_INT.test(v.biddingTurnMs)) {
    errors.push(`biddingTurnMs ต้องเป็นจำนวนเต็ม >= 0 (ms) (ได้: ${v.biddingTurnMs})`);
  }
  return { values: v, errors };
}

/** Build positional argv [lotId lotLineId auctionNo wsHold start end prefix vus delay turnMs disconnected] */
function toArgv(v) {
  return [
    v.lotId,
    v.lotLineId,
    v.auctionNo,
    v.wsHold,
    v.startLoopIndex,
    v.endLoopIndex,
    v.usernamePrefix,
    v.vus,
    v.biddingDelayMs,
    v.biddingTurnMs,
    v.disconnected ? 'true' : 'false',
  ];
}

function shellPreview(argv) {
  const q = (s) => (s === '' ? "''" : /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
  return `sh buyer-send-bidding-buffer-2-script.sh ${argv.map(q).join(' ')}`;
}

// ------------------------------------------------------------ log levels
const ANSI_RE = /\x1b\[[0-9;]*m/g; // ตัดสี ANSI ที่ k6 script พิมพ์มา (terminal แสดงได้ แต่เว็บไม่ควรเห็น escape code)

function classify(text) {
  if (/\[ERROR\]|✖|^\s*ERRO\[|level=error/i.test(text)) return 'error';
  if (/\[WARN\]|⚠|^\s*WARN\[|level=warn/i.test(text)) return 'warn';
  if (/\[SETUP\]/.test(text)) return 'setup';
  if (/vu\.complete|ws\.\w|login\.|lot-bidder|pickBuyer|iteration\./i.test(text)) return 'vu';
  if (/\[INFO\]|ℹ|✔/.test(text)) return 'info';
  if (/^\s*(running|execution:|scenarios|✓|✗|↳|█| {2,}\S|WARN|INFO|DEBU|ERRO)|^ {4,}/.test(text)) return 'k6';
  return 'out';
}

// ---------------------------------------------------------------- run core
function createRun(values, argv) {
  const id = newId();
  const run = {
    id,
    params: { ...values },
    cmd: shellPreview(argv),
    buyerCount: Number(values.endLoopIndex) - Number(values.startLoopIndex) + 1,
    status: 'running', // running | done | error | stopped
    exitCode: null,
    startTime: new Date().toISOString(),
    endTime: null,
    lines: [],
    counts: { error: 0, warn: 0, setup: 0, info: 0, vu: 0, k6: 0, out: 0 },
    clients: new Set(),
    proc: null,
    timers: [],
  };
  runs.set(id, run);
  return run;
}

function pushLine(run, text, src) {
  if (run.lines.length >= MAX_LINES) run.lines.shift(); // drop oldest
  // system lines ($ cmd echo, DRY-RUN markers, process exited…) → level 'sys'
  let level = classify(text);
  if (src === 'sys' && level === 'out') level = 'sys';
  const line = { n: run.lines.length + 1, t: new Date().toISOString(), level, src, text };
  run.lines.push(line);
  if (run.counts[line.level] !== undefined) run.counts[line.level] += 1;
  const payload = `event: log\ndata: ${JSON.stringify(line)}\n\n`;
  for (const res of run.clients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

function finishRun(run, status, exitCode) {
  if (run.status !== 'running') return;
  run.status = status;
  run.exitCode = exitCode;
  run.endTime = new Date().toISOString();
  const payload = `event: status\ndata: ${JSON.stringify(statusOf(run))}\n\n`;
  for (const res of run.clients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

function statusOf(run) {
  return {
    id: run.id, params: run.params, cmd: run.cmd, buyerCount: run.buyerCount,
    status: run.status, exitCode: run.exitCode,
    startTime: run.startTime, endTime: run.endTime,
    totalLines: run.lines.length, counts: run.counts,
  };
}

function startRealRun(run, argv) {
  if (!fs.existsSync(SCRIPT)) {
    pushLine(run, `file not found: ${SCRIPT}`, 'sys');
    finishRun(run, 'error', 1);
    return;
  }
  pushLine(run, `$ ${run.cmd}`, 'sys');
  const proc = spawn('sh', [SCRIPT, ...argv], { cwd: SCRIPT_DIR });
  run.proc = proc;
  let bufOut = '', bufErr = '';
  const feed = (chunk, stash, src) => {
    stash.text += chunk.toString();
    stash.text = stash.text.replace(ANSI_RE, ''); // เผื่อ escape sequence ถูกตัดกลาง chunk — ค่อย ๆ เก็บจนครบ
    const parts = stash.text.split('\n');
    stash.text = parts.pop();
    for (const l of parts) pushLine(run, l.replace(/\r$/, ''), src);
  };
  const sOut = { text: '' }, sErr = { text: '' };
  proc.stdout.on('data', (c) => feed(c, sOut, 'stdout'));
  proc.stderr.on('data', (c) => feed(c, sErr, 'stderr'));
  proc.on('error', (err) => {
    pushLine(run, `[ERROR] spawn failed: ${err.message}`, 'sys');
    finishRun(run, 'error', 1);
  });
  proc.on('close', (code, signal) => {
    if (sOut.text) pushLine(run, sOut.text.replace(ANSI_RE, ''), 'stdout');
    if (sErr.text) pushLine(run, sErr.text.replace(ANSI_RE, ''), 'stderr');
    pushLine(run, `process exited code=${code}${signal ? ` signal=${signal}` : ''}`, 'sys');
    if (run.status === 'running') finishRun(run, code === 0 ? 'done' : 'error', code);
  });
}

/** Dry-run: simulate streaming logs so UI/colors/filters can be verified without hitting the API. */
function startDryRun(run) {
  pushLine(run, `$ ${run.cmd}`, 'sys');
  pushLine(run, '[DRY-RUN] ไม่รัน k6 จริง — จำลอง log เพื่อเทสต์หน้าเว็บเท่านั้น', 'sys');
  const samples = [
    ['script          : k6-buyer-send-bidding-buffer-2.js', 'stdout'],
    ['lotId           : ' + run.params.lotId, 'stdout'],
    [`buyerCount      : ${run.buyerCount}`, 'stdout'],
    ['[SETUP] ╔══════════════════════════════════════════════════════════════╗', 'stdout'],
    ['[SETUP] ║ k6 buyer bidding — buffer-2                                  ║', 'stdout'],
    ['[SETUP] ╠──────────────────────────────────────────────────────────────╣', 'stdout'],
    ['[SETUP] ║ LOT    1079 · lotLine 10360 · auction #1                     ║', 'stdout'],
    ['[SETUP] ╚══════════════════════════════════════════════════════════════╝', 'stdout'],
    ['[SETUP] ══════════════════ 📦 lot-bidder + WS join batch START ══════════════════', 'stdout'],
    ['[SETUP] [1/3] [RESULT] batch.user.result · username=bltuser01 bidderNumber=B001 joinOk=true joinMs=812 ✔ OK', 'stdout'],
    ['ℹ [vu=1 it=0] 👤 pickBuyer · idx=0 username=bltuser01 loginType=buyer pick=vu', 'stdout'],
    ['ℹ [vu=1 it=0] 🔑 login.ok · username=bltuser01 status=200 durationMs=231.4 entryKey=abc...1234', 'stdout'],
    ['🟢 [vu=1 it=0] ws.open · user=bltuser01 status=connected attempt=1', 'stdout'],
    ['🕒 [vu=1 it=0] ws.hold.start · user=bltuser01 lotId=1079 holdMs=600000 attempt=1 ack=true — keep connection open in system', 'stdout'],
    ['🎯 [vu=1 it=0] ws.ack.ok · user=bltuser01 code=WS40005 phase=bidding', 'stdout'],
    ['⚠ [vu=2 it=0] lot-bidder-number.warn · called outside setup — buffer script expects setup() prep', 'stderr'],
    ['✖ [vu=3 it=0] ws.connected.fail · user=bltuser03 lotId=1079 type=notification code=WS00043', 'stderr'],
    ['✖ [vu=3 it=0] vu.complete · username=bltuser03 vu=3 iter=0 step=ws_bidding outcome=error error=join_notification_error', 'stderr'],
    ['     █ setup', 'stderr'],
    ['     ✓ ws connected settled', 'stderr'],
    ['     ✗ login status 200', 'stderr'],
    ['  running (0m05.0s), 000/100 VUs, 3 complete and 0 interrupted iterations', 'stderr'],
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (run.status !== 'running') { clearInterval(timer); return; }
    if (i >= samples.length) {
      clearInterval(timer);
      pushLine(run, '[DRY-RUN] done — กด Stop หรือรันจริงโดยเอาติ๊ก Dry-run ออก', 'sys');
      finishRun(run, 'done', 0);
      return;
    }
    pushLine(run, samples[i][0], samples[i][1]);
    i += 1;
  }, 400);
  run.timers.push(timer);
}

// ------------------------------------------------------------------ http
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  try {
    if (res.writableEnded || res.destroyed) return; // client หลุดกลางคัน — ไม่ต้องเขียนต่อ
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } catch { /* socket ตายระหว่างตอบ — ปล่อยได้ ไม่ให้พังทั้ง server */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) { req.destroy(); finish(reject, new Error('request body too large')); }
    });
    req.on('end', () => {
      if (!buf) return finish(resolve, {});
      try { finish(resolve, JSON.parse(buf)); } catch (e) { finish(reject, e); }
    });
    req.on('aborted', () => finish(reject, new Error('request aborted')));
    req.on('error', (e) => finish(reject, e));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;

    // ---- static
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const file = path.join(ROOT, 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(500); res.end('index.html not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    // ---- list runs
    if (req.method === 'GET' && pathname === '/api/runs') {
      json(res, 200, { runs: [...runs.values()].map(statusOf).reverse() });
      return;
    }

    // ---- create run
    if (req.method === 'POST' && pathname === '/api/runs') {
      const body = await readBody(req);
      const { values, errors } = validateParams(body || {});
      if (errors.length) { json(res, 400, { errors }); return; }
      const busy = [...runs.values()].find((r) => r.status === 'running');
      if (busy) { json(res, 409, { errors: [`มีรันที่กำลังทำงานอยู่แล้ว (${busy.id}) — กด Stop ก่อนรันใหม่`], busyRunId: busy.id }); return; }
      const argv = toArgv(values);
      console.log(300);
      console.log(argv);
      
      const run = createRun(values, argv);
      if (values.dryRun) startDryRun(run); else startRealRun(run, argv);
      json(res, 201, statusOf(run));
      return;
    }

    // ---- run status
    let m = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const run = runs.get(m[1]);
      if (!run) { json(res, 404, { errors: ['run not found'] }); return; }
      json(res, 200, { ...statusOf(run), recentLines: run.lines.slice(-200) });
      return;
    }

    // ---- SSE stream
    m = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (req.method === 'GET' && m) {
      const run = runs.get(m[1]);
      if (!run) { json(res, 404, { errors: ['run not found'] }); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: status\ndata: ${JSON.stringify(statusOf(run))}\n\n`);
      const replay = run.lines.slice(-REPLAY_CAP);
      for (const line of replay) res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
      if (run.lines.length > REPLAY_CAP) {
        res.write(`event: notice\ndata: ${JSON.stringify({ truncated: run.lines.length - REPLAY_CAP })}\n\n`);
      }
      run.clients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
      req.on('close', () => { clearInterval(hb); run.clients.delete(res); });
      return;
    }

    // ---- stop run
    m = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
    if (req.method === 'POST' && m) {
      const run = runs.get(m[1]);
      if (!run) { json(res, 404, { errors: ['run not found'] }); return; }
      if (run.status !== 'running') { json(res, 409, { errors: ['run นี้จบไปแล้ว'] }); return; }
      for (const t of run.timers) clearInterval(t);
      if (run.proc) {
        try { run.proc.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { run.proc && run.proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
      }
      pushLine(run, '[STOP] ผู้ใช้กดหยุด — ส่ง SIGTERM ไปที่ process แล้ว', 'sys');
      finishRun(run, 'stopped', null);
      json(res, 200, statusOf(run));
      return;
    }

    json(res, 404, { errors: ['not found'] });
  } catch (e) {
    json(res, 500, { errors: [String(e && e.message || e)] });
  }
});

// request เสีย/abort จากฝั่ง client — อย่าให้ throw ทั้ง process
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
});

server.listen(PORT, () => {
  console.log(`local-runner up → http://localhost:${PORT}`);
  console.log(`script        → ${SCRIPT}`);
});
