/**
 * WebSocket message builders and shared helpers.
 * Each event module imports from here.
 */
import { logInfo } from '../utils.js';

export function isJoinError(msg) {
  if (!msg || msg.type !== 'notification') return false;
  const payload = msg.payload || {};
  const level = String(payload.level || '').toLowerCase();
  const code = String(payload.code || '');
  if (level === 'error') return true;
  if (code === 'WS00043') return true;
  if (code.toLowerCase().includes('connectedincorrectly')) return true;
  return false;
}

export function msgCode(msg) {
  const payload = msg && msg.payload ? msg.payload : {};
  return String(payload.code || '');
}

export function isAckExpectedError(code) {
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

export function summarizeWsMessage(msg) {
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

/**
 * Build a WS message object.
 * @param {string} type  visitLot | connected | bidding | pong | ...
 * @param {object} options  { lots, fields, payload, lotId }
 */
export function buildWsMessage(type, options) {
  const opts = options || {};
  const lotId = opts.lotId;
  const msg = { type: type };
  if (opts.lots !== undefined) {
    msg.lots = opts.lots;
  } else if (type !== 'pong' && lotId) {
    msg.lots = [lotId];
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

export function sendWs(socket, buyer, type, options) {
  const opts = options || {};
  const msg = buildWsMessage(type, opts);
  const logAction = opts.logAction || `ws.${type}.send`;
  logInfo(logAction, `user=${buyer.username} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  return msg;
}

/** k6 socket.setTimeout rejects delay <= 0 */
export function schedule(socket, fn, delayMs) {
  const ms = Number(delayMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    fn();
    return;
  }
  socket.setTimeout(fn, ms);
}

export function buildWsHeaders(session) {
  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  if (session.sessionId) {
    headers.Cookie = `${buyer.loginType}_session_id=${session.sessionId}`;
  }
  return headers;
}

export function buildWsUrl(wsUrl, buyer) {
  return `${wsUrl}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
}
