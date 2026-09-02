/** Shared helpers for k6 buyer scenarios */

export function parseDurationMs(raw) {
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

export function nowIso() {
  return new Date().toISOString();
}

export function logInfo(step, detail) {
  console.log(`[INFO][vu=${__VU} iter=${__ITER}] ${step}${detail ? ' ' + detail : ''}`);
}

export function maskToken(token) {
  if (!token) return '';
  const s = String(token);
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

export function authHeaders(accessToken, serviceName, buyer) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-Service-Name': serviceName,
    'X-User-Type': buyer.loginType || 'buyer',
  };
}

export function msUntilNextInterval(intervalMs) {
  const now = Date.now();
  return Math.max(1, intervalMs - (now % intervalMs));
}

export function pickBuyer(buyers, userPick) {
  let idx;
  if (userPick === 'round-robin') {
    idx = __ITER % buyers.length;
  } else {
    idx = (__VU - 1) % buyers.length;
  }
  return { buyer: buyers[idx], idx };
}
