/**
 * connected event — send after visitLot.
 */
import { sendWs } from '../ws-utils.js';

export function sendConnected(socket, buyer, session, lotId, bidderNumber) {
  sendWs(socket, buyer, 'connected', {
    lotId,
    lots: [lotId],
    fields: {
      isControl: false,
      entryKey: session.entryKey,
      bidderNumber: bidderNumber,
    },
  });
  return true;
}
