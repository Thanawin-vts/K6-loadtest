/**
 * k6 — buffer-2
 * setup (sequential per user):
 *   login → lot-bidder-number → WS visitLot → connected → settle → close
 * VU (parallel):
 *   login → WS rejoin (visitLot → connected) → bidding
 *
 * หมายเหตุ: k6 ส่ง WebSocket socket จาก setup() ไป VU ไม่ได้
 * จึง join ใน setup เป็น buffer ทีละคน แล้ว VU ต้อง rejoin บน connection ใหม่ก่อน bidding
 *
 * รันตัวอย่าง:
 *   ./buyer-send-bidding-buffer-2-script.sh 975 <lotLineId> 1 5m 1 10 loadtestuser 1 500
 *
 * ตัวแปรเสริม:
 *   LOT_LINE_ID, AUCTION_NO, BIDDING_EVENT, BIDDING_ACTION
 *   BIDDING=true|false, ACK=true|false
 *   STAGGER_MS, ACK_TIMEOUT_MS, ACK_RETRY_MS, ACK_COOLDOWN_MS, ACK_TICK_MS
 *   BIDDING_INTERVAL_MS, BIDDING_DELAY_MS
 *   LOT_BIDDER_GAP_MS, LOT_BIDDER_RETRIES, LOT_BIDDER_RETRY_MS, HTTP_TIMEOUT_MS
 *   WS_JOIN_GAP_MS       # รอระหว่าง user หลัง setup join (default = LOT_BIDDER_GAP_MS)
 *   WS_REJOIN_STAGGER_MS  # รอก่อน VU rejoin = (VU-1)*ms (default 200) — ลด connection storm
 *   WS_RECONNECT=true     # remote_close/error แล้ว reconnect จนครบ WS_HOLD wall-clock
 *   WS_RECONNECT_DELAY_MS # รอค่อน reconnect (default 1000)
 *   WS_RECONNECT_MAX      # 0 = ไม่จำกัดจนหมด hold (default 0)
 *   SETUP_TIMEOUT=30m, WS_HOLD, JOIN_SETTLE_MS, LOG_WS_MSG, REPORT_DIR, REPORT_BASENAME
 *   VU complete JSON: {REPORT_DIR}/{REPORT_BASENAME}-vu-complete.json
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import encoding from 'k6/encoding';
import { createHandleSummary } from '../../lib/k6-report.js';
import { getMockBuyer } from '../../buyer-mock-user.js';

const VU_COMPLETE_CHECK_PREFIX = '__vu_complete__';

const loginDuration = new Trend('login_duration_ms');
const bidderDuration = new Trend('lot_bidder_number_duration_ms');
const wsSessionDuration = new Trend('ws_session_duration_ms');
const visitOk = new Counter('visit_lot_ok');
const connectedOk = new Counter('connected_ok');
const connectedFail = new Counter('connected_fail');
const pingReceived = new Counter('ws_ping_received');
const pongSent = new Counter('ws_pong_sent');
const biddingSent = new Counter('ws_bidding_sent');
const ackOk = new Counter('ws_ack_ok');
const ackRetry = new Counter('ws_ack_retry');
const ackTimeout = new Counter('ws_ack_timeout');
const lotBidderPrepareOk = new Counter('lot_bidder_prepare_ok');
const lotBidderPrepareFail = new Counter('lot_bidder_prepare_fail');
const wsJoinPrepareOk = new Counter('ws_join_prepare_ok');
const wsJoinPrepareFail = new Counter('ws_join_prepare_fail');
const wsJoinPrepareDuration = new Trend('ws_join_prepare_duration_ms');
const wsReconnect = new Counter('ws_reconnect');
const wsReconnectGaveUp = new Counter('ws_reconnect_gave_up');

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
const LOT_LINE_ID = Number(__ENV.LOT_LINE_ID || 10360);
const AUCTION_NO = Number(__ENV.AUCTION_NO || 1);
const BIDDING_EVENT = String(__ENV.BIDDING_EVENT || 'online');
const BIDDING_ACTION = String(__ENV.BIDDING_ACTION || 'bid');
const BIDDING_INTERVAL_MS = Number(__ENV.BIDDING_INTERVAL_MS || 1000);
const BIDDING_DELAY_MS = Number(__ENV.BIDDING_DELAY_MS || 0);
const BIDDING_ENABLED = String(__ENV.BIDDING || 'true').toLowerCase() !== 'false';
const LOG_WS_MSG = String(__ENV.LOG_WS_MSG || 'false').toLowerCase() === 'true';

function envFlag(name, defaultValue) {
  const raw = __ENV[name];
  if (raw == null || raw === '') return defaultValue;
  const s = String(raw).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return defaultValue;
}

const ACK_ENABLED = envFlag('ACK', true);
const STAGGER_MS = Number(__ENV.STAGGER_MS || 250);
const ACK_TIMEOUT_MS = Number(__ENV.ACK_TIMEOUT_MS || 2000);
const ACK_RETRY_MS = Number(__ENV.ACK_RETRY_MS || 400);
const ACK_COOLDOWN_MS = Number(__ENV.ACK_COOLDOWN_MS || 800);
const ACK_TICK_MS = Number(__ENV.ACK_TICK_MS || 50);

function biddingGapMs() {
  if (!ACK_ENABLED) {
    return BIDDING_DELAY_MS > 0 ? BIDDING_DELAY_MS : BIDDING_INTERVAL_MS;
  }
  return ACK_COOLDOWN_MS + BIDDING_DELAY_MS;
}
const LOT_BIDDER_GAP_MS = Number(__ENV.LOT_BIDDER_GAP_MS || 0);
const LOT_BIDDER_RETRIES = Number(__ENV.LOT_BIDDER_RETRIES || 3);
const LOT_BIDDER_RETRY_MS = Number(__ENV.LOT_BIDDER_RETRY_MS || 500);
const HTTP_TIMEOUT_MS = Number(__ENV.HTTP_TIMEOUT_MS || 15000);
const WS_JOIN_GAP_MS = Number(
  __ENV.WS_JOIN_GAP_MS != null && __ENV.WS_JOIN_GAP_MS !== '' ? __ENV.WS_JOIN_GAP_MS : LOT_BIDDER_GAP_MS
);
const WS_REJOIN_STAGGER_MS = Number(__ENV.WS_REJOIN_STAGGER_MS || 200);
const WS_RECONNECT_ENABLED = envFlag('WS_RECONNECT', true);
const WS_RECONNECT_DELAY_MS = Number(__ENV.WS_RECONNECT_DELAY_MS || 1000);
const WS_RECONNECT_MAX = Number(__ENV.WS_RECONNECT_MAX || 0); // 0 = unlimited until hold deadline

function msToDuration(ms) {
  const n = Math.max(1, Math.ceil(Number(ms) || 0));
  if (n >= 3600000 && n % 3600000 === 0) return `${n / 3600000}h`;
  if (n >= 60000 && n % 60000 === 0) return `${n / 60000}m`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

const SETUP_UNLIMITED_MS = 24 * 60 * 60 * 1000;

function resolveSetupTimeout() {
  const raw = String(__ENV.SETUP_TIMEOUT || __ENV.SETUP_TIMEOUT_MS || '0').trim();
  if (['0', '0s', '0ms', 'unlimited', 'none', 'inf', 'infinite'].includes(raw.toLowerCase())) {
    return '24h';
  }
  return msToDuration(parseDurationMs(raw, SETUP_UNLIMITED_MS));
}

const SETUP_TIMEOUT = resolveSetupTimeout();

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

// ค้าง WS หลัง join สำเร็จ — default 30 นาที
const WS_HOLD_MS = parseDurationMs(__ENV.WS_HOLD_MS || __ENV.WS_HOLD || '30m', 30 * 60 * 1000);
const REJOIN_STAGGER_BUDGET_MS = Math.max(0, (Math.max(1, VUS) - 1) * Math.max(0, WS_REJOIN_STAGGER_MS));
const MAX_DURATION =
  __ENV.MAX_DURATION ||
  `${Math.max(
    2,
    Math.ceil((WS_HOLD_MS + WS_TIMEOUT_MS + REJOIN_STAGGER_BUDGET_MS + 120000) / 60000)
  )}m`;

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

function newVuCompleteRecord() {
  const { vu, iter } = vuContext();
  return {
    vu: vu,
    iter: iter,
    username: '',
    step: 'unknown',
    error: '',
    outcome: 'error',
    at: nowIso(),
  };
}

function formatVuCompleteError(err) {
  if (err == null || err === '') return '';
  if (typeof err === 'string') return err.slice(0, 500);
  const parts = [];
  if (err.reason) parts.push(String(err.reason));
  if (err.code) parts.push('code=' + err.code);
  if (err.message) parts.push(String(err.message));
  if (err.detail && String(err.detail) !== String(err.message || '')) parts.push(String(err.detail));
  if (err.httpStatus != null) parts.push('httpStatus=' + err.httpStatus);
  if (err.timeoutMs != null) parts.push('timeoutMs=' + err.timeoutMs);
  return parts.join(' ').slice(0, 500);
}

function recordVuComplete(rec) {
  const row = {
    vu: rec && rec.vu != null ? rec.vu : 0,
    iter: rec && rec.iter != null ? rec.iter : 0,
    username: rec && rec.username ? String(rec.username) : '',
    step: rec && rec.step ? String(rec.step) : 'unknown',
    error: rec && rec.error ? String(rec.error) : '',
    outcome: rec && rec.outcome === 'ok' ? 'ok' : 'error',
    at: rec && rec.at ? rec.at : nowIso(),
  };
  const line = `username=${row.username || '-'} vu=${row.vu} iter=${row.iter} step=${row.step} outcome=${row.outcome} error=${row.error || '-'}`;
  if (row.outcome === 'ok') {
    logInfo('vu.complete', line);
  } else {
    logError('vu.complete', line);
  }
  check(null, {
    [VU_COMPLETE_CHECK_PREFIX + encoding.b64encode(JSON.stringify(row))]: () => true,
  });
}

function collectGroupChecks(group, out) {
  if (!group) return;
  const checks = group.checks || [];
  for (let i = 0; i < checks.length; i++) {
    out.push(checks[i]);
  }
  const groups = group.groups || [];
  for (let j = 0; j < groups.length; j++) {
    collectGroupChecks(groups[j], out);
  }
}

function extractVuCompletions(summaryData) {
  const checks = [];
  collectGroupChecks(summaryData && summaryData.root_group, checks);
  const items = [];
  const seen = {};
  for (let i = 0; i < checks.length; i++) {
    const name = checks[i] && checks[i].name ? String(checks[i].name) : '';
    if (name.indexOf(VU_COMPLETE_CHECK_PREFIX) !== 0) continue;
    const b64 = name.slice(VU_COMPLETE_CHECK_PREFIX.length);
    let parsed = null;
    try {
      parsed = JSON.parse(encoding.b64decode(b64, 'std', 's'));
    } catch (_) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const key = [parsed.vu, parsed.iter, parsed.username, parsed.step, parsed.at].join('|');
    if (seen[key]) continue;
    seen[key] = true;
    items.push({
      vu: parsed.vu,
      iter: parsed.iter,
      username: parsed.username || '',
      step: parsed.step || 'unknown',
      error: parsed.error || '',
      outcome: parsed.outcome || 'error',
      at: parsed.at || '',
    });
  }
  items.sort(function (a, b) {
    const ua = String(a.username || '');
    const ub = String(b.username || '');
    if (ua < ub) return -1;
    if (ua > ub) return 1;
    const va = Number(a.vu) || 0;
    const vb = Number(b.vu) || 0;
    if (va !== vb) return va - vb;
    return (Number(a.iter) || 0) - (Number(b.iter) || 0);
  });
  return items;
}

function formatVuCompleteStdout(items) {
  const rows = items || [];
  const lines = [];
  lines.push('');
  lines.push('VU complete (' + rows.length + ') — sorted by username');
  lines.push('username                      vu   step                         outcome  error');
  lines.push('--------------------------------------------------------------------------------');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const username = String(r.username || '-').padEnd(28);
    const vu = String(r.vu).padStart(4);
    const step = String(r.step || '-').padEnd(28);
    const outcome = String(r.outcome || '-').padEnd(8);
    lines.push(username + ' ' + vu + '  ' + step + ' ' + outcome + ' ' + (r.error || '-'));
  }
  lines.push('');
  return lines.join('\n');
}

function vuCompleteJsonPath() {
  const reportDir = (__ENV.REPORT_DIR || 'k6-reports').replace(/\/$/, '');
  const basename = __ENV.REPORT_BASENAME || 'buyer-send-bidding-buffer-2';
  return __ENV.VU_COMPLETE_JSON || reportDir + '/' + basename + '-vu-complete.json';
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
    buyer_send_bidding: buildScenario(),
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
  if (BIDDING_ENABLED) {
    if (!Number.isFinite(LOT_LINE_ID) || LOT_LINE_ID <= 0) {
      fail(`ขาด/ผิด env: LOT_LINE_ID — ตัวอย่าง: -e LOT_LINE_ID=10360`);
    }
    if (!Number.isFinite(AUCTION_NO) || AUCTION_NO <= 0) {
      fail(`ขาด/ผิด env: AUCTION_NO — ตัวอย่าง: -e AUCTION_NO=1`);
    }
    if (ACK_ENABLED) {
      if (!Number.isFinite(STAGGER_MS) || STAGGER_MS < 0) {
        fail(`ผิด env: STAGGER_MS ต้องเป็นจำนวน >= 0 (ms)`);
      }
      if (!Number.isFinite(ACK_TIMEOUT_MS) || ACK_TIMEOUT_MS <= 0) {
        fail(`ผิด env: ACK_TIMEOUT_MS ต้องเป็นจำนวนบวก (ms)`);
      }
      if (!Number.isFinite(ACK_RETRY_MS) || ACK_RETRY_MS < 0) {
        fail(`ผิด env: ACK_RETRY_MS ต้องเป็นจำนวน >= 0 (ms)`);
      }
      if (!Number.isFinite(ACK_COOLDOWN_MS) || ACK_COOLDOWN_MS < 0) {
        fail(`ผิด env: ACK_COOLDOWN_MS ต้องเป็นจำนวน >= 0 (ms)`);
      }
      if (!Number.isFinite(ACK_TICK_MS) || ACK_TICK_MS <= 0) {
        fail(`ผิด env: ACK_TICK_MS ต้องเป็นจำนวนบวก (ms)`);
      }
    } else if (!Number.isFinite(BIDDING_INTERVAL_MS) || BIDDING_INTERVAL_MS <= 0) {
      fail(`ผิด env: BIDDING_INTERVAL_MS ต้องเป็นจำนวนบวก (ms)`);
    }
  }
  if (!Number.isFinite(WS_REJOIN_STAGGER_MS) || WS_REJOIN_STAGGER_MS < 0) {
    fail(`ผิด env: WS_REJOIN_STAGGER_MS ต้องเป็นจำนวน >= 0 (ms)`);
  }
  if (!Number.isFinite(WS_RECONNECT_DELAY_MS) || WS_RECONNECT_DELAY_MS < 0) {
    fail(`ผิด env: WS_RECONNECT_DELAY_MS ต้องเป็นจำนวน >= 0 (ms)`);
  }
  if (!Number.isFinite(WS_RECONNECT_MAX) || WS_RECONNECT_MAX < 0) {
    fail(`ผิด env: WS_RECONNECT_MAX ต้องเป็นจำนวน >= 0 (0 = unlimited)`);
  }
}

/** รอจนถึงขอบ interval ถัดไปของ wall-clock เพื่อให้ทุก VU ส่งพร้อมกัน */
function msUntilNextAlignedTick(intervalMs) {
  const now = Date.now();
  const rem = now % intervalMs;
  return rem === 0 ? 0 : intervalMs - rem;
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

  logSetupDivider('lot-bidder + WS join batch START');
  logSetup(
    'batch.config',
    `buyers=${total} lotId=${LOT_ID} gapMs=${LOT_BIDDER_GAP_MS} joinGapMs=${WS_JOIN_GAP_MS} retries=${LOT_BIDDER_RETRIES} httpTimeoutMs=${HTTP_TIMEOUT_MS} settleMs=${JOIN_SETTLE_MS}`,
    {
      phase: 'CONFIG',
    }
  );
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

    lotBidderPrepareOk.add(1);

    const joinResult = runWebsocketJoinSetup(session, bidderNumber, { setupMeta: setupMeta });
    if (!joinResult.ok) {
      const err = joinResult.error || {};
      failedUsernames.push(buyer.username);
      wsJoinPrepareFail.add(1);
      logSetup(
        'batch.user.result',
        `username=${buyer.username} reason=ws_join_failed step=${err.step || 'ws_join_setup'} code=${err.code || '-'} message=${err.message || err.detail || err.reason || '-'}`,
        {
          round: round,
          phase: 'RESULT',
          status: 'FAIL',
        }
      );
      logSetupRule();
      continue;
    }

    wsJoinPrepareOk.add(1);
    preparedByUsername[buyer.username] = {
      idx: i,
      username: buyer.username,
      bidderNumber: bidderNumber,
      joinOk: true,
      joinDurationMs: joinResult.durationMs || 0,
    };
    logSetup(
      'batch.user.result',
      `username=${buyer.username} bidderNumber=${bidderNumber} joinOk=true joinMs=${joinResult.durationMs || 0}`,
      {
        round: round,
        phase: 'RESULT',
        status: 'OK',
      }
    );
    logSetupRule();

    const gapMs = WS_JOIN_GAP_MS > 0 ? WS_JOIN_GAP_MS : LOT_BIDDER_GAP_MS;
    if (gapMs > 0 && i < total - 1) {
      logSetup('batch.gap', `waitingMs=${gapMs} before next buyer`, { round: round, phase: 'GAP' });
      sleep(gapMs / 1000);
    }
  }

  logSetupDivider('lot-bidder + WS join batch DONE');
  logSetup(
    'batch.summary',
    `ok=${Object.keys(preparedByUsername).length} fail=${failedUsernames.length} total=${total}`,
    { phase: 'SUMMARY', status: failedUsernames.length > 0 ? 'PARTIAL' : 'OK' }
  );

  if (failedUsernames.length > 0) {
    console.error(`[ERROR][SETUP] lot-bidder/ws-join failed users: ${failedUsernames.join(', ')}`);
  }

  return {
    preparedByUsername: preparedByUsername,
    preparedCount: Object.keys(preparedByUsername).length,
    failedUsernames: failedUsernames,
    prepareMode: 'setup-sequential-lot-bidder-and-ws-join',
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

function msgCode(msg) {
  const payload = msg && msg.payload ? msg.payload : {};
  return String(payload.code || '');
}

function isAckExpectedError(code) {
  return (
    code === 'E5002' ||
    code === 'E5013' ||
    code === 'WS20003' ||
    code === 'WS20005' ||
    code === 'WS20009' ||
    code === 'WS20010' ||
    code === 'WS20012' ||
    code === 'WS40002' ||
    code === 'WS40003' ||
    code === 'WS40004'
  );
}


function bidBlockedStatus(status) {
  return (
    status === 'pause' ||
    status === 'sold' ||
    status === 'pass' ||
    status === 'hold' ||
    status === 'waiting' ||
    status === 'pending' ||
    status === 'ready'
  );
}

function isOwnBidder(payload, bidderNumber) {
  const p = payload || {};
  if (bidderNumber && String(p.bidderNumber || '') === String(bidderNumber)) return true;
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
  } else if (type !== 'pong') {
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
    if (msg.payload.action != null) parts.push(`payload.action=${msg.payload.action}`);
    if (msg.payload.lotLineId != null) parts.push(`payload.lotLineId=${msg.payload.lotLineId}`);
    if (msg.payload.auctionNo != null) parts.push(`payload.auctionNo=${msg.payload.auctionNo}`);
    if (msg.payload.event != null) parts.push(`payload.event=${msg.payload.event}`);
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

function sendOffer(socket, buyer, bidderNumber, reason) {
  const msg = buildWsMessage('bidding', {
    lots: [LOT_ID],
    payload: {
      action: BIDDING_ACTION,
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      event: BIDDING_EVENT,
      bidderNumber: String(bidderNumber),
    },
  });
  const ts = nowIso();
  const reasonStr = reason ? ` reason=${reason}` : '';
  logInfo('ws.bidding.send', `user=${buyer.username}${reasonStr} ts=${ts} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  biddingSent.add(1);
  return msg;
}

/**
 * setup-only: WS visitLot → connected → settle → close (ไม่มี bidding)
 * ใช้ buffer ทีละ user ใน setup() — socket เก็บข้ามไป VU ไม่ได้
 */
function runWebsocketJoinSetup(session, bidderNumber, opts) {
  const o = opts || {};
  const setupMeta = o.setupMeta || null;
  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  if (session.sessionId) {
    headers.Cookie = `${buyer.loginType}_session_id=${session.sessionId}`;
  }

  const url = `${WS_URL}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
  const started = Date.now();
  let visitSent = false;
  let connectedSent = false;
  let connectedDone = false;
  let failed = false;
  let lastError = null;

  const logJoin = function (action, detail, meta) {
    if (setupMeta) {
      logSetup(action, detail, Object.assign({}, setupMeta, meta || {}));
      return;
    }
    logInfo(action, detail);
  };

  logJoin(
    'ws.join.setup.start',
    `username=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} settleMs=${JOIN_SETTLE_MS} joinTimeoutMs=${WS_TIMEOUT_MS}`,
    { phase: 'WS-JOIN' }
  );

  const res = ws.connect(
    url,
    { headers, tags: { name: 'SETUP WS visitLot → connected', username: buyer.username } },
    function (socket) {
      socket.on('open', function () {
        logJoin('ws.join.setup.open', `username=${buyer.username}`, { phase: 'WS-JOIN' });

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

        sendWs(socket, buyer, 'connected', {
          lots: [LOT_ID],
          fields: {
            isControl: false,
            entryKey: session.entryKey,
            bidderNumber: bidderNumber,
          },
        });
        connectedSent = true;

        socket.setTimeout(function () {
          if (failed || connectedDone) return;
          connectedDone = true;
          connectedOk.add(1);
          logJoin(
            'ws.join.setup.settled',
            `username=${buyer.username} lotId=${LOT_ID} elapsedMs=${Date.now() - started}`,
            { phase: 'WS-JOIN', status: 'OK' }
          );
          socket.close();
        }, JOIN_SETTLE_MS);
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          return;
        }

        if (msg && msg.type === 'ping') {
          pingReceived.add(1);
          socket.send(JSON.stringify(buildWsMessage('pong')));
          pongSent.add(1);
          return;
        }

        if (!connectedDone && (visitSent || connectedSent) && isJoinError(msg)) {
          failed = true;
          connectedDone = true;
          connectedFail.add(1);
          const payload = msg.payload || {};
          lastError = {
            step: 'ws_join_setup',
            reason: 'join_notification_error',
            code: payload.code || '',
            level: payload.level || '',
            message: payload.message || '',
            detail: describeWsNotification(msg),
          };
          logSetup(
            'ws.join.setup.fail',
            `username=${buyer.username} lotId=${LOT_ID} ${lastError.detail}`,
            Object.assign({}, setupMeta || {}, { phase: 'WS-JOIN', status: 'FAIL' })
          );
          socket.close();
        }
      });

      socket.on('error', function (e) {
        lastError = {
          step: 'ws_join_setup',
          reason: 'socket_error',
          message: String(e),
        };
        logSetup(
          'ws.join.setup.error',
          `username=${buyer.username} error=${e}`,
          Object.assign({}, setupMeta || {}, { phase: 'WS-JOIN', status: 'FAIL' })
        );
      });

      socket.setTimeout(function () {
        if (connectedDone || failed) return;
        failed = true;
        connectedFail.add(1);
        lastError = {
          step: 'ws_join_setup',
          reason: 'join_timeout',
          timeoutMs: WS_TIMEOUT_MS,
        };
        logSetup(
          'ws.join.setup.timeout',
          `username=${buyer.username} lotId=${LOT_ID} timeoutMs=${WS_TIMEOUT_MS}`,
          Object.assign({}, setupMeta || {}, { phase: 'WS-JOIN', status: 'FAIL' })
        );
        socket.close();
      }, WS_TIMEOUT_MS);
    }
  );

  const elapsed = Date.now() - started;
  wsJoinPrepareDuration.add(elapsed);
  const upgraded = res && res.status === 101;
  const ok = upgraded && connectedDone && !failed;

  if (!upgraded) {
    return {
      ok: false,
      error: {
        step: 'ws_join_setup',
        reason: 'ws_upgrade_failed',
        httpStatus: res && res.status,
      },
    };
  }
  if (failed && lastError) {
    return { ok: false, error: lastError };
  }
  if (!ok) {
    return {
      ok: false,
      error: { step: 'ws_join_setup', reason: 'join_not_settled' },
    };
  }
  return { ok: true, error: null, durationMs: elapsed };
}

function runWebsocketVisitConnected(session, bidderNumber, opts) {
  const o = opts || {};
  const holdMs = Number.isFinite(o.holdMs) && o.holdMs > 0 ? Math.floor(o.holdMs) : WS_HOLD_MS;
  const attempt = Number(o.attempt) || 1;
  const biddingStaggerMs =
    o.biddingStaggerMs != null ? Math.max(0, Number(o.biddingStaggerMs)) : Math.max(0, (__VU - 1) * STAGGER_MS);

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
    `user=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} mode=rejoin attempt=${attempt} settleMs=${JOIN_SETTLE_MS} joinTimeoutMs=${WS_TIMEOUT_MS} holdMs=${holdMs} bidding=${BIDDING_ENABLED} ack=${ACK_ENABLED} biddingStaggerMs=${biddingStaggerMs} biddingIntervalMs=${BIDDING_INTERVAL_MS} biddingDelayMs=${BIDDING_DELAY_MS}`
  );

  const started = Date.now();
  let visitSent = false;
  let connectedSent = false;
  let connectedDone = false;
  let failed = false;
  let holding = false;
  let holdTimerFired = false;
  let reachedHolding = false;
  let lastError = null;
  const ack = {
    pending: false,
    phase: 'bidding',
    retryAt: 0,
    lastBidBidderNumber: '',
    lastAuctionStatus: '',
    ackGen: 0,
  };

  function switchPhase(next, reason) {
    if (ack.phase === next) return;
    logInfo('ws.ack.phase', `user=${buyer.username} ${ack.phase} → ${next} reason=${reason}`);
    ack.phase = next;
  }

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS rejoin → bidding', username: buyer.username } },
    function (socket) {
      function armAckTimeout() {
        const gen = ++ack.ackGen;
        socket.setTimeout(function () {
          if (gen !== ack.ackGen || !ack.pending || !holding || failed) return;
          ack.pending = false;
          ack.retryAt = Date.now() + ACK_RETRY_MS;
          ackTimeout.add(1);
          logInfo(
            'ws.ack.timeout',
            `user=${buyer.username} phase=${ack.phase} timeoutMs=${ACK_TIMEOUT_MS} retryInMs=${ACK_RETRY_MS}`
          );
        }, ACK_TIMEOUT_MS);
      }

      function trySendAck() {
        if (!holding || failed || ack.pending || ack.phase === 'idle') return;
        if (Date.now() < ack.retryAt) return;
        if (bidBlockedStatus(ack.lastAuctionStatus)) return;
        if (bidderNumber && ack.lastBidBidderNumber && ack.lastBidBidderNumber === String(bidderNumber)) return;

        ack.pending = true;
        ack.ackGen += 1;
        sendOffer(socket, buyer, bidderNumber, 'ack');
        armAckTimeout();
      }

      // k6 socket.setTimeout rejects delay <= 0 (VU 1 stagger is 0 by design).
      function schedule(fn, delayMs) {
        const ms = Number(delayMs);
        if (!Number.isFinite(ms) || ms <= 0) {
          fn();
          return;
        }
        socket.setTimeout(fn, ms);
      }

      // Must register setInterval in the connect callback (not inside setTimeout).
      // Nested setInterval never ticks — that is why offer ran once then stopped.
      let ackReadyAt = Number.POSITIVE_INFINITY;
      if (ACK_ENABLED && BIDDING_ENABLED) {
        socket.setInterval(function () {
          if (!holding || failed) return;
          if (Date.now() < ackReadyAt) return;
          trySendAck();
        }, ACK_TICK_MS);
      }

      function startAckLoop() {
        ackReadyAt = Date.now() + biddingStaggerMs;
        logInfo(
          'ws.ack.loop.start',
          `user=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${BIDDING_EVENT} action=${BIDDING_ACTION} bidderNumber=${bidderNumber} attempt=${attempt} staggerMs=${biddingStaggerMs} timeoutMs=${ACK_TIMEOUT_MS} retryMs=${ACK_RETRY_MS} cooldownMs=${ACK_COOLDOWN_MS} biddingDelayMs=${BIDDING_DELAY_MS} gapMs=${biddingGapMs()} holdMs=${holdMs}`
        );
        if (biddingStaggerMs <= 0) trySendAck();
      }

      function startAlignedBiddingLoop() {
        const gapMs = biddingGapMs();
        const alignMs = msUntilNextAlignedTick(gapMs);
        logInfo(
          'ws.bidding.loop.start',
          `user=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${BIDDING_EVENT} bidderNumber=${bidderNumber} attempt=${attempt} intervalMs=${BIDDING_INTERVAL_MS} biddingDelayMs=${BIDDING_DELAY_MS} gapMs=${gapMs} alignMs=${alignMs} holdMs=${holdMs}`
        );
        function tick() {
          if (failed || !holding) return;
          sendOffer(socket, buyer, bidderNumber, 'interval');
          socket.setTimeout(tick, gapMs);
        }
        schedule(tick, alignMs);
      }

      function handleAckMessage(msg) {
        const type = msg && msg.type ? msg.type : '';
        const payload = msg && msg.payload ? msg.payload : {};
        const code = msgCode(msg);

        if (type === 'bidInfo') {
          ack.lastBidBidderNumber = String(payload.bidderNumber || '');
          ack.lastAuctionStatus = String(payload.auctionStatus || '');
          return;
        }

        const isNotif = type === 'notification';
        const isBroadcast = type === 'broadcastBuyer' || type === 'broadcastSeller';
        if (!isNotif && !isBroadcast) return;

        if (code === 'WS40005' || (code === 'WS40001' && isOwnBidder(payload, bidderNumber))) {
          ack.pending = false;
          ack.ackGen += 1;
          ack.lastBidBidderNumber = String(payload.bidderNumber || bidderNumber || '');
          ack.retryAt = Date.now() + biddingGapMs();
          ackOk.add(1);
          logInfo('ws.ack.ok', `user=${buyer.username} code=${code} phase=${ack.phase}`);
          return;
        }

        if (code === 'WS20001' && isOwnBidder(payload, bidderNumber)) {
          ack.pending = false;
          ack.ackGen += 1;
          ack.lastBidBidderNumber = String(payload.bidderNumber || bidderNumber || '');
          ack.retryAt = Date.now() + biddingGapMs();
          ackOk.add(1);
          logInfo('ws.ack.ok', `user=${buyer.username} code=${code} phase=${ack.phase}`);
          return;
        }

        if (!ack.pending && !isAckExpectedError(code)) return;

        if (code === 'E5002') {
          ack.pending = false;
          ack.ackGen += 1;
          ack.retryAt = Date.now() + ACK_RETRY_MS;
          ackRetry.add(1);
          logInfo('ws.ack.retry', `user=${buyer.username} code=E5002 waitMs=${ACK_RETRY_MS} phase=${ack.phase}`);
          return;
        }

        if (code === 'E5013') {
          ack.pending = false;
          ack.ackGen += 1;
          ack.retryAt = Date.now() + ACK_RETRY_MS;
          ackRetry.add(1);
          logInfo('ws.ack.retry', `user=${buyer.username} code=E5013 waitMs=${ACK_RETRY_MS} phase=${ack.phase}`);
          return;
        }

        if (code === 'WS20003') {
          ack.pending = false;
          ack.ackGen += 1;
          ack.lastBidBidderNumber = String(bidderNumber || payload.bidderNumber || '');
          ack.retryAt = Date.now() + biddingGapMs();
          logInfo('ws.ack.self', `user=${buyer.username} code=WS20003 waitMs=${biddingGapMs()}`);
          return;
        }

        if (isAckExpectedError(code)) {
          ack.pending = false;
          ack.ackGen += 1;
          ack.retryAt = Date.now() + ACK_RETRY_MS;
          ackRetry.add(1);
          logInfo('ws.ack.retry', `user=${buyer.username} code=${code} waitMs=${ACK_RETRY_MS} phase=${ack.phase}`);
        }
      }

      socket.on('open', function () {
        logInfo('ws.open', `user=${buyer.username} status=connected attempt=${attempt}`);

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

        sendWs(socket, buyer, 'connected', {
          lots: [LOT_ID],
          fields: {
            isControl: false,
            entryKey: session.entryKey,
            bidderNumber: bidderNumber,
          },
        });
        connectedSent = true;

        socket.setTimeout(function () {
          if (failed || connectedDone) return;
          connectedDone = true;
          holding = true;
          reachedHolding = true;
          connectedOk.add(1);
          check(null, { 'ws connected settled': () => true });
          logInfo(
            'ws.hold.start',
            `user=${buyer.username} lotId=${LOT_ID} holdMs=${holdMs} attempt=${attempt} ack=${ACK_ENABLED} — keep connection open in system`
          );

          if (BIDDING_ENABLED) {
            if (ACK_ENABLED) {
              startAckLoop();
            } else {
              startAlignedBiddingLoop();
            }
          } else {
            logInfo('ws.bidding.skip', `user=${buyer.username} reason=BIDDING=false`);
          }

          socket.setTimeout(function () {
            if (failed) return;
            holdTimerFired = true;
            holding = false;
            logInfo('ws.hold.end', `user=${buyer.username} lotId=${LOT_ID} heldMs=${holdMs} attempt=${attempt}`);
            socket.close();
          }, holdMs);
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

        if (ACK_ENABLED && holding && BIDDING_ENABLED) {
          handleAckMessage(msg);
        }

        if (LOG_WS_MSG) {
          const code = msg.payload && msg.payload.code ? msg.payload.code : '';
          logInfo(
            'ws.message',
            `user=${buyer.username} type=${msg.type || '-'} code=${code || '-'} holding=${holding} body=${JSON.stringify(msg).slice(0, 300)}`
          );
        }

        if (!connectedDone && (visitSent || connectedSent) && isJoinError(msg)) {
          failed = true;
          connectedDone = true;
          connectedFail.add(1);
          check(null, { 'ws connected settled': () => false });
          const payload = msg.payload || {};
          lastError = {
            step: 'ws_bidding',
            reason: 'join_notification_error',
            code: payload.code || '',
            level: payload.level || '',
            message: payload.message || '',
            detail: describeWsNotification(msg),
          };
          logError(
            'ws.connected.fail',
            `user=${buyer.username} lotId=${LOT_ID} ${lastError.detail} msg=${raw}`
          );
          socket.close();
        } else if (holding && isJoinError(msg)) {
          const code = msgCode(msg);
          if (ACK_ENABLED && isAckExpectedError(code)) {
            return;
          }
          logError(
            'ws.hold.notification_error',
            `user=${buyer.username} lotId=${LOT_ID} ${describeWsNotification(msg)} msg=${raw}`
          );
        }
      });

      socket.on('error', function (e) {
        lastError = {
          step: 'ws_bidding',
          reason: 'socket_error',
          message: String(e),
        };
        logError('ws.socket.error', `user=${buyer.username} error=${e}`);
      });

      socket.on('close', function () {
        logInfo(
          'ws.close',
          `user=${buyer.username} holdingWas=${holding} failed=${failed} phase=${ack.phase} attempt=${attempt} holdTimerFired=${holdTimerFired}`
        );
      });

      socket.setTimeout(function () {
        if (connectedDone || failed) return;
        failed = true;
        connectedFail.add(1);
        check(null, { 'ws connected within timeout': () => false });
        lastError = {
          step: 'ws_bidding',
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
    `user=${buyer.username} httpStatus=${res && res.status} durationMs=${elapsed} holdMs=${holdMs} attempt=${attempt} reachedHolding=${reachedHolding} holdTimerFired=${holdTimerFired}`
  );

  function withFlags(result) {
    result.reachedHolding = reachedHolding;
    result.holdTimerFired = holdTimerFired;
    result.attempt = attempt;
    result.durationMs = elapsed;
    return result;
  }

  if (!upgraded) {
    return withFlags({
      ok: false,
      step: 'ws_upgrade_failed',
      error: {
        step: 'ws_bidding',
        reason: 'ws_upgrade_failed',
        httpStatus: res && res.status,
      },
    });
  }
  if (holdTimerFired) {
    return withFlags({ ok: true, step: 'ws.hold.end', error: null });
  }
  if (lastError) {
    return withFlags({
      ok: false,
      step: lastError.reason || lastError.step || 'ws_bidding',
      error: lastError,
    });
  }
  if (failed) {
    return withFlags({
      ok: false,
      step: 'ws_bidding',
      error: { step: 'ws_bidding', reason: 'unknown' },
    });
  }
  return withFlags({
    ok: false,
    step: 'ws.remote_close',
    error: {
      step: 'ws_bidding',
      reason: 'ws_remote_close',
      message: 'websocket closed before WS_HOLD ended',
    },
  });
}

/**
 * Stagger VU rejoin แล้วค้างจนครบ WS_HOLD wall-clock
 * ถ้าโดน remote_close / join fail จะ reconnect (ถ้าเปิด WS_RECONNECT)
 */
function runWebsocketHoldWithReconnect(session, bidderNumber) {
  const buyer = session.buyer;
  const rejoinStaggerMs = Math.max(0, (__VU - 1) * WS_REJOIN_STAGGER_MS);
  if (rejoinStaggerMs > 0) {
    logInfo(
      'ws.rejoin.stagger',
      `user=${buyer.username} waitMs=${rejoinStaggerMs} staggerMs=${WS_REJOIN_STAGGER_MS} vu=${__VU}`
    );
    sleep(rejoinStaggerMs / 1000);
  }

  const holdDeadline = Date.now() + WS_HOLD_MS;
  let attempt = 0;
  let reconnectCount = 0;
  let everHolding = false;
  let lastResult = null;
  let currentSession = session;

  while (true) {
    const remainingMs = holdDeadline - Date.now();
    if (remainingMs <= 0) {
      if (everHolding) {
        return {
          ok: true,
          step: 'ws.hold.end',
          error: null,
          reconnectCount: reconnectCount,
          attempts: attempt,
          reachedHolding: true,
        };
      }
      return Object.assign({}, lastResult || { ok: false, step: 'ws_bidding', error: { reason: 'hold_deadline_no_session' } }, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: false,
      });
    }

    attempt += 1;
    // reconnect รอบถัดไปไม่ต้องรอ bidding stagger ยาว — เริ่มยิงเร็วขึ้น
    const biddingStaggerMs = attempt === 1 ? Math.max(0, (__VU - 1) * STAGGER_MS) : 0;
    lastResult = runWebsocketVisitConnected(currentSession, bidderNumber, {
      holdMs: remainingMs,
      attempt: attempt,
      biddingStaggerMs: biddingStaggerMs,
    });
    if (lastResult.reachedHolding) everHolding = true;

    if (lastResult.ok) {
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: everHolding,
      });
    }

    const timeLeft = holdDeadline - Date.now();
    if (timeLeft <= 0) {
      if (everHolding) {
        return {
          ok: true,
          step: 'ws.hold.end',
          error: null,
          reconnectCount: reconnectCount,
          attempts: attempt,
          reachedHolding: true,
          lastCloseStep: lastResult.step,
        };
      }
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: false,
      });
    }

    if (!WS_RECONNECT_ENABLED) {
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: everHolding,
      });
    }

    if (WS_RECONNECT_MAX > 0 && reconnectCount >= WS_RECONNECT_MAX) {
      wsReconnectGaveUp.add(1);
      logError(
        'ws.reconnect.gave_up',
        `user=${buyer.username} reconnectCount=${reconnectCount} max=${WS_RECONNECT_MAX} lastStep=${lastResult.step} remainingMs=${timeLeft}`
      );
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: everHolding,
      });
    }

    reconnectCount += 1;
    wsReconnect.add(1);
    logInfo(
      'ws.reconnect',
      `user=${buyer.username} reconnect=${reconnectCount} nextAttempt=${attempt + 1} reason=${lastResult.step} remainingMs=${timeLeft} everHolding=${everHolding}`
    );

    // token/session อาจหมดอายุหลังถูกตัด — re-login ก่อนเปิด WS ใหม่
    if (
      lastResult.step === 'ws_upgrade_failed' ||
      lastResult.step === 'socket_error' ||
      lastResult.step === 'join_timeout' ||
      lastResult.step === 'ws.remote_close'
    ) {
      const loginResult = login(buyer);
      if (loginResult.session) {
        currentSession = loginResult.session;
        logInfo('ws.reconnect.login.ok', `user=${buyer.username} reconnect=${reconnectCount}`);
      } else {
        logError(
          'ws.reconnect.login.fail',
          `user=${buyer.username} reconnect=${reconnectCount} ${formatVuCompleteError(loginResult.error || {})}`
        );
      }
    }

    const reconnectStaggerMs = Math.max(0, (__VU - 1) * Math.min(WS_REJOIN_STAGGER_MS, 100));
    const delayMs = Math.min(WS_RECONNECT_DELAY_MS + reconnectStaggerMs, timeLeft);
    if (delayMs > 0) {
      sleep(delayMs / 1000);
    }
  }
}

