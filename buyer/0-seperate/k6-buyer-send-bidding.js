/**
 * k6: buyer login → lot-bidder-number → WS visitLot → connected → send bidding
 *
 * Modular version — logic split into:
 *   lib/api-functions.js       — HTTP API calls
 *   lib/websocket-functions.js — WS events (visitLot, connected, ping/pong, bidding)
 *   lib/websocket/ws-session.js — WS session orchestrator
 *   lib/config.js              — env config
 *   lib/metrics.js             — k6 metrics
 *   lib/utils.js               — shared helpers
 *
 * Same env vars as buyer/6-bidding-ws/k6-buyer-send-bidding-buffer.js
 */
import { group, sleep } from 'k6';
import { createHandleSummary } from '../../lib/k6-report.js';
import { getMockBuyer } from '../../buyer-mock-user.js';
import { loadConfig, requireEnv } from './lib/config.js';
import { logInfo, pickBuyer } from './lib/utils.js';
import { login, getLotBidderNumber } from './lib/api-functions.js';
import { runWebsocketSession } from './lib/websocket-functions.js';

const config = loadConfig();
const BUYER_USER = getMockBuyer(config.START_LOOP_INDEX, config.END_LOOP_INDEX, config.USERNAME_PREFIX);
const VUS = config.VUS || BUYER_USER.length;

export const options = {
  scenarios: {
    buyer_send_bidding: {
      executor: config.EXECUTOR === 'per-vu-iterations' ? 'per-vu-iterations' : 'shared-iterations',
      vus: VUS,
      iterations: config.EXECUTOR === 'per-vu-iterations' ? 1 : VUS,
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

export default function () {
  requireEnv(config, BUYER_USER.length);

  logInfo(
    'iteration.start',
    `baseUrl=${config.BASE_URL} wsUrl=${config.WS_URL} lotId=${config.LOT_ID} lotLineId=${config.LOT_LINE_ID} auctionNo=${config.AUCTION_NO} buyerCount=${BUYER_USER.length} vus=${VUS} executor=${config.EXECUTOR} userPick=${config.USER_PICK} bidding=${config.BIDDING_ENABLED} ack=${config.ACK_ENABLED}`
  );

  const { buyer, idx } = pickBuyer(BUYER_USER, config.USER_PICK);
  let session;
  let bidderNumber = '';

  group(`1. login (${buyer.username} #${idx})`, () => {
    session = login(buyer, config.BASE_URL);
  });
  if (!session) {
    logInfo('iteration.abort', `reason=login_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  group(`2. POST /users/lot-bidder-number (${buyer.username})`, () => {
    bidderNumber = getLotBidderNumber(session, config.BASE_URL, config.LOT_ID);
  });
  if (!bidderNumber) {
    logInfo('iteration.abort', `reason=lot_bidder_number_failed user=${buyer.username}`);
    sleep(1);
    return;
  }

  group(`3. WS visitLot → connected → bidding (${buyer.username})`, () => {
    runWebsocketSession(session, bidderNumber, config);
  });

  logInfo('iteration.done', `user=${buyer.username} lotId=${config.LOT_ID} bidderNumber=${bidderNumber}`);
  sleep(1);
}

export const handleSummary = createHandleSummary(function () {
  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 buyer login → visitLot → bidding (modular)',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'buyer-send-bidding-separate',
    meta: {
      baseUrl: config.BASE_URL,
      wsUrl: config.WS_URL,
      lotId: config.LOT_ID,
      lotLineId: config.LOT_LINE_ID,
      auctionNo: config.AUCTION_NO,
      biddingEvent: config.BIDDING_EVENT,
      biddingAction: config.BIDDING_ACTION,
      vus: VUS,
      executor: config.EXECUTOR,
      userPick: config.USER_PICK,
      buyerCount: BUYER_USER.length,
      startLoopIndex: config.START_LOOP_INDEX,
      endLoopIndex: config.END_LOOP_INDEX,
      usernamePrefix: config.USERNAME_PREFIX,
      buyers: BUYER_USER.map(function (u) {
        return u.username;
      }),
      wsHoldMs: config.WS_HOLD_MS,
      joinSettleMs: config.JOIN_SETTLE_MS,
      biddingEnabled: config.BIDDING_ENABLED,
      ackEnabled: config.ACK_ENABLED,
      staggerMs: config.STAGGER_MS,
      ackTimeoutMs: config.ACK_TIMEOUT_MS,
      ackRetryMs: config.ACK_RETRY_MS,
      ackCooldownMs: config.ACK_COOLDOWN_MS,
      biddingIntervalMs: config.BIDDING_INTERVAL_MS,
      biddingDelayMs: config.BIDDING_DELAY_MS,
      structure: 'modular (buyer/0-seperate)',
    },
  };
});
