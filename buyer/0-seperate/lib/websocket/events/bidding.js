/**
 * bidding event — send bid + ACK loop / interval mode.
 */
import { check } from 'k6';
import { nowIso, logInfo, msUntilNextInterval } from '../../utils.js';
import { buildWsMessage, summarizeWsMessage, msgCode, isAckExpectedError, schedule } from '../ws-utils.js';
import { biddingSent, ackOk, ackFail, ackTimeout, ackRetry, ackWait } from '../../metrics.js';

export function createBiddingState() {
  return {
    inflight: false,
    sentAt: 0,
    retryAt: 0,
    timeoutAt: 0,
    lastCode: '',
  };
}

function isOwnBidder(msg, bidderNumber) {
  const p = (msg && msg.payload) || {};
  if (bidderNumber && p.bidderNumber != null && String(p.bidderNumber) === String(bidderNumber)) {
    return true;
  }
  return false;
}

export function sendBidding(socket, buyer, config, bidderNumber) {
  const msg = buildWsMessage('bidding', {
    lotId: config.LOT_ID,
    lots: [config.LOT_ID],
    payload: {
      action: config.BIDDING_ACTION,
      lotLineId: config.LOT_LINE_ID,
      auctionNo: config.AUCTION_NO,
      event: config.BIDDING_EVENT,
      bidderNumber: String(bidderNumber),
    },
  });
  const ts = nowIso();
  logInfo('ws.bidding.send', `user=${buyer.username} ts=${ts} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  biddingSent.add(1);
}

function armAck(ack, now, ackRetryMs, ackTimeoutMs) {
  ack.inflight = true;
  ack.sentAt = now;
  ack.retryAt = now + ackRetryMs;
  ack.timeoutAt = now + ackTimeoutMs;
  ack.lastCode = '';
}

function clearAck(ack) {
  ack.inflight = false;
  ack.sentAt = 0;
  ack.retryAt = 0;
  ack.timeoutAt = 0;
}

/**
 * Create bidding loop controller.
 * Returns { startBiddingLoop, handleAckMessage, sendBiddingAndArm }
 */
export function createBiddingController(socket, buyer, config, bidderNumber, sessionState) {
  const ack = createBiddingState();
  const { ACK_TIMEOUT_MS, ACK_RETRY_MS, STAGGER_MS, BIDDING_INTERVAL_MS, BIDDING_DELAY_MS } = config;

  function sendBiddingAndArm(reason) {
    const now = Date.now();
    logInfo('ws.bidding.send', `user=${buyer.username} reason=${reason}`);
    sendBidding(socket, buyer, config, bidderNumber);
    armAck(ack, now, ACK_RETRY_MS, ACK_TIMEOUT_MS);
  }

  function scheduleNextBiddingTick(delayMs, reason) {
    schedule(socket, function () {
      if (!sessionState.holding || sessionState.failed) return;
      if (ack.inflight) return;
      sendBiddingAndArm(reason);
    }, delayMs);
  }

  function handleAckMessage(msg) {
    if (!ack.inflight) return;
    if (!msg || msg.type !== 'notification') return;

    const code = msgCode(msg);
    const level = String((msg.payload && msg.payload.level) || '').toLowerCase();

    if (code === 'WS00002') {
      if (!isOwnBidder(msg, bidderNumber)) return;
      const wait = Date.now() - ack.sentAt;
      ackWait.add(wait);
      ackOk.add(1);
      check(null, { 'ws bidding ack WS00002': () => true });
      logInfo('ws.ack.ok', `user=${buyer.username} code=${code} waitMs=${wait} ${summarizeWsMessage(msg)}`);
      clearAck(ack);
      scheduleNextBiddingTick(config.biddingGapMs(), 'after_ack_ok');
      return;
    }

    if (level === 'error' || isAckExpectedError(code)) {
      if (code === 'E5002' && !isOwnBidder(msg, bidderNumber)) return;
      const wait = Date.now() - ack.sentAt;
      ackWait.add(wait);
      ackFail.add(1);
      ack.lastCode = code;
      check(null, { 'ws bidding ack business_error': () => true });
      logInfo('ws.ack.fail', `user=${buyer.username} code=${code || '-'} waitMs=${wait} ${summarizeWsMessage(msg)}`);
      clearAck(ack);
      scheduleNextBiddingTick(config.biddingGapMs(), 'after_ack_fail');
    }
  }

  function startBiddingLoop() {
    if (!config.BIDDING_ENABLED) {
      logInfo('ws.bidding.skip', `user=${buyer.username} BIDDING=false`);
      return;
    }

    if (config.ACK_ENABLED) {
      const stagger = Math.max(0, (__VU - 1) * STAGGER_MS);
      logInfo(
        'ws.bidding.ack_mode',
        `user=${buyer.username} staggerMs=${stagger} timeoutMs=${ACK_TIMEOUT_MS} retryMs=${ACK_RETRY_MS} cooldownMs=${config.ACK_COOLDOWN_MS} biddingDelayMs=${BIDDING_DELAY_MS} gapMs=${config.biddingGapMs()}`
      );
      schedule(socket, function () {
        if (!sessionState.holding || sessionState.failed) return;
        sendBiddingAndArm('ack_first');
      }, stagger);

      const tick = Math.max(50, Math.min(200, Math.floor(ACK_RETRY_MS / 4) || 50));
      function ackWatchdog() {
        if (!sessionState.holding || sessionState.failed) return;
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
            clearAck(ack);
            scheduleNextBiddingTick(config.biddingGapMs(), 'after_ack_timeout');
          } else if (now >= ack.retryAt) {
            ackRetry.add(1);
            logInfo('ws.ack.retry', `user=${buyer.username} elapsedMs=${now - ack.sentAt}`);
            sendBidding(socket, buyer, config, bidderNumber);
            ack.retryAt = now + ACK_RETRY_MS;
          }
        }
        socket.setTimeout(ackWatchdog, tick);
      }
      socket.setTimeout(ackWatchdog, tick);
      return;
    }

    const gapMs = config.biddingGapMs();
    const firstWait = msUntilNextInterval(gapMs);
    logInfo(
      'ws.bidding.interval_mode',
      `user=${buyer.username} intervalMs=${BIDDING_INTERVAL_MS} biddingDelayMs=${BIDDING_DELAY_MS} gapMs=${gapMs} firstWaitMs=${firstWait}`
    );
    schedule(socket, function tickBidding() {
      if (!sessionState.holding || sessionState.failed) return;
      sendBidding(socket, buyer, config, bidderNumber);
      schedule(socket, tickBidding, gapMs);
    }, firstWait);
  }

  return { startBiddingLoop, handleAckMessage };
}
