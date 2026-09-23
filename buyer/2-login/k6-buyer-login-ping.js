/**
 * k6 — buyer login + websocket ping/pong
 *
 * อ้างอิงรูปแบบจาก buyer/6-bidding-ws/k6-buyer-send-bidding-buffer-2.js
 * ตัด bidding, lot-bidder, visitLot, connected, offer และ ACK ออกทั้งหมด
 *
 * setup:     ไม่มี logic
 * default:   ทุก VU ทำงานขนานจนครบ WS_HOLD — login ไม่ผ่านหรือ WS หลุดจะ retry
 *            ภายในเวลานั้น และไม่จบ iteration ก่อนหมดเวลา
 * teardown:  logout ทีละ buyer
 *
 * k6 แยก memory ของ VU กับ teardown จึงส่ง accessToken จาก default ไป teardown ไม่ได้
 * teardown จึง login ใหม่ (auth จะ revoke session เดิมของ buyer คนนั้น) แล้ว POST /auth/logout
 * เพื่อปิด session ที่เหลือ
 *
 * รันตัวอย่าง:
 *   ./buyer-login-ping-script.sh 5m 1 10 loadtestuser
 *   k6 run buyer/2-login/k6-buyer-login-ping.js \
 *     -e WS_HOLD=5m -e START_LOOP_INDEX=1 -e END_LOOP_INDEX=10
 *
 * ตัวแปร:
 *   WS_HOLD, START_LOOP_INDEX, END_LOOP_INDEX, USERNAME_PREFIX
 *   VUS = END_LOOP_INDEX - START_LOOP_INDEX + 1
 *   USER_PICK=vu|round, EXECUTOR=per-vu|constant, DURATION (เมื่อ constant)
 *   HTTP_TIMEOUT_MS, RETRY_DELAY_MS, LOGOUT=true|false, LOGOUT_GAP_MS, LOG_WS_MSG
 *   BASE_URL, WS_URL, REPORT_DIR, REPORT_BASENAME
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createHandleSummary } from '../../lib/k6-report.js';
import { logInfo, logError, logSetup, logSetupDivider, logBanner } from '../../lib/k6-pretty-log.js';
import { getMockBuyer } from '../../buyer-mock-user.js';

const loginDurationMs = new Trend('login_duration_ms');
const wsSessionDurationMs = new Trend('ws_session_duration_ms');
const logoutDurationMs = new Trend('logout_duration_ms');
const loginOkCounter = new Counter('login_ok');
const loginFailCounter = new Counter('login_fail');
const wsPingReceivedCounter = new Counter('ws_ping_received');
const wsPongSentCounter = new Counter('ws_pong_sent');
const wsConnectOkCounter = new Counter('ws_connect_ok');
const wsConnectFailCounter = new Counter('ws_connect_fail');
const logoutOkCounter = new Counter('logout_ok');
const logoutFailCounter = new Counter('logout_fail');

const START_LOOP_INDEX = Math.max(1, Number(__ENV.START_LOOP_INDEX || 1));
const END_LOOP_INDEX = Math.max(START_LOOP_INDEX, Number(__ENV.END_LOOP_INDEX || 100));
const USERNAME_PREFIX = String(__ENV.USERNAME_PREFIX || 'loadtestuser');

export const BUYER_USERS = getMockBuyer(START_LOOP_INDEX, END_LOOP_INDEX, USERNAME_PREFIX);

const BASE_URL = (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, '');
const WS_URL = (__ENV.WS_URL || 'wss://auctlive-sit.auct.co.th/api/v1/websocket').replace(/\/$/, '');
const USER_PICK = String(__ENV.USER_PICK || 'vu').toLowerCase();
const EXECUTOR = String(__ENV.EXECUTOR || 'per-vu').toLowerCase();
const VUS = BUYER_USERS.length;
const ITERATIONS = Number(__ENV.ITERATIONS || 1);
const HTTP_TIMEOUT_MS = Math.max(1000, Number(__ENV.HTTP_TIMEOUT_MS || 15000));
const LOG_WS_MSG = String(__ENV.LOG_WS_MSG || 'false').toLowerCase() === 'true';
const LOGOUT_ENABLED = !['false', '0', 'no'].includes(String(__ENV.LOGOUT == null ? 'true' : __ENV.LOGOUT).toLowerCase());
const LOGOUT_GAP_MS = Math.max(0, Number(__ENV.LOGOUT_GAP_MS || 0));
const RETRY_DELAY_MS = Math.max(0, Number(__ENV.RETRY_DELAY_MS || 1000));

function parseDurationMs(value, fallbackMs) {
  if (value == null || value === '') return fallbackMs;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'ms') return n;
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  return fallbackMs;
}

function msToDuration(ms) {
  const n = Math.max(0, Math.ceil(Number(ms) || 0));
  if (n % 3600000 === 0 && n >= 3600000) return `${n / 3600000}h`;
  if (n % 60000 === 0 && n >= 60000) return `${n / 60000}m`;
  if (n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

const WS_HOLD_MS = Math.max(0, parseDurationMs(__ENV.WS_HOLD_MS || __ENV.WS_HOLD || '5m', 5 * 60 * 1000));
const SCENARIO_WALL_MS = WS_HOLD_MS + HTTP_TIMEOUT_MS + 120000;
const MAX_DURATION = __ENV.MAX_DURATION || msToDuration(SCENARIO_WALL_MS);
const TEARDOWN_TIMEOUT =
  __ENV.TEARDOWN_TIMEOUT ||
  msToDuration(Math.max(BUYER_USERS.length, 1) * (HTTP_TIMEOUT_MS * 2 + LOGOUT_GAP_MS) + 30000);

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
      duration: __ENV.DURATION || msToDuration(SCENARIO_WALL_MS),
      gracefulStop: '30s',
    };
  }
  return {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: ITERATIONS,
    maxDuration: MAX_DURATION,
    gracefulStop: '30s',
  };
}

export const options = {
  teardownTimeout: TEARDOWN_TIMEOUT,
  scenarios: {
    buyer_login_ping: buildScenario(),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    http_req_failed: ['rate<0.1'],
    checks: ['rate>0.9'],
    login_duration_ms: ['p(95)<15000'],
  },
};

function requireEnv() {
  if (!Array.isArray(BUYER_USERS) || BUYER_USERS.length === 0) {
    fail('BUYER_USERS ต้องมีอย่างน้อย 1 buyer');
  }
}

function pickBuyer() {
  const n = BUYER_USERS.length;
  const idx = USER_PICK === 'vu' ? (__VU - 1) % n : (__VU - 1 + __ITER) % n;
  const buyer = BUYER_USERS[idx];
  if (!buyer || !buyer.username || !buyer.password || !buyer.loginType) {
    fail(`BUYER_USERS[${idx}] ไม่ครบ username/password/loginType`);
  }
  logInfo('pickBuyer', `idx=${idx} buyer=${buyer.username} loginType=${buyer.loginType} pickMode=${USER_PICK}`);
  return { buyer, idx };
}

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function authHeaders(accessToken, buyer) {
  const headers = {
    'Content-Type': 'application/json',
    'X-User-Type': buyer.loginType,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

function sessionCookie(session) {
  if (!session || !session.sessionId) return '';
  return `${session.buyer.loginType}_session_id=${session.sessionId}`;
}

/**
 * @param {object} buyer
 * @param {{ recordMetrics?: boolean, log?: function }} [opts]
 */
