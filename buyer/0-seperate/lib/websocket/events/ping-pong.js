/**
 * ping / pong event handler.
 */
import { nowIso, logInfo } from '../../utils.js';
import { buildWsMessage, summarizeWsMessage } from '../ws-utils.js';
import { pingReceived, pongSent } from '../../metrics.js';

/**
 * Handle incoming ping — reply with pong.
 * @returns {boolean} true if message was a ping (handled)
 */
export function handlePing(socket, buyer, msg) {
  if (!msg || msg.type !== 'ping') return false;

  const pingTs = nowIso();
  logInfo('ws.ping.recv', `user=${buyer.username} ts=${pingTs} ${summarizeWsMessage(msg)}`);
  pingReceived.add(1);

  const pongMsg = buildWsMessage('pong');
  const pongTs = nowIso();
  logInfo('ws.pong.send', `user=${buyer.username} ts=${pongTs} ${summarizeWsMessage(pongMsg)}`);
  socket.send(JSON.stringify(pongMsg));
  pongSent.add(1);
  return true;
}
