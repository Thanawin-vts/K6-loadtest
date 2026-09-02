/**
 * k6 — login → [setup: lot-bidder-number ทีละ user] → WS visitLot
 *
 * BUYER_USER = array ของ buyer
 * Default: เปิด VU พร้อมกัน = จำนวน buyer (1 VU : 1 user) แล้วแต่ละ VU รันครบทุก action
 *
 * บริบท: buffer script — lot-bidder-number ถูกเตรียมใน setup() ทีละ user (ไม่ยิงพร้อมกัน)
 *        phase หลัก: login + WS visitLot ยังรันพร้อมกันตาม VU (ไม่ส่ง connected)
 *
 * รันตัวอย่าง (parallel + hold connection):
 *   ./buyer-visit-lot-buffer-script.sh 975 5m 1 10 loadtestuser
 *   k6 run buyer/3-visitlot-ws/k6-buyer-visit-lot-buffer.js \
 *     -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
 *     -e WS_URL=wss://auctlive-sit.auct.co.th/api/v1/websocket \
 *     -e LOT_ID=975 \
 *     -e WS_HOLD=5m \
 *     -e START_LOOP_INDEX=1 \
 *     -e END_LOOP_INDEX=10 \
 *     -e USERNAME_PREFIX=loadtestuser
 *
 * ตัวแปรเสริม:
 *   START_LOOP_INDEX=1      # getMockBuyer start index
 *   END_LOOP_INDEX=100      # getMockBuyer end index
 *   USERNAME_PREFIX=loadtestuser
 *   VUS                 # default = BUYER_USER.length
 *   ITERATIONS=1        # จำนวนรอบต่อ VU (per-vu-iterations)
 *   EXECUTOR=per-vu|constant  # default per-vu
 *   DURATION=30s        # ใช้เมื่อ EXECUTOR=constant
 *   USER_PICK=vu|round  # default vu (1 VU sticky 1 user)
 *   WS_TIMEOUT_MS=15000 # timeout ตอน join (ยังไม่ settle)
 *   JOIN_SETTLE_MS=1000 # รอหลังส่ง visitLot ก่อนถือว่า join สำเร็จ
 *   WS_HOLD=5m          # ค้าง connection หลัง join สำเร็จ (รองรับ ms|s|m|h หรือตัวเลข ms)
 *   LOT_BIDDER_GAP_MS=0     # รอระหว่าง user ใน setup (lot-bidder-number ทีละคน)
 *   LOT_BIDDER_RETRIES=3    # retry lot-bidder-number ใน setup เมื่อ fail/timeout
 *   LOT_BIDDER_RETRY_MS=500
 *   HTTP_TIMEOUT_MS=15000
 *   SETUP_TIMEOUT=30m       # override k6 setup() limit (default 0 = 24h, ไม่ timeout ระหว่าง test)
 *   LOG_WS_MSG=true
 *   REPORT_DIR=k6-reports
 *   REPORT_BASENAME=buyer-visit-lot-buffer
 *   # output → k6-reports/yyyyMMdd/HH-mm-ss/*.json|html
 *   # หรือกำหนด path เต็มด้วย REPORT_JSON / REPORT_HTML
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createHandleSummary } from '../../lib/k6-report.js';
import { getMockBuyer } from '../../buyer-mock-user.js';

const loginDuration = new Trend('login_duration_ms');
const bidderDuration = new Trend('lot_bidder_number_duration_ms');
const wsSessionDuration = new Trend('ws_session_duration_ms');
const visitOk = new Counter('visit_lot_ok');
const connectedOk = new Counter('connected_ok');
const connectedFail = new Counter('connected_fail');
const pingReceived = new Counter('ws_ping_received');
const pongSent = new Counter('ws_pong_sent');
const lotBidderPrepareOk = new Counter('lot_bidder_prepare_ok');
const lotBidderPrepareFail = new Counter('lot_bidder_prepare_fail');

const START_LOOP_INDEX = Math.max(1, Number(__ENV.START_LOOP_INDEX || 1));
const END_LOOP_INDEX = Math.max(START_LOOP_INDEX, Number(__ENV.END_LOOP_INDEX || 100));
const USERNAME_PREFIX = String(__ENV.USERNAME_PREFIX || 'loadtestuser');

export const BUYER_USER = getMockBuyer(START_LOOP_INDEX, END_LOOP_INDEX, USERNAME_PREFIX);

const BASE_URL = (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, '');
const WS_URL = (__ENV.WS_URL || 'wss://auctlive-sit.auct.co.th/api/v1/websocket').replace(/\/$/, '');
const LOT_ID = String(__ENV.LOT_ID || '');
const USER_PICK = String(__ENV.USER_PICK || 'vu').toLowerCase(); // vu | round
const EXECUTOR = String(__ENV.EXECUTOR || 'per-vu').toLowerCase(); // per-vu | constant
const VUS = Number(__ENV.VUS || BUYER_USER.length);
const ITERATIONS = Number(__ENV.ITERATIONS || 1);
const WS_TIMEOUT_MS = Number(__ENV.WS_TIMEOUT_MS || 15000);
const JOIN_SETTLE_MS = Number(__ENV.JOIN_SETTLE_MS || 1000);
const LOG_WS_MSG = String(__ENV.LOG_WS_MSG || 'false').toLowerCase() === 'true';
const LOT_BIDDER_GAP_MS = Number(__ENV.LOT_BIDDER_GAP_MS || 0);
const LOT_BIDDER_RETRIES = Number(__ENV.LOT_BIDDER_RETRIES || 3);
const LOT_BIDDER_RETRY_MS = Number(__ENV.LOT_BIDDER_RETRY_MS || 500);
const HTTP_TIMEOUT_MS = Number(__ENV.HTTP_TIMEOUT_MS || 15000);

function parseDurationMs(value, fallbackMs) {
  if (value == null || value === '') return fallbackMs;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'ms') return n;
  if (u === 's') return n * 1000;
  if (u === 'm') return n * 60 * 1000;
  if (u === 'h') return n * 60 * 60 * 1000;
  return fallbackMs;
}

function msToDuration(ms) {
  const n = Math.max(1, Math.ceil(Number(ms) || 0));
  if (n >= 3600000 && n % 3600000 === 0) return `${n / 3600000}h`;
  if (n >= 60000 && n % 60000 === 0) return `${n / 60000}m`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

/** k6 ไม่มี "no timeout" — ต้องกำหนด duration บวก; default 0 = 24h */
const SETUP_UNLIMITED_MS = 24 * 60 * 60 * 1000;

