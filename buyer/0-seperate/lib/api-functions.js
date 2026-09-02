/**
 * HTTP API functions — login, lot-bidder-number, etc.
 * Import and call individually from any k6 scenario.
 */
import http from 'k6/http';
import { check } from 'k6';
import { parseJson, logInfo, maskToken, authHeaders } from './utils.js';
import { loginDuration, bidderDuration } from './metrics.js';

/**
 * POST /auth/login
 * @returns {{ accessToken, entryKey, sessionId, buyer } | null}
 */
export function login(buyer, baseUrl) {
  logInfo('login.start', `POST ${baseUrl}/auth/login username=${buyer.username} loginType=${buyer.loginType}`);
  const res = http.post(
    `${baseUrl}/auth/login`,
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
      `[ERROR] hint: E2001 = user not found for username="${buyer.username}" loginType="${buyer.loginType}" on ${baseUrl}`
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

/**
 * POST /users/lot-bidder-number
 * @returns {string} bidderNumber or ''
 */
export function getLotBidderNumber(session, baseUrl, lotId) {
  const user = session.buyer.username;
  logInfo('lot-bidder-number.start', `POST ${baseUrl}/users/lot-bidder-number user=${user} lotId=${lotId}`);
  const res = http.post(
    `${baseUrl}/users/lot-bidder-number`,
    JSON.stringify({ lotId: Number(lotId) }),
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
      `[ERROR][vu=${__VU} iter=${__ITER}] lot-bidder-number.fail user=${user} lotId=${lotId} status=${res.status} durationMs=${res.timings.duration} body=${res.body}`
    );
    return '';
  }

  logInfo(
    'lot-bidder-number.ok',
    `user=${user} lotId=${lotId} bidderNumber=${bidderNumber} status=${res.status} durationMs=${res.timings.duration.toFixed(1)}`
  );
  return bidderNumber;
}