function login(buyer, opts) {
  const o = opts || {};
  const recordMetrics = o.recordMetrics !== false;
  const log = o.log || logInfo;
  log('auth.login.start', `POST ${BASE_URL}/auth/login buyer=${buyer.username} loginType=${buyer.loginType}`);

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
      tags: { name: 'POST /auth/login', username: buyer.username, phase: recordMetrics ? 'vu' : 'teardown' },
      timeout: `${HTTP_TIMEOUT_MS}ms`,
    }
  );

  const body = parseJson(res);
  const data = body && body.data ? body.data : {};
  const ok = res.status === 200 && !!data.accessToken && !!data.entryKey;
  if (recordMetrics) {
    loginDurationMs.add(res.timings.duration, { phase: 'vu' });
    check(res, {
      'login status 200': (r) => r.status === 200,
      'login has accessToken': () => !!data.accessToken,
      'login has entryKey': () => !!data.entryKey,
      'login has refreshToken': () => !!data.refreshToken,
    });
  }

  if (!ok) {
    if (recordMetrics) loginFailCounter.add(1);
    const detail = `buyer=${buyer.username} status=${res.status} code=${body && body.code} message=${body && body.message} durationMs=${res.timings.duration}`;
    if (recordMetrics) {
      logError('auth.login.fail', `${detail} body=${res.body}`);
    } else {
      log('auth.login.fail', detail);
    }
    return null;
  }

  if (recordMetrics) loginOkCounter.add(1);
  log(
    'auth.login.ok',
    `buyer=${buyer.username} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} entryKey=${maskToken(data.entryKey)} sessionId=${maskToken(data.sessionId)} accessToken=${maskToken(data.accessToken)}`
  );
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || '',
    entryKey: data.entryKey,
    sessionId: data.sessionId || '',
    buyer,
  };
}

