/**
 * visitLot event — send on WS open.
 */
import { check } from 'k6';
import { sendWs } from '../ws-utils.js';
import { visitOk } from '../../metrics.js';

export function sendVisitLot(socket, buyer, session, lotId) {
  sendWs(socket, buyer, 'visitLot', {
    lotId,
    lots: [lotId],
    payload: {
      lots: [lotId],
      isControl: false,
      entryKey: session.entryKey,
    },
  });
  visitOk.add(1);
  check(null, { 'ws visitLot sent': () => true });
  return true;
}