function resolveSetupTimeout() {
  const raw = String(__ENV.SETUP_TIMEOUT || __ENV.SETUP_TIMEOUT_MS || '0').trim();
  if (['0', '0s', '0ms', 'unlimited', 'none', 'inf', 'infinite'].includes(raw.toLowerCase())) {
    return '24h';
  }
  return msToDuration(parseDurationMs(raw, SETUP_UNLIMITED_MS));
}

const SETUP_TIMEOUT = resolveSetupTimeout();

// ค้าง WS หลัง join สำเร็จ — default 5 นาที
const WS_HOLD_MS = parseDurationMs(__ENV.WS_HOLD_MS || __ENV.WS_HOLD || '30m', 30 * 60 * 1000);
const MAX_DURATION =
  __ENV.MAX_DURATION ||
  `${Math.max(2, Math.ceil((WS_HOLD_MS + WS_TIMEOUT_MS + 60000) / 60000))}m`;

function nowIso() {
  return new Date().toISOString();
}

function vuContext() {
  return {
    vu: typeof __VU !== 'undefined' ? __VU : 'setup',
    iter: typeof __ITER !== 'undefined' ? __ITER : '-',
  };
}

function vuTag() {
  const { vu, iter } = vuContext();
  return `[vu=${vu} iter=${iter}]`;
}

function logInfo(action, detail) {
  const extra = detail ? ` | ${detail}` : '';
  console.log(`[INFO]${vuTag()} ${action}${extra}`);
}

function logError(action, detail) {
  const extra = detail ? ` | ${detail}` : '';
  console.error(`[ERROR]${vuTag()} ${action}${extra}`);
}

function formatHttpError(res, body) {
  const parts = [];
  if (res) parts.push(`status=${res.status}`);
  if (body && body.code) parts.push(`code=${body.code}`);
  if (body && body.message) parts.push(`message=${body.message}`);
  return parts.join(' ');
}

