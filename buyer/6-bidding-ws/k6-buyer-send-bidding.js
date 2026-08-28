/**
 * k6: buyer login → lot-bidder-number → WS visitLot → connected → send bidding
 *
 * Flow:
 * 1) POST /login/buyer
 * 2) POST /users/lot-bidder-number { lotId }
 * 3) WS connect (entryKey + sessionId)
 * 4) send visitLot → wait connected
 * 5) send type=bidding (ACK mode or interval mode)
 *
 * Buyers from getMockBuyer(START_LOOP_INDEX, END_LOOP_INDEX, USERNAME_PREFIX)
 *
 * Env:
 *   BASE_URL          default http://localhost:8000
 *   WS_URL            default ws://localhost:8001/ws
 *   LOT_ID            required
 *   LOT_LINE_ID       required for bidding payload
 *   AUCTION_NO        default 1
 *   BIDDING_EVENT     default online  (payload.event)
 *   BIDDING_ACTION    default bid
 *   START_LOOP_INDEX  default 1
 *   END_LOOP_INDEX    default 100
 *   USERNAME_PREFIX   default loadtestuser
 *   VUS               default = buyer count
 *   EXECUTOR          per-vu-iterations | shared-iterations (default)
 *   USER_PICK         by-vu | round-robin (default by-vu)
 *   WS_TIMEOUT        default 15s
 *   WS_HOLD           default 30m
 *   JOIN_SETTLE_MS    default 300
 *   BIDDING           true|false (default true)
 *   ACK               true|false (default true) — wait notification after each bid
 *   STAGGER_MS        default 50 (ACK mode VU start offset)
 *   ACK_TIMEOUT_MS    default 8000
 *   ACK_RETRY_MS      default 2000
 *   ACK_COOLDOWN_MS   default 300
 *   BIDDING_INTERVAL_MS default 1000 (when ACK=false)
 *   LOG_WS_MSG        true|false
 *   REPORT_DIR / REPORT_BASENAME / REPORT_TITLE
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createHandleSummary } from '../../lib/k6-report.js';
import { getMockBuyer } from '../../buyer-mock-user.js';

const loginDuration = new Trend('login_duration', true);
const bidderDuration = new Trend('lot_bidder_number_duration', true);
const wsConnectDuration = new Trend('ws_connect_duration', true);
const wsSessionDuration = new Trend('ws_session_duration', true);
const visitOk = new Counter('visit_lot_ok');
const connectedOk = new Counter('connected_ok');
const connectedFail = new Counter('connected_fail');
const pingReceived = new Counter('ws_ping_received');
const pongSent = new Counter('ws_pong_sent');
const biddingSent = new Counter('ws_bidding_sent');
const ackOk = new Counter('ws_ack_ok');
const ackFail = new Counter('ws_ack_fail');
const ackTimeout = new Counter('ws_ack_timeout');
const ackRetry = new Counter('ws_ack_retry');
const ackWait = new Trend('ws_ack_wait_ms', true);

const BASE_URL = (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, '');
const WS_URL = (__ENV.WS_URL || 'wss://auctlive-sit.auct.co.th/api/v1/websocket').replace(/\/$/, '');
const LOT_ID = __ENV.LOT_ID || '';
const LOT_LINE_ID = __ENV.LOT_LINE_ID || '';
const AUCTION_NO = Number(__ENV.AUCTION_NO || '1');
const BIDDING_EVENT = __ENV.BIDDING_EVENT || 'online';
const BIDDING_ACTION = __ENV.BIDDING_ACTION || 'bid';

const START_LOOP_INDEX = Number(__ENV.START_LOOP_INDEX || '1');
const END_LOOP_INDEX = Number(__ENV.END_LOOP_INDEX || '100');
const USERNAME_PREFIX = __ENV.USERNAME_PREFIX || 'loadtestuser';
const BUYER_USER = getMockBuyer(START_LOOP_INDEX, END_LOOP_INDEX, USERNAME_PREFIX);

const VUS = Number(__ENV.VUS || String(BUYER_USER.length));
const EXECUTOR = (__ENV.EXECUTOR || 'shared-iterations').toLowerCase();
const USER_PICK = (__ENV.USER_PICK || 'by-vu').toLowerCase();
const WS_TIMEOUT_MS = Number((__ENV.WS_TIMEOUT || '15s').replace(/s$/i, '')) * 1000;
const WS_HOLD_MS = parseDurationMs(__ENV.WS_HOLD || '30m');
const JOIN_SETTLE_MS = Number(__ENV.JOIN_SETTLE_MS || '1000');
const BIDDING_ENABLED = String(__ENV.BIDDING || 'true').toLowerCase() !== 'false';
const ACK_ENABLED = String(__ENV.ACK || 'true').toLowerCase() !== 'false';
const STAGGER_MS = Number(__ENV.STAGGER_MS || '50');
const ACK_TIMEOUT_MS = Number(__ENV.ACK_TIMEOUT_MS || '8000');
const ACK_RETRY_MS = Number(__ENV.ACK_RETRY_MS || '2000');
const ACK_COOLDOWN_MS = Number(__ENV.ACK_COOLDOWN_MS || '300');
const BIDDING_INTERVAL_MS = Number(__ENV.BIDDING_INTERVAL_MS || '1000');
const LOG_WS_MSG = String(__ENV.LOG_WS_MSG || 'false').toLowerCase() === 'true';

function parseDurationMs(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return 30 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  if (unit === 'ms') return Math.floor(n);
  if (unit === 's') return Math.floor(n * 1000);
  if (unit === 'm') return Math.floor(n * 60 * 1000);
  if (unit === 'h') return Math.floor(n * 60 * 60 * 1000);
  return Math.floor(n);
}

function nowIso() {
  return new Date().toISOString();
}

function logInfo(step, detail) {
  console.log(`[INFO][vu=${__VU} iter=${__ITER}] ${step}${detail ? ' ' + detail : ''}`);
}

function maskToken(token) {
  if (!token) return '';
  const s = String(token);
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function authHeaders(accessToken, serviceName, buyer) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-Service-Name': serviceName,
    'X-User-Type': buyer.loginType || 'buyer',
  };
}

function requireEnv() {
  if (!LOT_ID) {
    throw new Error('LOT_ID is required (e.g. LOT_ID=975)');
  }
  if (!BUYER_USER.length) {
    throw new Error('BUYER_USER is empty — check START_LOOP_INDEX / END_LOOP_INDEX / USERNAME_PREFIX');
  }
  if (BIDDING_ENABLED && !LOT_LINE_ID) {
    throw new Error('LOT_LINE_ID is required when BIDDING=true (e.g. LOT_LINE_ID=...)');
  }
}

function pickBuyer() {
  let idx;
  if (USER_PICK === 'round-robin') {
    idx = __ITER % BUYER_USER.length;
  } else {
    idx = (__VU - 1) % BUYER_USER.length;
  }
  return { buyer: BUYER_USER[idx], idx };
}

export const options = {
  scenarios: {
    buyer_send_bidding: {
      executor: EXECUTOR === 'per-vu-iterations' ? 'per-vu-iterations' : 'shared-iterations',
      vus: VUS,
      iterations: EXECUTOR === 'per-vu-iterations' ? 1 : VUS,
      maxDuration: '24h',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    checks: ['rate>0.95'],
    http_req_failed: ['rate<0.05'],
    login_duration: ['p(95)<3000'],
    lot_bidder_number_duration: ['p(95)<3000'],
    ws_connect_duration: ['p(95)<5000'],
  },
};

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
    code === 'E5014' ||
    code === 'E5015' ||
    code === 'E5016' ||
    code === 'E5017' ||
    code === 'WS00010'
  );
}

function summarizeWsMessage(msg) {
  if (!msg || typeof msg !== 'object') return `raw=${String(msg).slice(0, 120)}`;
  const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  const parts = [
    `type=${msg.type || '-'}`,
    msg.lots ? `lots=${JSON.stringify(msg.lots)}` : null,
    payload.action ? `action=${payload.action}` : null,
    payload.code ? `code=${payload.code}` : null,
    payload.level ? `level=${payload.level}` : null,
    payload.lotLineId != null ? `lotLineId=${payload.lotLineId}` : null,
    payload.bidderNumber != null ? `bidderNumber=${payload.bidderNumber}` : null,
    payload.userId != null ? `userId=${payload.userId}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

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

function sendWs(socket, buyer, type, options) {
  const opts = options || {};
  const msg = buildWsMessage(type, opts);
  const logAction = opts.logAction || `ws.${type}.send`;
  logInfo(logAction, `user=${buyer.username} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  return msg;
}

function msUntilNextInterval(intervalMs) {
  const now = Date.now();
  return Math.max(1, intervalMs - (now % intervalMs));
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
    `user=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} settleMs=${JOIN_SETTLE_MS} joinTimeoutMs=${WS_TIMEOUT_MS} holdMs=${WS_HOLD_MS} bidding=${BIDDING_ENABLED} ack=${ACK_ENABLED}`
  );
  const started = Date.now();

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS visitLot → connected → bidding', username: buyer.username } },
    function (socket) {
      let visitSent = false;
      let connectedSent = false;
      let connectedDone = false;
      let failed = false;
      let holding = false;
      let holdTimer = null;

      const ack = {
        inflight: false,
        sentAt: 0,
        retryAt: 0,
        timeoutAt: 0,
        lastCode: '',
      };

      function clearHoldTimer() {
        if (holdTimer) {
          try {
            socket.clearTimeout(holdTimer);
          } catch (_) {}
          holdTimer = null;
        }
      }

      function endHold(reason) {
        if (!holding) return;
        holding = false;
        clearHoldTimer();
        logInfo('ws.hold.end', `user=${buyer.username} reason=${reason}`);
        socket.close();
      }

      function scheduleHoldEnd() {
        clearHoldTimer();
        holdTimer = socket.setTimeout(function () {
          endHold('hold_elapsed');
        }, WS_HOLD_MS);
      }

      function isOwnBidder(msg) {
        const p = (msg && msg.payload) || {};
        if (bidderNumber && p.bidderNumber != null && String(p.bidderNumber) === String(bidderNumber)) {
          return true;
        }
        return false;
      }

      function sendBidding(reason) {
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
        logInfo(
          'ws.bidding.send',
          `user=${buyer.username} reason=${reason} ts=${ts} ${summarizeWsMessage(msg)}`
        );
        socket.send(JSON.stringify(msg));
        biddingSent.add(1);
      }

      function armAck(now) {
        ack.inflight = true;
        ack.sentAt = now;
        ack.retryAt = now + ACK_RETRY_MS;
        ack.timeoutAt = now + ACK_TIMEOUT_MS;
        ack.lastCode = '';
      }

      function clearAck() {
        ack.inflight = false;
        ack.sentAt = 0;
        ack.retryAt = 0;
        ack.timeoutAt = 0;
      }

      function sendBiddingAndArm(reason) {
        const now = Date.now();
        sendBidding(reason);
        armAck(now);
      }

      function scheduleNextBiddingTick(delayMs, reason) {
        socket.setTimeout(function () {
          if (!holding || failed) return;
          if (ack.inflight) return;
          sendBiddingAndArm(reason);
        }, Math.max(1, delayMs));
      }

      function handleAckMessage(msg) {
        if (!ack.inflight) return;
        if (!msg || msg.type !== 'notification') return;

        const code = msgCode(msg);
        const level = String((msg.payload && msg.payload.level) || '').toLowerCase();

        if (code === 'WS00002') {
          if (!isOwnBidder(msg)) return;
          const wait = Date.now() - ack.sentAt;
          ackWait.add(wait);
          ackOk.add(1);
          check(null, { 'ws bidding ack WS00002': () => true });
          logInfo(
            'ws.ack.ok',
            `user=${buyer.username} code=${code} waitMs=${wait} ${summarizeWsMessage(msg)}`
          );
          clearAck();
          scheduleNextBiddingTick(ACK_COOLDOWN_MS, 'after_ack_ok');
          return;
        }

        if (level === 'error' || isAckExpectedError(code)) {
          if (code === 'E5002' && !isOwnBidder(msg)) return;
          const wait = Date.now() - ack.sentAt;
          ackWait.add(wait);
          ackFail.add(1);
          ack.lastCode = code;
          check(null, { 'ws bidding ack business_error': () => true });
          logInfo(
            'ws.ack.fail',
            `user=${buyer.username} code=${code || '-'} waitMs=${wait} ${summarizeWsMessage(msg)}`
          );
          clearAck();
          scheduleNextBiddingTick(ACK_COOLDOWN_MS, 'after_ack_fail');
        }
      }

      function startBiddingLoop() {
        if (!BIDDING_ENABLED) {
          logInfo('ws.bidding.skip', `user=${buyer.username} BIDDING=false`);
          return;
        }

        if (ACK_ENABLED) {
          const stagger = Math.max(0, (__VU - 1) * STAGGER_MS);
          logInfo(
            'ws.bidding.ack_mode',
            `user=${buyer.username} staggerMs=${stagger} timeoutMs=${ACK_TIMEOUT_MS} retryMs=${ACK_RETRY_MS} cooldownMs=${ACK_COOLDOWN_MS}`
          );
          socket.setTimeout(function () {
            if (!holding || failed) return;
            sendBiddingAndArm('ack_first');
          }, stagger);

          const tick = Math.max(50, Math.min(200, Math.floor(ACK_RETRY_MS / 4) || 50));
          function ackWatchdog() {
            if (!holding || failed) return;
            const now = Date.now();
            if (ack.inflight) {
              if (now >= ack.timeoutAt) {
                const wait = now - ack.sentAt;
                ackWait.add(wait);
                ackTimeout.add(1);
                check(null, { 'ws bidding ack timeout': () => false });
                console.error(
                  `[ERROR][vu=${__VU} iter=${__ITER}] ws.ack.timeout user=${buyer.username} waitMs=${wait} lastCode=${ack.lastCode || '-'}`
                );
                clearAck();
                scheduleNextBiddingTick(ACK_COOLDOWN_MS, 'after_ack_timeout');
              } else if (now >= ack.retryAt) {
                ackRetry.add(1);
                logInfo('ws.ack.retry', `user=${buyer.username} elapsedMs=${now - ack.sentAt}`);
                sendBidding('ack_retry');
                ack.retryAt = now + ACK_RETRY_MS;
              }
            }
            socket.setTimeout(ackWatchdog, tick);
          }
          socket.setTimeout(ackWatchdog, tick);
          return;
        }

        // Interval mode (no ACK wait)
        const firstWait = msUntilNextInterval(BIDDING_INTERVAL_MS);
        logInfo(
          'ws.bidding.interval_mode',
          `user=${buyer.username} intervalMs=${BIDDING_INTERVAL_MS} firstWaitMs=${firstWait}`
        );
        socket.setTimeout(function tickBidding() {
          if (!holding || failed) return;
          sendBidding('interval');
          const nextWait = msUntilNextInterval(BIDDING_INTERVAL_MS);
          socket.setTimeout(tickBidding, nextWait);
        }, firstWait);
      }

      socket.on('open', function () {
        wsConnectDuration.add(Date.now() - started);
        logInfo('ws.open', `user=${buyer.username} status=connected elapsedMs=${Date.now() - started}`);

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
          scheduleHoldEnd();
          startBiddingLoop();
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
        logInfo('ws.close', `user=${buyer.username} holdingWas=${holding} failed=${failed}`);
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
    `baseUrl=${BASE_URL} wsUrl=${WS_URL} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} buyerCount=${BUYER_USER.length} vus=${VUS} executor=${EXECUTOR} userPick=${USER_PICK} bidding=${BIDDING_ENABLED} ack=${ACK_ENABLED}`
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

  group(`2. POST /users/lot-bidder-number (${buyer.username})`, () => {
    bidderNumber = getLotBidderNumber(session);
  });
  if (!bidderNumber) {
    logInfo('iteration.abort', `reason=lot_bidder_number_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  group(`3. WS visitLot → connected → bidding (${buyer.username})`, () => {
    runWebsocketVisitConnected(session, bidderNumber);
  });

  logInfo('iteration.done', `user=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber}`);
  sleep(1);
}

export const handleSummary = createHandleSummary(function () {
  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 buyer login → visitLot → bidding',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'buyer-send-bidding',
    meta: {
      baseUrl: BASE_URL,
      wsUrl: WS_URL,
      lotId: LOT_ID,
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      biddingEvent: BIDDING_EVENT,
      biddingAction: BIDDING_ACTION,
      vus: VUS,
      executor: EXECUTOR,
      userPick: USER_PICK,
      buyerCount: BUYER_USER.length,
      startLoopIndex: START_LOOP_INDEX,
      endLoopIndex: END_LOOP_INDEX,
      usernamePrefix: USERNAME_PREFIX,
      buyers: BUYER_USER.map(function (u) {
        return u.username;
      }),
      wsHoldMs: WS_HOLD_MS,
      joinSettleMs: JOIN_SETTLE_MS,
      biddingEnabled: BIDDING_ENABLED,
      ackEnabled: ACK_ENABLED,
      staggerMs: STAGGER_MS,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      ackRetryMs: ACK_RETRY_MS,
      ackCooldownMs: ACK_COOLDOWN_MS,
      biddingIntervalMs: BIDDING_INTERVAL_MS,
    },
  };
});