export default function (setupData) {
  const rec = newVuCompleteRecord();

  try {
    requireEnv();

    logInfo(
      'iteration.start',
      `baseUrl=${BASE_URL} wsUrl=${WS_URL} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} buyerCount=${BUYER_USER.length} vus=${VUS} executor=${EXECUTOR} userPick=${USER_PICK} ack=${ACK_ENABLED} staggerMs=${STAGGER_MS} rejoinStaggerMs=${WS_REJOIN_STAGGER_MS} reconnect=${WS_RECONNECT_ENABLED} prepared=${setupData && setupData.preparedCount}`
    );

    const { buyer, idx } = pickBuyer();
    rec.username = buyer.username;
    const prepared =
      setupData && setupData.preparedByUsername ? setupData.preparedByUsername[buyer.username] : null;

    if (!prepared || !prepared.bidderNumber) {
      rec.step = 'setup_prepared';
      rec.error = `ไม่มี prepared lot-bidder/ws-join สำหรับ user=${buyer.username}`;
      fail(
        `ไม่มี prepared lot-bidder/ws-join สำหรับ user=${buyer.username} — ตรวจ setup log (failed=${setupData && setupData.failedUsernames ? setupData.failedUsernames.join(',') : '-'})`
      );
    }

    if (!prepared.joinOk) {
      rec.step = 'setup_ws_join';
      rec.error = `user=${buyer.username} ยังไม่ผ่าน setup WS visitLot→connected`;
      fail(`user=${buyer.username} ยังไม่ผ่าน setup WS visitLot→connected`);
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
      rec.step = 'login';
      rec.error = formatVuCompleteError(err) || 'login_failed';
      logError(
        'iteration.abort',
        `step=${err.step || 'login'} reason=login_failed user=${buyer.username} status=${err.status || '-'} code=${err.code || '-'} message=${err.message || '-'}`
      );
      sleep(1);
      return;
    }

    group(`2. prepared lot-bidder + ws-join (${buyer.username})`, () => {
      const preparedOk = bidderNumber !== '';
      const userMatch = prepared.username === buyer.username;
      const joinOk = prepared.joinOk === true;
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
      if (!joinOk) {
        logError(
          'ws.join.prepared_fail',
          `user=${buyer.username} reason=join_not_prepared lotId=${LOT_ID} source=setup`
        );
      }
      check(null, {
        'lot-bidder-number prepared': () => preparedOk,
        'lot-bidder-number matches user': () => userMatch,
        'ws visitLot+connected prepared': () => joinOk,
      });
      if (!preparedOk || !userMatch || !joinOk) {
        rec.step = 'setup_prepared';
        rec.error = !preparedOk
          ? 'empty_bidder_number'
          : !userMatch
            ? 'username_mismatch'
            : 'join_not_prepared';
        logError(
          'iteration.abort',
          `step=setup_prepared reason=${rec.error} user=${buyer.username} lotId=${LOT_ID}`
        );
        sleep(1);
        return;
      }
      logInfo(
        'setup.use_prepared',
        `user=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber} joinOk=true joinMs=${prepared.joinDurationMs || 0} source=setup`
      );
    });
    if (!bidderNumber || prepared.username !== buyer.username || !prepared.joinOk) {
      if (rec.step === 'unknown') {
        rec.step = 'setup_prepared';
        rec.error = 'prepared_invalid';
      }
      return;
    }

    let wsResult;
    group(`3. WS rejoin → bidding (${buyer.username})`, () => {
      wsResult = runWebsocketHoldWithReconnect(session, bidderNumber);
    });
    if (wsResult && !wsResult.ok) {
      const err = wsResult.error || {};
      rec.step = (wsResult && wsResult.step) || err.reason || err.step || 'ws_bidding';
      const reconnectInfo =
        wsResult.reconnectCount != null ? ` reconnects=${wsResult.reconnectCount}` : '';
      rec.error = (formatVuCompleteError(err) || rec.step) + reconnectInfo;
      logError(
        'iteration.abort',
        `step=${err.step || 'ws_bidding'} reason=${err.reason || 'unknown'} user=${buyer.username} lotId=${LOT_ID} code=${err.code || '-'} message=${err.message || err.detail || '-'} httpStatus=${err.httpStatus || '-'} reconnects=${wsResult.reconnectCount || 0} attempts=${wsResult.attempts || 0}`
      );
      sleep(1);
      return;
    }

    rec.step = (wsResult && wsResult.step) || 'ws.hold.end';
    rec.outcome = 'ok';
    rec.error =
      wsResult && wsResult.reconnectCount
        ? `reconnects=${wsResult.reconnectCount} attempts=${wsResult.attempts || 0}`
        : '';
    logInfo(
      'iteration.done',
      `user=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber} reconnects=${(wsResult && wsResult.reconnectCount) || 0} attempts=${(wsResult && wsResult.attempts) || 0}`
    );
    sleep(1);
  } catch (e) {
    if (!rec.error) rec.error = String(e && e.message ? e.message : e);
    if (!rec.step || rec.step === 'unknown') rec.step = 'exception';
    throw e;
  } finally {
    rec.at = nowIso();
    recordVuComplete(rec);
  }
}

