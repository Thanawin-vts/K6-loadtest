/**
 * k6 — login → user-profile → lot-bidder-number → WS visitLot → WS connected
 *
 * BUYER_USER = array ของ buyer
 * Default: เปิด VU พร้อมกัน = จำนวน buyer (1 VU : 1 user) แล้วแต่ละ VU รันครบทุก action
 *
 * บริบท: ทุก buyer connect แล้วค้าง WebSocket ไว้ในระบบ (ไม่ปิดทันที)
 *
 * รันตัวอย่าง (parallel + hold connection):
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
import { getMockBuyer } from './buyer-mock-user.js';

const loginDuration = new Trend('login_duration_ms');
const profileDuration = new Trend('user_profile_duration_ms');
const bidderDuration = new Trend('lot_bidder_number_duration_ms');
const wsSessionDuration = new Trend('ws_session_duration_ms');
const visitOk = new Counter('visit_lot_ok');
const connectedOk = new Counter('connected_ok');
const connectedFail = new Counter('connected_fail');
const pingReceived = new Counter('ws_ping_received');
const pongSent = new Counter('ws_pong_sent');

export const BUYER_USER = getMockBuyer();

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
    http_req_duration: ['p(95)<5000', 'p(99)<5000'],
    login_duration_ms: ['p(95)<5000', 'p(99)<5000'],
    user_profile_duration_ms: ['p(95)<5000', 'p(99)<5000'],
    lot_bidder_number_duration_ms: ['p(95)<5000', 'p(99)<5000'],
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

function runWebsocketVisitConnected(session, bidderNumber) {
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
  let connectedSent = false;
  let connectedDone = false;
  let failed = false;
  let holding = false;

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS visitLot + connected + hold', username: buyer.username } },
    function (socket) {
      function sendOfferBid() {
        if (failed || !holding) return;
        const ts = nowIso();
        const msg = buildWsMessage('offer', {
          lots: [LOT_ID],
          payload: {
            action: OFFER_ACTION,
            lotLineId: LOT_LINE_ID,
            auctionNo: AUCTION_NO,
            event: OFFER_EVENT,
            bidderNumber: String(bidderNumber),
          },
        });
        logInfo('ws.offer.send', `user=${buyer.username} ts=${ts} ${summarizeWsMessage(msg)}`);
        socket.send(JSON.stringify(msg));
        offerSent.add(1);
      }

      /** ส่ง offer ทุก OFFER_INTERVAL_MS แบบ sync ตามขอบวินาที wall-clock */
      function startSyncedOfferLoop() {
        if (OFFER_INTERVAL_MS <= 0) {
          logInfo('ws.offer.skip', `user=${buyer.username} reason=OFFER_INTERVAL_MS<=0`);
          return;
        }
        const firstWait = msUntilNextInterval(OFFER_INTERVAL_MS);
        logInfo(
          'ws.offer.loop.start',
          `user=${buyer.username} intervalMs=${OFFER_INTERVAL_MS} firstWaitMs=${firstWait} — sync all VUs on wall-clock`
        );
        socket.setTimeout(function offerTick() {
          if (failed || !holding) return;
          sendOfferBid();
          const nextWait = msUntilNextInterval(OFFER_INTERVAL_MS);
          socket.setTimeout(offerTick, nextWait);
        }, firstWait);
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

        // join สำเร็จแล้ว → ค้าง connection (ไม่ปิดทันที)
        socket.setTimeout(function () {
          if (failed || connectedDone) return;
          connectedDone = true;
          holding = true;
          connectedOk.add(1);
          check(null, { 'ws connected settled': () => true });
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

        // ตอบ ping ตลอดช่วง hold เพื่อไม่ให้ถูกตัด
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
          console.error(
            `[ERROR][vu=${__VU} iter=${__ITER}] ws.hold.notification_error user=${buyer.username} lotId=${LOT_ID} msg=${raw}`
          );
        }
      });

      socket.on('error', function (e) {
        console.error(`[ERROR][vu=${__VU} iter=${__ITER}] ws.socket.error user=${buyer.username}: ${e}`);
      });

      socket.on('close', function () {
        logInfo('ws.close', `user=${buyer.username} holdingWas=${holding} failed=${failed}`);
      });

      // timeout เฉพาะกรณียัง join ไม่สำเร็จ
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
    `baseUrl=${BASE_URL} wsUrl=${WS_URL} lotId=${LOT_ID} buyerCount=${BUYER_USER.length} vus=${VUS} executor=${EXECUTOR} userPick=${USER_PICK}`
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

  let profileOk = false;
  group(`2. GET /users/user-profile (${buyer.username})`, () => {
    profileOk = !!getUserProfile(session);
  });
  if (!profileOk) {
    logInfo('iteration.abort', `reason=user_profile_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  group(`3. POST /users/lot-bidder-number (${buyer.username})`, () => {
    bidderNumber = getLotBidderNumber(session);
  });
  if (!bidderNumber) {
    logInfo('iteration.abort', `reason=lot_bidder_number_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  // group(`4. WS visitLot → connected (${buyer.username})`, () => {
  //   runWebsocketVisitConnected(session, bidderNumber);
  // });

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
    },
  };
});