function sleepUntil(deadline, delayMs) {
  const waitMs = Math.min(Math.max(0, delayMs), Math.max(0, deadline - Date.now()));
  if (waitMs > 0) sleep(waitMs / 1000);
}

/**
 * เปิด WebSocket แล้วตอบ ping ของ server ด้วย {"type":"pong"} จนครบ holdMs
 * หรือจนกว่า socket จะถูกปิดก่อนเวลา
 * server เทียบ pong แบบทั้งก้อน จึงต้องเป็น JSON นี้เท่านั้น
 * @returns {{ upgraded: boolean, opened: boolean, holdFinished: boolean }}
 */
function runPingPong(session, holdMs) {
  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  const cookie = sessionCookie(session);
  if (cookie) headers.Cookie = cookie;

  const url = `${WS_URL}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
  logInfo('ws.connect.start', `buyer=${buyer.username} url=${url} holdMs=${holdMs}`);

  const started = Date.now();
  let opened = false;
  let holdFinished = false;
  let pingCount = 0;
  let pongCount = 0;

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS ping/pong hold', username: buyer.username } },
    function (socket) {
      socket.on('open', function () {
        opened = true;
        wsConnectOkCounter.add(1);
        logInfo('ws.open', `buyer=${buyer.username} holdMs=${holdMs}`);
        socket.setTimeout(function () {
          holdFinished = true;
          logInfo(
            'ws.hold.end',
            `buyer=${buyer.username} heldMs=${Date.now() - started} ping=${pingCount} pong=${pongCount}`
          );
          socket.close();
        }, holdMs);
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          logInfo('ws.message.raw', `buyer=${buyer.username} unparsed=${String(raw).slice(0, 200)}`);
          return;
        }

        if (msg && msg.type === 'ping') {
          pingCount += 1;
          wsPingReceivedCounter.add(1);
          logInfo('ws.ping.recv', `buyer=${buyer.username} n=${pingCount}`);
          socket.send('{"type":"pong"}');
          pongCount += 1;
          wsPongSentCounter.add(1);
          logInfo('ws.pong.send', `buyer=${buyer.username} n=${pongCount}`);
          return;
        }

        if (LOG_WS_MSG) {
          logInfo('ws.message', `buyer=${buyer.username} type=${msg.type || '-'} body=${String(raw).slice(0, 300)}`);
        }
      });

      socket.on('error', function (e) {
        logError('ws.socket.error', `buyer=${buyer.username} error=${e}`);
      });

      socket.on('close', function () {
        logInfo('ws.close', `buyer=${buyer.username} opened=${opened} ping=${pingCount} pong=${pongCount}`);
      });
    }
  );

  const elapsed = Date.now() - started;
  wsSessionDurationMs.add(elapsed);
  const upgraded = !!(res && res.status === 101);
  check(res, {
    'ws status 101': (r) => r && r.status === 101,
  });
  if (!upgraded || !opened) {
    wsConnectFailCounter.add(1);
    logError(
      'ws.session.fail',
      `buyer=${buyer.username} httpStatus=${res && res.status} opened=${opened} durationMs=${elapsed}`
    );
  } else if (holdFinished) {
    logInfo(
      'ws.session.done',
      `buyer=${buyer.username} httpStatus=${res.status} durationMs=${elapsed} ping=${pingCount} pong=${pongCount}`
    );
  } else {
    logInfo(
      'ws.session.drop',
      `buyer=${buyer.username} httpStatus=${res.status} durationMs=${elapsed} ping=${pingCount} pong=${pongCount}`
    );
  }
  return { upgraded: upgraded, opened: opened, holdFinished: holdFinished };
}

function logout(session) {
  const buyer = session.buyer;
  const headers = authHeaders(session.accessToken, buyer);
  const cookie = sessionCookie(session);
  if (cookie) headers.Cookie = cookie;

  const res = http.post(
    `${BASE_URL}/auth/logout`,
    JSON.stringify({ refreshToken: session.refreshToken || '' }),
    {
      headers,
      tags: { name: 'POST /auth/logout', username: buyer.username, phase: 'teardown' },
      timeout: `${HTTP_TIMEOUT_MS}ms`,
    }
  );
  logoutDurationMs.add(res.timings.duration, { phase: 'teardown' });
  const ok = res.status === 200;
  check(res, {
    'logout status 200': (r) => r.status === 200,
  });
  if (ok) {
    logoutOkCounter.add(1);
    logSetup('auth.logout.ok', `buyer=${buyer.username} status=${res.status} durationMs=${res.timings.duration.toFixed(1)}`, {
      phase: 'LOGOUT',
      status: 'OK',
    });
    return true;
  }
  logoutFailCounter.add(1);
  const body = parseJson(res);
  logSetup(
    'auth.logout.fail',
    `buyer=${buyer.username} status=${res.status} code=${body && body.code} message=${body && body.message} body=${res.body}`,
    { phase: 'LOGOUT', status: 'FAIL' }
  );
  return false;
}

export function setup() {
  return {};
}

export default function () {
  requireEnv();

  if (__VU === 1 && (__ITER === 0 || !__ITER)) {
    logBanner('k6 buyer login + ping/pong', [
      ['ENDPOINT', BASE_URL],
      ['WEBSOCKET', WS_URL],
      ['BUYERS', `${BUYER_USERS.length} · ${USERNAME_PREFIX} ${START_LOOP_INDEX}..${END_LOOP_INDEX}`],
      ['LOAD', `executor=${EXECUTOR} · vus=${VUS} · parallel`],
      ['HOLD', `window=${msToDuration(WS_HOLD_MS)} · retryDelay=${RETRY_DELAY_MS}ms`],
      ['TEARDOWN', LOGOUT_ENABLED ? `logout buyers · timeout=${TEARDOWN_TIMEOUT}` : 'logout disabled'],
    ]);
  }

  const buyer = pickBuyer().buyer;
  const deadline = Date.now() + WS_HOLD_MS;
  let session = null;
  let everHeld = false;
  let lastReason = '';
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const remainingMs = deadline - Date.now();
    if (remainingMs < 250) {
      sleep(remainingMs / 1000);
      break;
    }

    if (!session) {
      session = login(buyer);
      if (!session) {
        lastReason = 'login_failed';
        logInfo(
          'auth.login.retry',
          `buyer=${buyer.username} attempt=${attempt} remainingMs=${deadline - Date.now()} delayMs=${RETRY_DELAY_MS}`
        );
        sleepUntil(deadline, RETRY_DELAY_MS);
        continue;
      }
    }

    const result = runPingPong(session, deadline - Date.now());
    if (result.opened) everHeld = true;
    if (result.holdFinished) break;

    lastReason = result.upgraded ? 'ws_closed_early' : 'ws_connect_failed';
    if (!result.upgraded) session = null;
    logInfo(
      'ws.retry',
      `buyer=${buyer.username} attempt=${attempt} reason=${lastReason} remainingMs=${deadline - Date.now()} delayMs=${RETRY_DELAY_MS}`
    );
    sleepUntil(deadline, RETRY_DELAY_MS);
  }

  if (everHeld) {
    logInfo('iteration.done', `buyer=${buyer.username} attempts=${attempt}`);
  } else {
    logError('iteration.abort', `reason=${lastReason || 'deadline'} buyer=${buyer.username} attempts=${attempt}`);
  }
}

export function teardown() {
  if (!LOGOUT_ENABLED) {
    logSetup('teardown.skip', 'LOGOUT=false — skip logout', { phase: 'LOGOUT' });
    return;
  }
  if (!Array.isArray(BUYER_USERS) || BUYER_USERS.length === 0) {
    logSetup('teardown.skip', 'ไม่มี buyer ให้ logout', { phase: 'LOGOUT', status: 'FAIL' });
    return;
  }

  const total = BUYER_USERS.length;
  let okCount = 0;
  let failCount = 0;
  logSetupDivider('teardown logout START');
  logSetup('teardown.config', `buyers=${total} gapMs=${LOGOUT_GAP_MS} timeout=${TEARDOWN_TIMEOUT}`, { phase: 'CONFIG' });

  for (let i = 0; i < total; i++) {
    const buyer = BUYER_USERS[i];
    const round = `${i + 1}/${total}`;
    logSetup('auth.logout.start', `buyer=${buyer.username} ${round} — login (revoke previous) → logout`, {
      round: round,
      phase: 'LOGOUT',
    });

    const session = login(buyer, {
      recordMetrics: false,
      log: function (action, detail) {
        logSetup(action, detail, { round: round, phase: 'LOGOUT' });
      },
    });
    if (!session) {
      failCount += 1;
      logSetup('teardown.buyer.result', `buyer=${buyer.username} reason=login_failed`, {
        round: round,
        phase: 'RESULT',
        status: 'FAIL',
      });
    } else if (logout(session)) {
      okCount += 1;
    } else {
      failCount += 1;
    }

    if (LOGOUT_GAP_MS > 0 && i < total - 1) sleep(LOGOUT_GAP_MS / 1000);
  }

  logSetupDivider('teardown logout DONE');
  logSetup('teardown.summary', `ok=${okCount} fail=${failCount} total=${total}`, {
    phase: 'SUMMARY',
    status: failCount > 0 ? 'PARTIAL' : 'OK',
  });
}

export const handleSummary = createHandleSummary(function () {
  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 buyer login + ping/pong',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'buyer-login-ping',
    meta: {
      baseUrl: BASE_URL,
      wsUrl: WS_URL,
      vus: VUS,
      executor: EXECUTOR,
      userPick: USER_PICK,
      startLoopIndex: START_LOOP_INDEX,
      endLoopIndex: END_LOOP_INDEX,
      usernamePrefix: USERNAME_PREFIX,
      buyerCount: BUYER_USERS.length,
      buyers: BUYER_USERS.map(function (u) {
        return u.username;
      }),
      wsHoldMs: WS_HOLD_MS,
      retryDelayMs: RETRY_DELAY_MS,
      logout: LOGOUT_ENABLED,
      logoutGapMs: LOGOUT_GAP_MS,
      httpTimeoutMs: HTTP_TIMEOUT_MS,
      teardownTimeout: TEARDOWN_TIMEOUT,
    },
  };
});
