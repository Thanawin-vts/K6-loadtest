/** Environment config — single source of truth for all env vars */

import { parseDurationMs } from './utils.js';

export function loadConfig() {
  const START_LOOP_INDEX = Number(__ENV.START_LOOP_INDEX || '1');
  const END_LOOP_INDEX = Number(__ENV.END_LOOP_INDEX || '100');
  const USERNAME_PREFIX = __ENV.USERNAME_PREFIX || 'loadtestuser';
  const ACK_ENABLED = String(__ENV.ACK || 'true').toLowerCase() !== 'false';
  const BIDDING_DELAY_MS = Number(__ENV.BIDDING_DELAY_MS || '0');
  const ACK_COOLDOWN_MS = Number(__ENV.ACK_COOLDOWN_MS || '300');
  const BIDDING_INTERVAL_MS = Number(__ENV.BIDDING_INTERVAL_MS || '1000');

  function biddingGapMs() {
    if (!ACK_ENABLED) {
      return BIDDING_DELAY_MS > 0 ? BIDDING_DELAY_MS : BIDDING_INTERVAL_MS;
    }
    return ACK_COOLDOWN_MS + BIDDING_DELAY_MS;
  }

  return {
    BASE_URL: (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, ''),
    WS_URL: (__ENV.WS_URL || 'wss://auctlive-sit.auct.co.th/api/v1/websocket').replace(/\/$/, ''),
    LOT_ID: __ENV.LOT_ID || '',
    LOT_LINE_ID: __ENV.LOT_LINE_ID || '',
    AUCTION_NO: Number(__ENV.AUCTION_NO || '1'),
    BIDDING_EVENT: __ENV.BIDDING_EVENT || 'online',
    BIDDING_ACTION: __ENV.BIDDING_ACTION || 'bid',
    START_LOOP_INDEX,
    END_LOOP_INDEX,
    USERNAME_PREFIX,
    VUS: Number(__ENV.VUS || '0'),
    EXECUTOR: (__ENV.EXECUTOR || 'shared-iterations').toLowerCase(),
    USER_PICK: (__ENV.USER_PICK || 'by-vu').toLowerCase(),
    WS_TIMEOUT_MS: Number((__ENV.WS_TIMEOUT || '15s').replace(/s$/i, '')) * 1000,
    WS_HOLD_MS: parseDurationMs(__ENV.WS_HOLD || '30m'),
    JOIN_SETTLE_MS: Number(__ENV.JOIN_SETTLE_MS || '1000'),
    BIDDING_ENABLED: String(__ENV.BIDDING || 'true').toLowerCase() !== 'false',
    ACK_ENABLED,
    STAGGER_MS: Number(__ENV.STAGGER_MS || '50'),
    ACK_TIMEOUT_MS: Number(__ENV.ACK_TIMEOUT_MS || '8000'),
    ACK_RETRY_MS: Number(__ENV.ACK_RETRY_MS || '2000'),
    ACK_COOLDOWN_MS,
    BIDDING_INTERVAL_MS,
    BIDDING_DELAY_MS,
    LOG_WS_MSG: String(__ENV.LOG_WS_MSG || 'false').toLowerCase() === 'true',
    biddingGapMs,
  };
}

export function requireEnv(config, buyerCount) {
  if (!config.LOT_ID) {
    throw new Error('LOT_ID is required (e.g. LOT_ID=975)');
  }
  if (!buyerCount) {
    throw new Error('BUYER_USER is empty — check START_LOOP_INDEX / END_LOOP_INDEX / USERNAME_PREFIX');
  }
  if (config.BIDDING_ENABLED && !config.LOT_LINE_ID) {
    throw new Error('LOT_LINE_ID is required when BIDDING=true (e.g. LOT_LINE_ID=...)');
  }
}
