/**
 * WebSocket session orchestrator — composes all event modules.
 * Import runWebsocketSession() from here, or import individual events directly.
 */
import ws from 'k6/ws';
import { check } from 'k6';
import { logInfo } from '../utils.js';
import { buildWsHeaders, buildWsUrl, isJoinError, msgCode, isAckExpectedError } from './ws-utils.js';
import { sendVisitLot } from './events/visit-lot.js';
import { sendConnected } from './events/connected.js';
import { handlePing } from './events/ping-pong.js';
import { createBiddingController } from './events/bidding.js';
import { wsConnectDuration, wsSessionDuration, connectedOk, connectedFail } from '../metrics.js';

/**
 * Full WS flow: connect → visitLot → connected → hold → bidding
 */
export function runWebsocketSession(session, bidderNumber, config) {
  const buyer = session.buyer;
  const headers = buildWsHeaders(session);
  const url = buildWsUrl(config.WS_URL, buyer);

  logInfo(
    'ws.connect.start',
    `user=${buyer.username} url=${url} lotId=${config.LOT_ID} bidderNumber=${bidderNumber} settleMs=${config.JOIN_SETTLE_MS} joinTimeoutMs=${config.WS_TIMEOUT_MS} holdMs=${config.WS_HOLD_MS} bidding=${config.BIDDING_ENABLED} ack=${config.ACK_ENABLED}`
  );
  const started = Date.now();

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS visitLot → connected → bidding', username: buyer.username } },
    function (socket) {
      const sessionState = {
        visitSent: false,
        connectedSent: false,
        connectedDone: false,
        failed: false,
        holding: false,
        holdTimer: null,
      };

      const bidding = createBiddingController(socket, buyer, config, bidderNumber, sessionState);

      function clearHoldTimer() {
        if (sessionState.holdTimer) {
          try {
            socket.clearTimeout(sessionState.holdTimer);
          } catch (_) {}
          sessionState.holdTimer = null;
        }
      }

      function endHold(reason) {
        if (!sessionState.holding) return;
        sessionState.holding = false;
        clearHoldTimer();
        logInfo('ws.hold.end', `user=${buyer.username} reason=${reason}`);
        socket.close();
      }

      function scheduleHoldEnd() {
        clearHoldTimer();
        sessionState.holdTimer = socket.setTimeout(function () {
          endHold('hold_elapsed');
        }, config.WS_HOLD_MS);
      }

      socket.on('open', function () {
        wsConnectDuration.add(Date.now() - started);
        logInfo('ws.open', `user=${buyer.username} status=connected elapsedMs=${Date.now() - started}`);

        sendVisitLot(socket, buyer, session, config.LOT_ID);
        sessionState.visitSent = true;

        sendConnected(socket, buyer, session, config.LOT_ID, bidderNumber);
        sessionState.connectedSent = true;

        socket.setTimeout(function () {
          if (sessionState.failed || sessionState.connectedDone) return;
          sessionState.connectedDone = true;
          sessionState.holding = true;
          connectedOk.add(1);
          check(null, { 'ws connected settled': () => true });
          logInfo(
            'ws.hold.start',
            `user=${buyer.username} lotId=${config.LOT_ID} holdMs=${config.WS_HOLD_MS} ack=${config.ACK_ENABLED} — keep connection open in system`
          );
          scheduleHoldEnd();
          bidding.startBiddingLoop();
        }, config.JOIN_SETTLE_MS);
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          logInfo('ws.message.raw', `user=${buyer.username} unparsed=${String(raw).slice(0, 200)}`);
          return;
        }

        if (handlePing(socket, buyer, msg)) return;

        if (config.ACK_ENABLED && sessionState.holding && config.BIDDING_ENABLED) {
          bidding.handleAckMessage(msg);
        }

        if (config.LOG_WS_MSG) {
          const code = msg.payload && msg.payload.code ? msg.payload.code : '';
          logInfo(
            'ws.message',
            `user=${buyer.username} type=${msg.type || '-'} code=${code || '-'} holding=${sessionState.holding} body=${JSON.stringify(msg).slice(0, 300)}`
          );
        }

        if (!sessionState.connectedDone && (sessionState.visitSent || sessionState.connectedSent) && isJoinError(msg)) {
          sessionState.failed = true;
          sessionState.connectedDone = true;
          connectedFail.add(1);
          check(null, { 'ws connected settled': () => false });
          console.error(
            `[ERROR][vu=${__VU} iter=${__ITER}] ws.connected.fail user=${buyer.username} lotId=${config.LOT_ID} msg=${raw}`
          );
          socket.close();
        } else if (sessionState.holding && isJoinError(msg)) {
          const code = msgCode(msg);
          if (config.ACK_ENABLED && isAckExpectedError(code)) {
            return;
          }
          console.error(
            `[ERROR][vu=${__VU} iter=${__ITER}] ws.hold.notification_error user=${buyer.username} lotId=${config.LOT_ID} msg=${raw}`
          );
        }
      });

      socket.on('error', function (e) {
        console.error(`[ERROR][vu=${__VU} iter=${__ITER}] ws.socket.error user=${buyer.username}: ${e}`);
      });

      socket.on('close', function () {
        logInfo('ws.close', `user=${buyer.username} holdingWas=${sessionState.holding} failed=${sessionState.failed}`);
      });

      socket.setTimeout(function () {
        if (sessionState.connectedDone || sessionState.failed) return;
        sessionState.failed = true;
        connectedFail.add(1);
        check(null, { 'ws connected within timeout': () => false });
        console.error(
          `[ERROR][vu=${__VU} iter=${__ITER}] ws.join.timeout user=${buyer.username} lotId=${config.LOT_ID} timeoutMs=${config.WS_TIMEOUT_MS}`
        );
        socket.close();
      }, config.WS_TIMEOUT_MS);
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
    `user=${buyer.username} httpStatus=${res && res.status} durationMs=${elapsed} holdMs=${config.WS_HOLD_MS}`
  );
}
