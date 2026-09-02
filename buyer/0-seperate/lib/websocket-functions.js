/**
 * Barrel export — import everything WebSocket-related from one place.
 *
 * Usage:
 *   import { runWebsocketSession, sendVisitLot, handlePing } from './lib/websocket-functions.js';
 */
export { buildWsMessage, sendWs, summarizeWsMessage, isJoinError, msgCode, isAckExpectedError, schedule, buildWsHeaders, buildWsUrl } from './websocket/ws-utils.js';
export { sendVisitLot } from './websocket/events/visit-lot.js';
export { sendConnected } from './websocket/events/connected.js';
export { handlePing } from './websocket/events/ping-pong.js';
export { sendBidding, createBiddingController } from './websocket/events/bidding.js';
export { runWebsocketSession } from './websocket/ws-session.js';
