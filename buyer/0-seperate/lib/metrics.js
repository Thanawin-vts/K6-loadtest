/** k6 custom metrics — import once, share across modules */

import { Counter, Trend } from 'k6/metrics';

export const loginDuration = new Trend('login_duration', true);
export const bidderDuration = new Trend('lot_bidder_number_duration', true);
export const wsConnectDuration = new Trend('ws_connect_duration', true);
export const wsSessionDuration = new Trend('ws_session_duration', true);
export const visitOk = new Counter('visit_lot_ok');
export const connectedOk = new Counter('connected_ok');
export const connectedFail = new Counter('connected_fail');
export const pingReceived = new Counter('ws_ping_received');
export const pongSent = new Counter('ws_pong_sent');
export const biddingSent = new Counter('ws_bidding_sent');
export const ackOk = new Counter('ws_ack_ok');
export const ackFail = new Counter('ws_ack_fail');
export const ackTimeout = new Counter('ws_ack_timeout');
export const ackRetry = new Counter('ws_ack_retry');
export const ackWait = new Trend('ws_ack_wait_ms', true);