export const handleSummary = createHandleSummary(function (data) {
  const vuCompletions = extractVuCompletions(data);
  const vuCompletePath = vuCompleteJsonPath();
  const extraFiles = {};
  extraFiles[vuCompletePath] = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: vuCompletions.length,
      items: vuCompletions,
    },
    null,
    2
  );

  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 setup(login→lot-bidder→visitLot→connected) → VU bidding',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'buyer-send-bidding-buffer-2',
    extraStdout: formatVuCompleteStdout(vuCompletions),
    extraFiles: extraFiles,
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
      biddingEnabled: BIDDING_ENABLED,
      ackEnabled: ACK_ENABLED,
      staggerMs: STAGGER_MS,
      wsRejoinStaggerMs: WS_REJOIN_STAGGER_MS,
      wsReconnect: WS_RECONNECT_ENABLED,
      wsReconnectDelayMs: WS_RECONNECT_DELAY_MS,
      wsReconnectMax: WS_RECONNECT_MAX,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      ackRetryMs: ACK_RETRY_MS,
      ackCooldownMs: ACK_COOLDOWN_MS,
      biddingIntervalMs: BIDDING_INTERVAL_MS,
      biddingDelayMs: BIDDING_DELAY_MS,
      lotBidderGapMs: LOT_BIDDER_GAP_MS,
      wsJoinGapMs: WS_JOIN_GAP_MS,
      lotBidderRetries: LOT_BIDDER_RETRIES,
      lotBidderRetryMs: LOT_BIDDER_RETRY_MS,
      httpTimeoutMs: HTTP_TIMEOUT_MS,
      setupTimeout: SETUP_TIMEOUT,
      lotBidderPrepareMode: 'setup-sequential-lot-bidder-and-ws-join',
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      biddingEvent: BIDDING_EVENT,
      biddingAction: BIDDING_ACTION,
      vuCompleteCount: vuCompletions.length,
      vuCompleteJson: vuCompletePath,
    },
  };
});
