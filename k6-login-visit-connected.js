/**
 * k6 — login → user-profile → lot-bidder-number → WS visitLot → WS connected
 *
 * BUYER_USER = array ของ buyer
 * Default: เปิด VU พร้อมกัน = จำนวน buyer (1 VU : 1 user) แล้วแต่ละ VU รันครบทุก action
 *
 * บริบท: ทุก buyer connect แล้วค้าง WebSocket แล้วส่ง offer ซ้ำจนหมด WS_HOLD
 * Default: ACK=true + STAGGER — ยิงทีละข้อความ รอ notification ก่อนยิงต่อ และ offset ตาม VU
 * BID_AFTER_OFFER=true: หลัง offer สำเร็จ/E5013 สลับเป็น bidding
 * ACK=false: โหมดเดิม ทุก VU ส่ง offer พร้อมกันตาม wall-clock (ใช้ทดสอบ lock / E5002)
 *
 * รันตัวอย่าง (stagger + รอ ack):
 *   k6 run k6-login-visit-connected.js \
 *     -e BASE_URL=https://auctlive-sit.auct.co.th/api/v1 \
 *     -e WS_URL=wss://auctlive-sit.auct.co.th/api/v1/websocket \
 *     -e LOT_ID=975 \
 *     -e WS_HOLD=5m
 *
 * ตัวแปรเสริม:
 *   VUS                 # default = BUYER_USER.length
 *   ITERATIONS=1        # จำนวนรอบต่อ VU (per-vu-iterations)
 *   EXECUTOR=per-vu|constant  # default per-vu
 *   DURATION=30s        # ใช้เมื่อ EXECUTOR=constant
 *   USER_PICK=vu|round  # default vu (1 VU sticky 1 user)
 *   WS_TIMEOUT_MS=15000 # timeout ตอน join (ยังไม่ connected)
 *   JOIN_SETTLE_MS=1000 # รอหลังส่ง connected ก่อนถือว่า join สำเร็จ
 *   WS_HOLD=5m          # ค้าง connection หลัง join สำเร็จ (รองรับ ms|s|m|h หรือตัวเลข ms)
 *   LOT_LINE_ID=10360   # payload.lotLineId ของ offer/bidding
 *   AUCTION_NO=1        # payload.auctionNo ของ offer/bidding
 *   OFFER_EVENT=online  # payload.event ของ offer/bidding
 *   OFFER=true          # false = ไม่ส่ง offer/bidding ช่วง hold
 *   ACK=true            # false = ยิง offer ซ้ำตาม OFFER_INTERVAL_MS (sync ทุก VU)
 *   STAGGER_MS=250      # delay ของ VU n = (n-1)*STAGGER_MS (ใช้เมื่อ ACK=true)
 *   ACK_TIMEOUT_MS=2000 # รอ notification นานสุดต่อ 1 ข้อความ
 *   ACK_RETRY_MS=400    # รอหลัง E5002 / timeout ก่อนยิงใหม่
 *   ACK_COOLDOWN_MS=800 # รอหลังสำเร็จ ก่อนยิง offer/bidding รอบถัดไป
 *   BID_AFTER_OFFER=false # true = หลัง offer สำเร็จหรือ E5013 สลับเป็น bidding
 *   OFFER_INTERVAL_MS=1000  # ใช้เมื่อ ACK=false เท่านั้น
 *   LOG_WS_MSG=true
 *   REPORT_DIR=k6-reports
 *   REPORT_BASENAME=login-visit-connected
 *   # output → k6-reports/yyyyMMdd/HH-mm-ss/*.json|html
 *   # หรือกำหนด path เต็มด้วย REPORT_JSON / REPORT_HTML
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createHandleSummary } from './lib/k6-report.js';

const loginDuration = new Trend('login_duration_ms');
const profileDuration = new Trend('user_profile_duration_ms');
const bidderDuration = new Trend('lot_bidder_number_duration_ms');
const wsSessionDuration = new Trend('ws_session_duration_ms');
const visitOk = new Counter('visit_lot_ok');
const connectedOk = new Counter('connected_ok');
const connectedFail = new Counter('connected_fail');
const pingReceived = new Counter('ws_ping_received');
const pongSent = new Counter('ws_pong_sent');
const offerSent = new Counter('ws_offer_sent');
const biddingSent = new Counter('ws_bidding_sent');
const ackOk = new Counter('ws_ack_ok');
const ackRetry = new Counter('ws_ack_retry');
const ackTimeout = new Counter('ws_ack_timeout');

export const BUYER_USER = [
  { username: 'donbuyer01', password: 'P@ssw0rd08', loginType: 'buyer' },
  { username: 'donbuyer02', password: 'P@ssw0rd', loginType: 'buyer' },
  { username: 'donbuyer03', password: 'P@ssw0rd', loginType: 'buyer' },
  { username: 'donbuyer04', password: 'P@ssw0rd', loginType: 'buyer' },
  { username: 'donbuyer05', password: 'P@ssw0rd02', loginType: 'buyer' },
  { username: 'donbuyer06', password: 'P@ssw0rd', loginType: 'buyer' },
  { username: 'donbuyer07', password: 'P@ssw0rd04', loginType: 'buyer' },
  { username: 'donbuyer08', password: 'P@ssw0rd', loginType: 'buyer' },
];

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
const OFFER_EVENT = String(__ENV.OFFER_EVENT || 'online');
const OFFER_INTERVAL_MS = Number(__ENV.OFFER_INTERVAL_MS || 1000);
const OFFER_ENABLED = String(__ENV.OFFER || 'true').toLowerCase() !== 'false';
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
const BID_AFTER_OFFER = envFlag('BID_AFTER_OFFER', false);
const STAGGER_MS = Number(__ENV.STAGGER_MS || 250);
const ACK_TIMEOUT_MS = Number(__ENV.ACK_TIMEOUT_MS || 2000);
const ACK_RETRY_MS = Number(__ENV.ACK_RETRY_MS || 400);
const ACK_COOLDOWN_MS = Number(__ENV.ACK_COOLDOWN_MS || 800);
const ACK_TICK_MS = Number(__ENV.ACK_TICK_MS || 50);

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

// ค้าง WS หลัง join สำเร็จ — default 5 นาที
const WS_HOLD_MS = parseDurationMs(__ENV.WS_HOLD_MS || __ENV.WS_HOLD || '30m', 30 * 60 * 1000);
const MAX_DURATION =
  __ENV.MAX_DURATION ||
  `${Math.max(2, Math.ceil((WS_HOLD_MS + WS_TIMEOUT_MS + 60000) / 60000))}m`;

function nowIso() {
  return new Date().toISOString();
}

function logInfo(action, detail) {
  const extra = detail ? ` | ${detail}` : '';
  console.log(`[INFO][vu=${__VU} iter=${__ITER}] ${action}${extra}`);
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
  scenarios: {
    login_visit_connected: buildScenario(),
  },
  thresholds: {
    http_req_failed: ['rate<0.1'],
    checks: ['rate>0.9'],
    login_duration_ms: ['p(95)<5000'],
    user_profile_duration_ms: ['p(95)<5000'],
    lot_bidder_number_duration_ms: ['p(95)<5000'],
  },
};

function requireEnv() {
  if (!LOT_ID) {
    fail(`ขาด env: LOT_ID — ตัวอย่าง: -e LOT_ID=975`);
  }
  if (!Array.isArray(BUYER_USER) || BUYER_USER.length === 0) {
    fail('BUYER_USER ต้องเป็น array และมีอย่างน้อย 1 user');
  }
  if (OFFER_ENABLED) {
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
    } else if (!Number.isFinite(OFFER_INTERVAL_MS) || OFFER_INTERVAL_MS <= 0) {
      fail(`ผิด env: OFFER_INTERVAL_MS ต้องเป็นจำนวนบวก (ms)`);
    }
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

function login(buyer) {
  logInfo('login.start', `POST ${BASE_URL}/auth/login username=${buyer.username} loginType=${buyer.loginType}`);
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
    console.error(
      `[ERROR][vu=${__VU} iter=${__ITER}] login.fail user=${buyer.username} status=${res.status} code=${body && body.code} message=${body && body.message} durationMs=${res.timings.duration} body=${res.body}`
    );
    console.error(
      `[ERROR] hint: E2001 = user not found for username="${buyer.username}" loginType="${buyer.loginType}" on ${BASE_URL}`
    );
    return null;
  }

  logInfo(
    'login.ok',
    `user=${buyer.username} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} entryKey=${maskToken(data.entryKey)} sessionId=${maskToken(data.sessionId)} accessToken=${maskToken(data.accessToken)}`
  );

  return {
    accessToken: data.accessToken,
    entryKey: data.entryKey,
    sessionId: data.sessionId || '',
    buyer,
  };
}

function getUserProfile(session) {
  const user = session.buyer.username;
  logInfo('user-profile.start', `GET ${BASE_URL}/users/user-profile user=${user}`);
  const res = http.get(`${BASE_URL}/users/user-profile`, {
    headers: authHeaders(session.accessToken, 'user-service', session.buyer),
    tags: { name: 'GET /users/user-profile', username: user },
  });
  profileDuration.add(res.timings.duration);

  const body = parseJson(res);
  const data = body && body.data ? body.data : null;
  const ok = check(res, {
    'user-profile status 200': (r) => r.status === 200,
    'user-profile has data': () => !!data,
  });
  if (!ok) {
    console.error(
      `[ERROR][vu=${__VU} iter=${__ITER}] user-profile.fail user=${user} status=${res.status} durationMs=${res.timings.duration} body=${res.body}`
    );
    return null;
  }

  const profileUserId = data && (data.userId != null ? data.userId : data.id);
  logInfo(
    'user-profile.ok',
    `user=${user} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} profileUserId=${profileUserId != null ? profileUserId : '-'} isMainAccount=${data && data.isMainAccount}`
  );
  return data;
}

function getLotBidderNumber(session) {
  const user = session.buyer.username;
  logInfo('lot-bidder-number.start', `POST ${BASE_URL}/users/lot-bidder-number user=${user} lotId=${LOT_ID}`);
  const res = http.post(
    `${BASE_URL}/users/lot-bidder-number`,
    JSON.stringify({ lotId: Number(LOT_ID) }),
    {
      headers: authHeaders(session.accessToken, 'user-service', session.buyer),
      tags: { name: 'POST /users/lot-bidder-number', username: user },
    }
  );
  bidderDuration.add(res.timings.duration);

  const body = parseJson(res);
  const data = body && body.data ? body.data : null;
  const bidderNumber = data && data.bidderNumber != null ? String(data.bidderNumber) : '';

  const ok = check(res, {
    'lot-bidder-number status 200': (r) => r.status === 200,
    'lot-bidder-number has bidderNumber': () => bidderNumber !== '',
  });
  if (!ok) {
    console.error(
      `[ERROR][vu=${__VU} iter=${__ITER}] lot-bidder-number.fail user=${user} lotId=${LOT_ID} status=${res.status} durationMs=${res.timings.duration} body=${res.body}`
    );
    return '';
  }

  logInfo(
    'lot-bidder-number.ok',
    `user=${user} lotId=${LOT_ID} bidderNumber=${bidderNumber} status=${res.status} durationMs=${res.timings.duration.toFixed(1)}`
  );
  return bidderNumber;
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

function offerBlockedStatus(status) {
  return (
    status === 'pause' ||
    status === 'sold' ||
    status === 'pass' ||
    status === 'hold' ||
    status === 'waiting' ||
    status === 'open'
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

function isOwnBidder(payload, bidderNumber, userId) {
  const p = payload || {};
  if (bidderNumber && String(p.bidderNumber || '') === String(bidderNumber)) return true;
  if (userId && String(p.userId || '') === String(userId)) return true;
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

function sendOffer(socket, buyer, bidderNumber) {
  const msg = buildWsMessage('offer', {
    lots: [LOT_ID],
    payload: {
      action: 'bid',
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      event: OFFER_EVENT,
      bidderNumber: String(bidderNumber),
    },
  });
  const ts = nowIso();
  logInfo('ws.offer.send', `user=${buyer.username} ts=${ts} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  offerSent.add(1);
  return msg;
}

function sendBidding(socket, buyer, bidderNumber) {
  const msg = buildWsMessage('bidding', {
    lots: [LOT_ID],
    payload: {
      action: 'bid',
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      event: OFFER_EVENT,
      bidderNumber: String(bidderNumber),
    },
  });
  const ts = nowIso();
  logInfo('ws.bidding.send', `user=${buyer.username} ts=${ts} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  biddingSent.add(1);
  return msg;
}

function runWebsocketVisitConnected(session, bidderNumber, userId) {
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
    `user=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} userId=${userId || '-'} settleMs=${JOIN_SETTLE_MS} joinTimeoutMs=${WS_TIMEOUT_MS} holdMs=${WS_HOLD_MS} offer=${OFFER_ENABLED} ack=${ACK_ENABLED} staggerMs=${STAGGER_MS} offerIntervalMs=${OFFER_INTERVAL_MS}`
  );

  const started = Date.now();
  let visitSent = false;
  let connectedSent = false;
  let connectedDone = false;
  let failed = false;
  let holding = false;
  const ack = {
    pending: false,
    phase: 'offer',
    retryAt: 0,
    lastBidUserId: '',
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
    { headers, tags: { name: 'WS visitLot + connected + hold', username: buyer.username } },
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
        if (ack.phase === 'offer' && BID_AFTER_OFFER && offerBlockedStatus(ack.lastAuctionStatus)) {
          switchPhase('bidding', `status=${ack.lastAuctionStatus || '-'}`);
          return;
        }
        if (ack.phase === 'bidding') {
          if (bidBlockedStatus(ack.lastAuctionStatus)) return;
          if (userId && ack.lastBidUserId && ack.lastBidUserId === String(userId)) return;
        }

        ack.pending = true;
        ack.ackGen += 1;
        if (ack.phase === 'offer') {
          sendOffer(socket, buyer, bidderNumber);
        } else {
          sendBidding(socket, buyer, bidderNumber);
        }
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
      if (ACK_ENABLED && OFFER_ENABLED) {
        socket.setInterval(function () {
          if (!holding || failed) return;
          if (Date.now() < ackReadyAt) return;
          trySendAck();
        }, ACK_TICK_MS);
      }

      function startAckLoop() {
        const staggerMs = Math.max(0, (__VU - 1) * STAGGER_MS);
        ackReadyAt = Date.now() + staggerMs;
        logInfo(
          'ws.ack.loop.start',
          `user=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${OFFER_EVENT} bidderNumber=${bidderNumber} staggerMs=${staggerMs} timeoutMs=${ACK_TIMEOUT_MS} retryMs=${ACK_RETRY_MS} cooldownMs=${ACK_COOLDOWN_MS} bidAfterOffer=${BID_AFTER_OFFER}`
        );
        if (staggerMs <= 0) trySendAck();
      }

      function startAlignedOfferLoop() {
        const alignMs = msUntilNextAlignedTick(OFFER_INTERVAL_MS);
        logInfo(
          'ws.offer.loop.start',
          `user=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${OFFER_EVENT} bidderNumber=${bidderNumber} intervalMs=${OFFER_INTERVAL_MS} alignMs=${alignMs}`
        );
        function tick() {
          if (failed || !holding) return;
          sendOffer(socket, buyer, bidderNumber);
          socket.setTimeout(tick, OFFER_INTERVAL_MS);
        }
        schedule(tick, alignMs);
      }

      function handleAckMessage(msg) {
        const type = msg && msg.type ? msg.type : '';
        const payload = msg && msg.payload ? msg.payload : {};
        const code = msgCode(msg);

        if (type === 'bidInfo') {
          ack.lastBidUserId = String(payload.userId || '');
          ack.lastAuctionStatus = String(payload.auctionStatus || '');
          if (ack.phase === 'offer' && BID_AFTER_OFFER && offerBlockedStatus(ack.lastAuctionStatus)) {
            ack.pending = false;
            switchPhase('bidding', `bidInfo.status=${ack.lastAuctionStatus}`);
          }
          return;
        }

        const isNotif = type === 'notification';
        const isBroadcast = type === 'broadcastBuyer' || type === 'broadcastSeller';
        if (!isNotif && !isBroadcast) return;

        if (code === 'WS40005' || (code === 'WS40001' && isOwnBidder(payload, bidderNumber, userId))) {
          ack.pending = false;
          ack.ackGen += 1;
          ack.lastBidUserId = String(userId || payload.userId || '');
          ack.retryAt = Date.now() + ACK_COOLDOWN_MS;
          ackOk.add(1);
          if (ack.phase === 'offer' && BID_AFTER_OFFER) {
            switchPhase('bidding', code);
          }
          logInfo('ws.ack.ok', `user=${buyer.username} code=${code} phase=${ack.phase}`);
          return;
        }

        if (code === 'WS20001' && isOwnBidder(payload, bidderNumber, userId)) {
          ack.pending = false;
          ack.ackGen += 1;
          ack.lastBidUserId = String(userId || payload.userId || '');
          ack.retryAt = Date.now() + ACK_COOLDOWN_MS;
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
          if (ack.phase === 'offer' && BID_AFTER_OFFER) {
            switchPhase('bidding', 'E5013');
            logInfo('ws.ack.switch', `user=${buyer.username} code=E5013 phase=${ack.phase}`);
          } else {
            logInfo('ws.ack.retry', `user=${buyer.username} code=E5013 waitMs=${ACK_RETRY_MS} phase=${ack.phase}`);
          }
          return;
        }

        if (code === 'WS20003') {
          ack.pending = false;
          ack.ackGen += 1;
          ack.lastBidUserId = String(userId || '');
          ack.retryAt = Date.now() + ACK_COOLDOWN_MS;
          logInfo('ws.ack.self', `user=${buyer.username} code=WS20003 waitMs=${ACK_COOLDOWN_MS}`);
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
          connectedOk.add(1);
          check(null, { 'ws connected settled': () => true });
          logInfo(
            'ws.hold.start',
            `user=${buyer.username} lotId=${LOT_ID} holdMs=${WS_HOLD_MS} ack=${ACK_ENABLED} — keep connection open in system`
          );

          if (OFFER_ENABLED) {
            if (ACK_ENABLED) {
              startAckLoop();
            } else {
              startAlignedOfferLoop();
            }
          } else {
            logInfo('ws.offer.skip', `user=${buyer.username} reason=OFFER=false`);
          }

          socket.setTimeout(function () {
            if (failed) return;
            holding = false;
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

        if (ACK_ENABLED && holding && OFFER_ENABLED) {
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
          console.error(
            `[ERROR][vu=${__VU} iter=${__ITER}] ws.connected.fail user=${buyer.username} lotId=${LOT_ID} msg=${raw}`
          );
          socket.close();
        } else if (holding && isJoinError(msg)) {
          const code = msgCode(msg);
          if (ACK_ENABLED && isAckExpectedError(code)) {
            return;
          }
          console.error(
            `[ERROR][vu=${__VU} iter=${__ITER}] ws.hold.notification_error user=${buyer.username} lotId=${LOT_ID} msg=${raw}`
          );
        }
      });

      socket.on('error', function (e) {
        console.error(`[ERROR][vu=${__VU} iter=${__ITER}] ws.socket.error user=${buyer.username}: ${e}`);
      });

      socket.on('close', function () {
        logInfo('ws.close', `user=${buyer.username} holdingWas=${holding} failed=${failed} phase=${ack.phase}`);
      });

      socket.setTimeout(function () {
        if (connectedDone || failed) return;
        failed = true;
        connectedFail.add(1);
        check(null, { 'ws connected within timeout': () => false });
        console.error(
          `[ERROR][vu=${__VU} iter=${__ITER}] ws.join.timeout user=${buyer.username} lotId=${LOT_ID} timeoutMs=${WS_TIMEOUT_MS}`
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
}

export default function () {
  requireEnv();

  logInfo(
    'iteration.start',
    `baseUrl=${BASE_URL} wsUrl=${WS_URL} lotId=${LOT_ID} buyerCount=${BUYER_USER.length} vus=${VUS} executor=${EXECUTOR} userPick=${USER_PICK} ack=${ACK_ENABLED} staggerMs=${STAGGER_MS}`
  );

  const { buyer, idx } = pickBuyer();
  let session;
  let bidderNumber = '';

  group(`1. login (${buyer.username} #${idx})`, () => {
    session = login(buyer);
  });
  if (!session) {
    logInfo('iteration.abort', `reason=login_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  let profile = null;
  group(`2. GET /users/user-profile (${buyer.username})`, () => {
    profile = getUserProfile(session);
  });
  if (!profile) {
    logInfo('iteration.abort', `reason=user_profile_failed user=${buyer.username}`);
    sleep(1);
    return;
  }
  const userId =
    profile.userId != null ? String(profile.userId) : profile.id != null ? String(profile.id) : '';

  group(`3. POST /users/lot-bidder-number (${buyer.username})`, () => {
    bidderNumber = getLotBidderNumber(session);
  });
  if (!bidderNumber) {
    logInfo('iteration.abort', `reason=lot_bidder_number_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  group(`4. WS visitLot → connected (${buyer.username})`, () => {
    runWebsocketVisitConnected(session, bidderNumber, userId);
  });

  logInfo('iteration.done', `user=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber}`);
  sleep(1);
}

export const handleSummary = createHandleSummary(function () {
  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 login → visitLot → connected',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'login-visit-connected',
    meta: {
      baseUrl: BASE_URL,
      wsUrl: WS_URL,
      lotId: LOT_ID,
      vus: VUS,
      executor: EXECUTOR,
      userPick: USER_PICK,
      buyerCount: BUYER_USER.length,
      buyers: BUYER_USER.map(function (u) {
        return u.username;
      }),
      wsHoldMs: WS_HOLD_MS,
      joinSettleMs: JOIN_SETTLE_MS,
      offerEnabled: OFFER_ENABLED,
      ackEnabled: ACK_ENABLED,
      bidAfterOffer: BID_AFTER_OFFER,
      staggerMs: STAGGER_MS,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      ackRetryMs: ACK_RETRY_MS,
      ackCooldownMs: ACK_COOLDOWN_MS,
      offerIntervalMs: OFFER_INTERVAL_MS,
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      offerEvent: OFFER_EVENT,
    },
  };
});