function describeWsNotification(msg) {
  if (!msg || typeof msg !== 'object') return `raw=${String(msg).slice(0, 120)}`;
  const payload = msg.payload || {};
  const parts = [
    `type=${msg.type || '-'}`,
    payload.code ? `code=${payload.code}` : null,
    payload.level ? `level=${payload.level}` : null,
    payload.message ? `message=${payload.message}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

const SETUP_LOG_WIDTH = 72;

function logSetupDivider(title) {
  if (!title) {
    console.log(`[SETUP] ${'═'.repeat(SETUP_LOG_WIDTH)}`);
    return;
  }
  const label = ` ${title} `;
  const pad = Math.max(0, SETUP_LOG_WIDTH - label.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(`[SETUP] ${'═'.repeat(left)}${label}${'═'.repeat(right)}`);
}

function logSetupRule() {
  console.log(`[SETUP] ${'─'.repeat(SETUP_LOG_WIDTH)}`);
}

function logSetup(action, detail, meta) {
  const m = meta || {};
  const tags = [];
  if (m.round) tags.push(m.round);
  if (m.phase) tags.push(m.phase);
  if (m.attempt != null && m.maxAttempts != null) {
    tags.push(`attempt ${m.attempt}/${m.maxAttempts}`);
  }
  if (m.status) tags.push(m.status);
  const tagStr = tags.length ? `[${tags.join('][')}] ` : '';
  const extra = detail ? ` | ${detail}` : '';
  console.log(`[SETUP] ${tagStr}${action}${extra}`);
}

function maskToken(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 10) return '***';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function buildScenario() {
  if (EXECUTOR === 'constant') {
    return {
      executor: 'constant-vus',
      vus: VUS,
      duration: __ENV.DURATION || `${Math.ceil(WS_HOLD_MS / 1000)}s`,
      gracefulStop: '10s',
    };
  }
  // default: ทุก VU join แล้วค้าง connection ตาม WS_HOLD
  return {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: ITERATIONS,
    maxDuration: MAX_DURATION,
    gracefulStop: '10s',
  };
}

export const options = {
  setupTimeout: SETUP_TIMEOUT,
  scenarios: {
    login_visit_connected: buildScenario(),
  },
  thresholds: {
    http_req_failed: ['rate<0.1'],
    checks: ['rate>0.9'],
    login_duration_ms: ['p(95)<5000'],
    lot_bidder_number_duration_ms: ['p(95)<15000'],
  },
};

function requireEnv() {
  if (!LOT_ID) {
    fail(`ขาด env: LOT_ID — ตัวอย่าง: -e LOT_ID=975`);
  }
  if (!Array.isArray(BUYER_USER) || BUYER_USER.length === 0) {
    fail('BUYER_USER ต้องเป็น array และมีอย่างน้อย 1 user');
  }
}

/**
 * เลือก buyer จาก list
 * - round: (__VU - 1 + __ITER) % n
 * - vu:    (__VU - 1) % n   (sticky ต่อ VU)
 */
function pickBuyer() {
  const n = BUYER_USER.length;
  let idx;
  if (USER_PICK === 'vu') {
    idx = (__VU - 1) % n;
  } else {
    idx = (__VU - 1 + __ITER) % n;
  }
  const buyer = BUYER_USER[idx];
  if (!buyer || !buyer.username || !buyer.password || !buyer.loginType) {
    fail(`BUYER_USER[${idx}] ไม่ครบ username/password/loginType`);
  }
  logInfo('pickBuyer', `idx=${idx} username=${buyer.username} loginType=${buyer.loginType} pick=${USER_PICK}`);
  return { buyer, idx };
}

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function authHeaders(accessToken, serviceName, buyer) {
  const headers = {
    'Content-Type': 'application/json',
    'X-User-Type': buyer.loginType,
  };
  if (serviceName) {
    headers['X-Service-Name'] = serviceName;
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function login(buyer, opts) {
  const o = opts || {};
  const log = o.log || logInfo;
  const setupMeta = o.setupMeta || null;
  const logStep = function (action, detail, meta) {
    if (setupMeta) {
      logSetup(action, detail, Object.assign({}, setupMeta, meta || {}));
      return;
    }
    log(action, detail);
  };

  logStep('login.start', `POST ${BASE_URL}/auth/login username=${buyer.username} loginType=${buyer.loginType}`, {
    phase: 'LOGIN',
  });
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      username: buyer.username,
      password: buyer.password,
      loginType: buyer.loginType,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-User-Type': buyer.loginType,
      },
      tags: { name: 'POST /auth/login', username: buyer.username },
    }
  );
  loginDuration.add(res.timings.duration);

  const body = parseJson(res);
  const data = body && body.data ? body.data : {};
  const ok = check(res, {
    'login status 200': (r) => r.status === 200,
    'login has accessToken': () => !!data.accessToken,
    'login has entryKey': () => !!data.entryKey,
  });
  if (!ok) {
    const errDetail = formatHttpError(res, body);
    logError('login.fail', `user=${buyer.username} ${errDetail} durationMs=${res.timings.duration} body=${res.body}`);
    console.error(
      `[ERROR] hint: E2001 = user not found for username="${buyer.username}" loginType="${buyer.loginType}" on ${BASE_URL}`
    );
    if (setupMeta) {
      logSetup('login.fail', `username=${buyer.username} ${errDetail}`, Object.assign({}, setupMeta, { phase: 'LOGIN', status: 'FAIL' }));
    }
    return {
      session: null,
      error: {
        step: 'login',
        username: buyer.username,
        status: res.status,
        code: body && body.code,
        message: body && body.message,
      },
    };
  }

  logStep(
    'login.ok',
    `username=${buyer.username} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} entryKey=${maskToken(data.entryKey)} sessionId=${maskToken(data.sessionId)} accessToken=${maskToken(data.accessToken)}`,
    { phase: 'LOGIN', status: 'OK' }
  );

  return {
    session: {
      accessToken: data.accessToken,
      entryKey: data.entryKey,
      sessionId: data.sessionId || '',
      buyer,
    },
    error: null,
  };
}

function getLotBidderNumber(session, options) {
  const opts = options || {};
  const user = session.buyer.username;
  const sequential = opts.sequential === true;
  const recordChecks = opts.recordChecks !== false;
  const setupMeta = opts.setupMeta || null;

  if (!sequential) {
    console.warn(
      `[WARN]${vuTag()} lot-bidder-number called outside setup — buffer script expects setup() prep`
    );
  }

  let lastRes = null;
  let lastBody = null;
  let bidderNumber = '';

  for (let attempt = 1; attempt <= LOT_BIDDER_RETRIES; attempt++) {
    const attemptMeta = {
      phase: 'LOT-BIDDER',
      attempt: attempt,
      maxAttempts: LOT_BIDDER_RETRIES,
    };
    if (attempt > 1) {
      if (setupMeta) {
        logSetupRule();
        logSetup(
          'lot-bidder-number.retry',
          `username=${user} lotId=${LOT_ID} waitingMs=${LOT_BIDDER_RETRY_MS}`,
          Object.assign({}, setupMeta, attemptMeta, { status: 'RETRY' })
        );
      } else {
        logInfo(
          'lot-bidder-number.retry',
          `user=${user} lotId=${LOT_ID} attempt=${attempt}/${LOT_BIDDER_RETRIES} waitingMs=${LOT_BIDDER_RETRY_MS}`
        );
      }
    }

    if (setupMeta) {
      logSetup(
        'lot-bidder-number.start',
        `POST ${BASE_URL}/users/lot-bidder-number username=${user} lotId=${LOT_ID}`,
        Object.assign({}, setupMeta, attemptMeta)
      );
    } else {
      logInfo(
        'lot-bidder-number.start',
        `POST ${BASE_URL}/users/lot-bidder-number user=${user} lotId=${LOT_ID} attempt=${attempt}/${LOT_BIDDER_RETRIES}`
      );
    }
    const res = http.post(
      `${BASE_URL}/users/lot-bidder-number`,
      JSON.stringify({ lotId: Number(LOT_ID) }),
      {
        headers: authHeaders(session.accessToken, 'user-service', session.buyer),
        tags: {
          name: sequential ? 'SETUP POST /users/lot-bidder-number' : 'POST /users/lot-bidder-number',
          username: user,
        },
        timeout: `${HTTP_TIMEOUT_MS}ms`,
      }
    );
    lastRes = res;
    lastBody = parseJson(res);
    const data = lastBody && lastBody.data ? lastBody.data : null;
    bidderNumber = data && data.bidderNumber != null ? String(data.bidderNumber) : '';

    const ok = res.status === 200 && bidderNumber !== '';
    if (ok) {
      bidderDuration.add(res.timings.duration);
      if (recordChecks) {
        check(res, {
          'lot-bidder-number status 200': (r) => r.status === 200,
          'lot-bidder-number has bidderNumber': () => bidderNumber !== '',
        });
      }
      if (setupMeta) {
        logSetup(
          'lot-bidder-number.ok',
          `username=${user} lotId=${LOT_ID} bidderNumber=${bidderNumber} status=${res.status} durationMs=${res.timings.duration.toFixed(1)}`,
          Object.assign({}, setupMeta, attemptMeta, { status: 'OK' })
        );
      } else {
        logInfo(
          'lot-bidder-number.ok',
          `user=${user} lotId=${LOT_ID} bidderNumber=${bidderNumber} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} attempt=${attempt}`
        );
      }
      return bidderNumber;
    }

    if (setupMeta) {
      logSetup(
        'lot-bidder-number.fail',
        `username=${user} lotId=${LOT_ID} status=${res.status} code=${lastBody && lastBody.code} durationMs=${res.timings.duration.toFixed(1)}`,
        Object.assign({}, setupMeta, attemptMeta, { status: 'FAIL' })
      );
    } else {
      console.error(
        `[ERROR] lot-bidder-number.fail user=${user} lotId=${LOT_ID} attempt=${attempt}/${LOT_BIDDER_RETRIES} status=${res.status} code=${lastBody && lastBody.code} durationMs=${res.timings.duration} body=${res.body}`
      );
    }
    if (attempt < LOT_BIDDER_RETRIES) {
      sleep(LOT_BIDDER_RETRY_MS / 1000);
    }
  }

  if (recordChecks) {
    check(lastRes, {
      'lot-bidder-number status 200': (r) => r && r.status === 200,
      'lot-bidder-number has bidderNumber': () => bidderNumber !== '',
    });
  }
  return '';
}

function prepareLotBidderNumbers() {
  const preparedByUsername = {};
  const failedUsernames = [];
  const total = BUYER_USER.length;

  logSetupDivider('lot-bidder-number batch START');
  logSetup('batch.config', `buyers=${total} lotId=${LOT_ID} gapMs=${LOT_BIDDER_GAP_MS} retries=${LOT_BIDDER_RETRIES} httpTimeoutMs=${HTTP_TIMEOUT_MS}`, {
    phase: 'CONFIG',
  });
  logSetupRule();

  for (let i = 0; i < total; i++) {
    const buyer = BUYER_USER[i];
    const round = `${i + 1}/${total}`;
    const setupMeta = { round: round };

    logSetupDivider(`BUYER ${round} — ${buyer.username}`);

    const loginResult = login(buyer, { setupMeta: setupMeta });
    if (!loginResult.session) {
      const err = loginResult.error || {};
      failedUsernames.push(buyer.username);
      lotBidderPrepareFail.add(1);
      logSetup(
        'batch.user.result',
        `username=${buyer.username} reason=login_failed step=${err.step || 'login'} code=${err.code || '-'} message=${err.message || '-'}`,
        {
          round: round,
          phase: 'RESULT',
          status: 'FAIL',
        }
      );
      logSetupRule();
      continue;
    }

    const session = loginResult.session;
    const bidderNumber = getLotBidderNumber(session, {
      sequential: true,
      recordChecks: true,
      setupMeta: setupMeta,
    });
    if (!bidderNumber) {
      failedUsernames.push(buyer.username);
      lotBidderPrepareFail.add(1);
      logSetup('batch.user.result', `username=${buyer.username} reason=lot_bidder_failed`, {
        round: round,
        phase: 'RESULT',
        status: 'FAIL',
      });
      logSetupRule();
      continue;
    }

    preparedByUsername[buyer.username] = {
      idx: i,
      username: buyer.username,
      bidderNumber: bidderNumber,
    };
    lotBidderPrepareOk.add(1);
    logSetup('batch.user.result', `username=${buyer.username} bidderNumber=${bidderNumber}`, {
      round: round,
      phase: 'RESULT',
      status: 'OK',
    });
    logSetupRule();

    if (LOT_BIDDER_GAP_MS > 0 && i < total - 1) {
      logSetup('batch.gap', `waitingMs=${LOT_BIDDER_GAP_MS} before next buyer`, { round: round, phase: 'GAP' });
      sleep(LOT_BIDDER_GAP_MS / 1000);
    }
  }

  logSetupDivider('lot-bidder-number batch DONE');
  logSetup(
    'batch.summary',
    `ok=${Object.keys(preparedByUsername).length} fail=${failedUsernames.length} total=${total}`,
    { phase: 'SUMMARY', status: failedUsernames.length > 0 ? 'PARTIAL' : 'OK' }
  );

  if (failedUsernames.length > 0) {
    console.error(`[ERROR][SETUP] lot-bidder-number failed users: ${failedUsernames.join(', ')}`);
  }

  return {
    preparedByUsername: preparedByUsername,
    preparedCount: Object.keys(preparedByUsername).length,
    failedUsernames: failedUsernames,
  };
}

export function setup() {
  requireEnv();
  return prepareLotBidderNumbers();
}

function isJoinError(msg) {
  if (!msg || msg.type !== 'notification') return false;
  const payload = msg.payload || {};
  const level = String(payload.level || '').toLowerCase();
  const code = String(payload.code || '');
  if (level === 'error') return true;
  if (code === 'WS00043') return true;
  if (code.toLowerCase().includes('connectedincorrectly')) return true;
  return false;
}

/**
 * สร้าง WS message แบบ dynamic
 * @param {string} type
 * @param {object} [options]
 * @param {string[]} [options.lots]
 * @param {object} [options.payload]  ถ้ามีจะใส่ใต้ key payload
 * @param {object} [options.fields]   merge เข้า top-level ของ message
 */
function buildWsMessage(type, options) {
  const opts = options || {};
  const msg = { type: type };
  if (opts.lots !== undefined) {
    msg.lots = opts.lots;
  } else {
    msg.lots = [LOT_ID];
  }
  const fields = opts.fields || {};
  const fieldKeys = Object.keys(fields);
  for (let i = 0; i < fieldKeys.length; i++) {
    msg[fieldKeys[i]] = fields[fieldKeys[i]];
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'payload')) {
    msg.payload = opts.payload;
  }
  return msg;
}

/** สรุป field สำหรับ log (mask ค่า sensitive) */
function summarizeWsMessage(msg) {
  const parts = [`type=${msg.type || '-'}`];
  if (msg.lots) parts.push(`lots=[${msg.lots.join(',')}]`);
  if (msg.bidderNumber != null) parts.push(`bidderNumber=${msg.bidderNumber}`);
  if (msg.isControl != null) parts.push(`isControl=${msg.isControl}`);
  if (msg.entryKey) parts.push(`entryKey=${maskToken(msg.entryKey)}`);
  if (msg.payload) {
    if (msg.payload.entryKey) parts.push(`payload.entryKey=${maskToken(msg.payload.entryKey)}`);
    if (msg.payload.lots) parts.push(`payload.lots=[${msg.payload.lots.join(',')}]`);
    if (msg.payload.isControl != null) parts.push(`payload.isControl=${msg.payload.isControl}`);
    if (msg.payload.bidderNumber != null) parts.push(`payload.bidderNumber=${msg.payload.bidderNumber}`);
  }
  return parts.join(' ');
}

/**
 * ส่ง WS message แบบ reuse ได้
 * @param {object} socket
 * @param {object} buyer
 * @param {string} type
 * @param {object} [options]  ดู buildWsMessage + logAction
 * @returns {object} message ที่ส่งไป
 */
function sendWs(socket, buyer, type, options) {
  const opts = options || {};
  const msg = buildWsMessage(type, opts);
  const logAction = opts.logAction || `ws.${type}.send`;
  logInfo(logAction, `user=${buyer.username} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  return msg;
}

function runWebsocketVisitLot(session, bidderNumber) {
  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  if (session.sessionId) {
    headers.Cookie = `${buyer.loginType}_session_id=${session.sessionId}`;
  }

  const url = `${WS_URL}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
  logInfo(
    'ws.connect.start',
    `user=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} settleMs=${JOIN_SETTLE_MS} joinTimeoutMs=${WS_TIMEOUT_MS} holdMs=${WS_HOLD_MS}`
  );

  const started = Date.now();
  let visitSent = false;
  let joinDone = false;
  let failed = false;
  let holding = false;
  let lastError = null;

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS visitLot + hold', username: buyer.username } },
    function (socket) {

      socket.on('open', function () {
        logInfo('ws.open', `user=${buyer.username} status=connected`);

        sendWs(socket, buyer, 'visitLot', {
          lots: [LOT_ID],
          payload: {
            lots: [LOT_ID],
            isControl: false,
            entryKey: session.entryKey,
          },
        });
        visitSent = true;
        visitOk.add(1);
        check(null, { 'ws visitLot sent': () => true });

        // join สำเร็จแล้ว → ค้าง connection (ไม่ปิดทันที)
        socket.setTimeout(function () {
          if (failed || joinDone) return;
          joinDone = true;
          holding = true;
          connectedOk.add(1);
          check(null, { 'ws visitLot settled': () => true });
          logInfo(
            'ws.hold.start',
            `user=${buyer.username} lotId=${LOT_ID} holdMs=${WS_HOLD_MS} — keep connection open in system`
          );

          socket.setTimeout(function () {
            if (failed) return;
            logInfo('ws.hold.end', `user=${buyer.username} lotId=${LOT_ID} heldMs=${WS_HOLD_MS}`);
            socket.close();
          }, WS_HOLD_MS);
        }, JOIN_SETTLE_MS);
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          logInfo('ws.message.raw', `user=${buyer.username} unparsed=${String(raw).slice(0, 200)}`);
          return;
        }

        if (msg && msg.type === 'ping') {
          const pingTs = nowIso();
          logInfo('ws.ping.recv', `user=${buyer.username} ts=${pingTs} ${summarizeWsMessage(msg)}`);
          pingReceived.add(1);

          const pongMsg = buildWsMessage('pong');
          const pongTs = nowIso();
          logInfo('ws.pong.send', `user=${buyer.username} ts=${pongTs} ${summarizeWsMessage(pongMsg)}`);
          socket.send(JSON.stringify(pongMsg));
          pongSent.add(1);
          return;
        }

        if (LOG_WS_MSG) {
          const code = msg.payload && msg.payload.code ? msg.payload.code : '';
          logInfo(
            'ws.message',
            `user=${buyer.username} type=${msg.type || '-'} code=${code || '-'} holding=${holding} body=${JSON.stringify(msg).slice(0, 300)}`
          );
        }

        // error ระหว่าง join เท่านั้นที่ตัด — ช่วง hold แค่ log
        if (!joinDone && visitSent && isJoinError(msg)) {
          failed = true;
          joinDone = true;
          connectedFail.add(1);
          check(null, { 'ws visitLot settled': () => false });
          const payload = msg.payload || {};
          lastError = {
            step: 'ws_visit_lot',
            reason: 'join_notification_error',
            code: payload.code || '',
            level: payload.level || '',
            message: payload.message || '',
            detail: describeWsNotification(msg),
          };
          logError(
            'ws.visitLot.fail',
            `user=${buyer.username} lotId=${LOT_ID} ${lastError.detail} msg=${raw}`
          );
          socket.close();
        } else if (holding && isJoinError(msg)) {
          logError(
            'ws.hold.notification_error',
            `user=${buyer.username} lotId=${LOT_ID} ${describeWsNotification(msg)} msg=${raw}`
          );
        }
      });

      socket.on('error', function (e) {
        lastError = {
          step: 'ws_visit_lot',
          reason: 'socket_error',
          message: String(e),
        };
        logError('ws.socket.error', `user=${buyer.username} error=${e}`);
      });

      socket.on('close', function () {
        logInfo('ws.close', `user=${buyer.username} holdingWas=${holding} failed=${failed}`);
      });

      // timeout เฉพาะกรณียัง join ไม่สำเร็จ
      socket.setTimeout(function () {
        if (joinDone || failed) return;
        failed = true;
        connectedFail.add(1);
        check(null, { 'ws visitLot within timeout': () => false });
        lastError = {
          step: 'ws_visit_lot',
          reason: 'join_timeout',
          timeoutMs: WS_TIMEOUT_MS,
        };
        logError(
          'ws.join.timeout',
          `user=${buyer.username} lotId=${LOT_ID} timeoutMs=${WS_TIMEOUT_MS}`
        );
        socket.close();
      }, WS_TIMEOUT_MS);
    }
  );

  const elapsed = Date.now() - started;
  wsSessionDuration.add(elapsed);
  const upgraded = res && res.status === 101;
  check(res, {
    'ws status 101': (r) => r && r.status === 101,
  });
  logInfo(
    upgraded ? 'ws.session.done' : 'ws.session.fail',
    `user=${buyer.username} httpStatus=${res && res.status} durationMs=${elapsed} holdMs=${WS_HOLD_MS}`
  );

  if (!upgraded) {
    return {
      ok: false,
      error: {
        step: 'ws_visit_lot',
        reason: 'ws_upgrade_failed',
        httpStatus: res && res.status,
      },
    };
  }
  if (failed && lastError) {
    return { ok: false, error: lastError };
  }
  if (failed) {
    return {
      ok: false,
      error: { step: 'ws_visit_lot', reason: 'unknown' },
    };
  }
  return { ok: true, error: null };
}

export default function (setupData) {
  requireEnv();

  logInfo(
    'iteration.start',
    `baseUrl=${BASE_URL} wsUrl=${WS_URL} lotId=${LOT_ID} buyerCount=${BUYER_USER.length} vus=${VUS} executor=${EXECUTOR} userPick=${USER_PICK} prepared=${setupData && setupData.preparedCount}`
  );

  const { buyer, idx } = pickBuyer();
  const prepared =
    setupData && setupData.preparedByUsername ? setupData.preparedByUsername[buyer.username] : null;

  if (!prepared || !prepared.bidderNumber) {
    fail(
      `ไม่มี prepared lot-bidder-number สำหรับ user=${buyer.username} — ตรวจ setup log (failed=${setupData && setupData.failedUsernames ? setupData.failedUsernames.join(',') : '-'})`
    );
  }

  let session;
  let loginError = null;
  const bidderNumber = prepared.bidderNumber;

  group(`1. login (${buyer.username} #${idx})`, () => {
    const loginResult = login(buyer);
    session = loginResult.session;
    loginError = loginResult.error;
  });
  if (!session) {
    const err = loginError || {};
    logError(
      'iteration.abort',
      `step=${err.step || 'login'} reason=login_failed user=${buyer.username} status=${err.status || '-'} code=${err.code || '-'} message=${err.message || '-'}`
    );
    sleep(1);
    return;
  }

  group(`2. lot-bidder-number prepared (${buyer.username})`, () => {
    const preparedOk = bidderNumber !== '';
    const userMatch = prepared.username === buyer.username;
    if (!preparedOk) {
      logError(
        'lot-bidder-number.prepared_fail',
        `user=${buyer.username} reason=empty_bidder_number lotId=${LOT_ID} source=setup`
      );
    }
    if (!userMatch) {
      logError(
        'lot-bidder-number.prepared_fail',
        `user=${buyer.username} reason=username_mismatch expected=${prepared.username} got=${buyer.username}`
      );
    }
    check(null, {
      'lot-bidder-number prepared': () => preparedOk,
      'lot-bidder-number matches user': () => userMatch,
    });
    if (!preparedOk || !userMatch) {
      logError(
        'iteration.abort',
        `step=lot_bidder_prepared reason=${!preparedOk ? 'empty_bidder_number' : 'username_mismatch'} user=${buyer.username} lotId=${LOT_ID}`
      );
      sleep(1);
      return;
    }
    logInfo(
      'lot-bidder-number.use_prepared',
      `user=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber} source=setup`
    );
  });
  if (!bidderNumber || prepared.username !== buyer.username) {
    return;
  }

  let wsResult;
  group(`3. WS visitLot (${buyer.username})`, () => {
    wsResult = runWebsocketVisitLot(session, bidderNumber);
  });
  if (wsResult && !wsResult.ok) {
    const err = wsResult.error || {};
    logError(
      'iteration.abort',
      `step=${err.step || 'ws_visit_lot'} reason=${err.reason || 'unknown'} user=${buyer.username} lotId=${LOT_ID} code=${err.code || '-'} message=${err.message || err.detail || '-'} httpStatus=${err.httpStatus || '-'}`
    );
    sleep(1);
    return;
  }

  logInfo('iteration.done', `user=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber}`);
  sleep(1);
}

export const handleSummary = createHandleSummary(function () {
  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 login → lot-bidder (setup) → visitLot',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'buyer-visit-lot-buffer',
    meta: {
      baseUrl: BASE_URL,
      wsUrl: WS_URL,
      lotId: LOT_ID,
      vus: VUS,
      executor: EXECUTOR,
      userPick: USER_PICK,
      startLoopIndex: START_LOOP_INDEX,
      endLoopIndex: END_LOOP_INDEX,
      usernamePrefix: USERNAME_PREFIX,
      buyerCount: BUYER_USER.length,
      buyers: BUYER_USER.map(function (u) {
        return u.username;
      }),
      wsHoldMs: WS_HOLD_MS,
      joinSettleMs: JOIN_SETTLE_MS,
      lotBidderGapMs: LOT_BIDDER_GAP_MS,
      lotBidderRetries: LOT_BIDDER_RETRIES,
      lotBidderRetryMs: LOT_BIDDER_RETRY_MS,
      httpTimeoutMs: HTTP_TIMEOUT_MS,
      setupTimeout: SETUP_TIMEOUT,
      lotBidderPrepareMode: 'setup-sequential',
    },
  };
});
