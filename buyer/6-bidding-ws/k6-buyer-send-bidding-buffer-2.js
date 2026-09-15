/**
 * k6 — buffer-2 (buyer bidding)
 * setup (sequential per buyer):
 *   Login → Lot-Bidder Number → WS VisitLot → WS Connected → join settle → close
 * VU (parallel):
 *   Login → WS Rejoin (VisitLot → Connected) → Bidding Send (+ ACK loop) → WS Hold
 *
 * Naming (refactored v2):
 *   - JS handles: camelCase ชัดเจน (BUYER_USERS, CONFIG.*, loginOkCounter, ackState, ...)
 *   - ENV names: คงเดิมทั้งหมด (CLI / shell script ไม่ต้องเปลี่ยน)
 *   - k6 metric wire names: คงเดิมทั้งหมด (snake_case เดิม — dashboard เทียบ history ได้)
 *   - log action names: รวมศูนย์ที่ ACTION_NAMES (<domain>.<step>.<phase>)
 *   - display labels: รวมศูนย์ที่ FLOW_STEP_LABELS / STEP_DISPLAY_NAMES (log+stdout+HTML ตรงกัน)
 *
 * หมายเหตุ: k6 ส่ง WebSocket socket จาก setup() ไป VU ไม่ได้
 * จึง join ใน setup เป็น buffer ทีละ buyer แล้ว VU ต้อง rejoin บน connection ใหม่ก่อน bidding
 *
 * รันตัวอย่าง:
 *   ./buyer-send-bidding-buffer-2-script.sh 975 <lotLineId> 1 5m 1 10 loadtestuser 1 500
 *
 * ตัวแปรเสริม:
 *   LOT_LINE_ID, AUCTION_NO, BIDDING_EVENT, BIDDING_ACTION
 *   BIDDING=true|false, ACK=true|false
 *   STAGGER_MS (bidding stagger), ACK_TIMEOUT_MS, ACK_RETRY_MS, ACK_COOLDOWN_MS, ACK_TICK_MS
 *   BIDDING_INTERVAL_MS, BIDDING_DELAY_MS
 *   BIDDING_ORDER=sequence|parallel  # sequence = ส่ง offer ไล่เทียร์ VU1→VU2→…→VUS แล้ววน (default), parallel = ทุก VU ยิงอิสระตาม cooldown
 *   BIDDING_TURN_MS                  # ความยาว slot ต่อ VU ในโหมด sequence (default 2000) — cycle = VUS × turnMs เช่น 100 VU × 2s = 200s/รอบ
 *                                      # ควรตั้ง turn >= ws_ack_wait_ms p95 (เวลา settle bid ของ server) เพื่อให้ sent ผ่าน ~100% และ retry = 0
 *   LOT_BIDDER_GAP_MS, LOT_BIDDER_RETRIES, LOT_BIDDER_RETRY_MS, HTTP_TIMEOUT_MS
 *   WS_JOIN_GAP_MS       # รอระหว่าง buyer หลัง setup join (default = LOT_BIDDER_GAP_MS)
 *   WS_REJOIN_STAGGER_MS # รอก่อน VU rejoin = (VU-1)*ms (default 200) — ลด connection storm
 *   WS_RECONNECT=true     # remote_close/error แล้ว reconnect จนครบ WS_HOLD wall-clock
 *   WS_RECONNECT_DELAY_MS # รอก่อน reconnect (default 1000)
 *   WS_RECONNECT_MAX      # 0 = ไม่จำกัดจนหมด hold (default 0)
 *   DISCONNECTED=true|false # หลัง bidding → Phase 4: (1) รอ barrier รวมทุก VU บิดครบ (2) disconnect ทีละคน
 *                          # k6 VU แชร์ state กันไม่ได้ — barrier เป็นเวลา absolute จาก setup() แล้วค่อยคิวตาม VU
 *   DISCONNECT_GAP_MS     # หน่วงระหว่าง step disconnect คนที่ n กับ n+1 (default 100)
 *   SETUP_TIMEOUT=30m, WS_HOLD, JOIN_SETTLE_MS, LOG_WS_MSG, REPORT_DIR, REPORT_BASENAME
 *   PLAIN_LOG=true / NO_COLOR=true  # ปิดสี/ไอคอนใน log (เหมาะกับ --console-output=file หรือ CI)
 *   VU results JSON: {REPORT_DIR}/{REPORT_BASENAME}-vu-complete.json
 *   Dashboard: HTML "Run Summary & Flow Counts" ใช้ FLOW_STEP_LABELS เดียวกับ log/stdout
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import encoding from 'k6/encoding';
import { createHandleSummary, BIDDING_REPORT_METRICS } from '../../lib/k6-report.js';
import {
  vuContext,
  logInfo,
  logWarn,
  logError,
  logSetup,
  logSetupDivider,
  logSetupRule,
  logBanner,
  boxTable,
  truncateVis,
} from '../../lib/k6-pretty-log.js';
import { getMockBuyer } from '../../buyer-mock-user.js';

const VU_COMPLETE_CHECK_PREFIX = '__vu_complete__';

// ---------------------------------------------------------------------------
// Metric handles — variable/naming convention (refactored)
//   JS handle (camelCase, descriptive) -> k6 metric wire name (snake_case, stable)
//   Wire names are intentionally NOT renamed to keep historical JSON/HTML
//   dashboards comparable. Use canonical handles in new code.
//   Legacy aliases below are kept so existing call sites keep working.
// ---------------------------------------------------------------------------
//   auth ....... login_ok / login_fail + login_duration_ms
//   lot-bidder . lot_bidder_prepare_ok/fail + lot_bidder_number_duration_ms
//   ws-join .... ws_join_prepare_ok/fail + ws_join_prepare_duration_ms
//              + visit_lot_ok + connected_ok/fail
//   bidding .... ws_bidding_sent + ws_session_duration_ms
//   ack ........ ws_ack_ok / ws_ack_fail / ws_ack_retry / ws_ack_timeout
//   net ........ ws_ping_received / ws_pong_sent / ws_reconnect(_gave_up)

const loginDurationMs = new Trend('login_duration_ms');
const lotBidderNumberDurationMs = new Trend('lot_bidder_number_duration_ms');
const wsSessionDurationMs = new Trend('ws_session_duration_ms');
const wsJoinPrepareDurationMs = new Trend('ws_join_prepare_duration_ms');
// ACK round-trip: send `bidding` -> receive matching `notification/broadcast` (ms).
const ackWaitDurationMs = new Trend('ws_ack_wait_ms');
const loginOkCounter = new Counter('login_ok');
const loginFailCounter = new Counter('login_fail');
const visitLotOkCounter = new Counter('visit_lot_ok');
const connectedOkCounter = new Counter('connected_ok');
const connectedFailCounter = new Counter('connected_fail');
const wsPingReceivedCounter = new Counter('ws_ping_received');
const wsPongSentCounter = new Counter('ws_pong_sent');
const biddingSentCounter = new Counter('ws_bidding_sent');
const ackOkCounter = new Counter('ws_ack_ok');
// ACK มาช้าหลัง client timeout ไปแล้ว (false timeout — server ตอบ แต่ช้ากว่า ACK_TIMEOUT_MS)
const ackLateCounter = new Counter('ws_ack_late');
const ackFailCounter = new Counter('ws_ack_fail');
const ackRetryCounter = new Counter('ws_ack_retry');
const ackTimeoutCounter = new Counter('ws_ack_timeout');
const lotBidderPrepareOkCounter = new Counter('lot_bidder_prepare_ok');
const lotBidderPrepareFailCounter = new Counter('lot_bidder_prepare_fail');
const wsJoinPrepareOkCounter = new Counter('ws_join_prepare_ok');
const wsJoinPrepareFailCounter = new Counter('ws_join_prepare_fail');
const wsReconnectCounter = new Counter('ws_reconnect');
const wsReconnectGaveUpCounter = new Counter('ws_reconnect_gave_up');
const wsClosedNormallyCounter = new Counter('ws_closed_normally');
const wsPendingAckDrainedCounter = new Counter('ws_pending_ack_drained');
const wsUnexpectedDisconnectCounter = new Counter('ws_unexpected_disconnect');

// Legacy aliases — do not use in new code (kept for backward compatibility).
const loginDuration = loginDurationMs;
const bidderDuration = lotBidderNumberDurationMs;
const wsSessionDuration = wsSessionDurationMs;
const wsJoinPrepareDuration = wsJoinPrepareDurationMs;
const ackWaitDuration = ackWaitDurationMs;
const loginOk = loginOkCounter;
const loginFail = loginFailCounter;
const visitOk = visitLotOkCounter;
const connectedOk = connectedOkCounter;
const connectedFail = connectedFailCounter;
const pingReceived = wsPingReceivedCounter;
const pongSent = wsPongSentCounter;
const biddingSent = biddingSentCounter;
const ackOk = ackOkCounter;
const ackLate = ackLateCounter;
const ackFail = ackFailCounter;
const ackRetry = ackRetryCounter;
const ackTimeout = ackTimeoutCounter;
const lotBidderPrepareOk = lotBidderPrepareOkCounter;
const lotBidderPrepareFail = lotBidderPrepareFailCounter;
const wsJoinPrepareOk = wsJoinPrepareOkCounter;
const wsJoinPrepareFail = wsJoinPrepareFailCounter;
const wsReconnect = wsReconnectCounter;
const wsReconnectGaveUp = wsReconnectGaveUpCounter;
const wsClosedNormally = wsClosedNormallyCounter;
const wsPendingAckDrained = wsPendingAckDrainedCounter;
const wsUnexpectedDisconnect = wsUnexpectedDisconnectCounter;

// Display naming — single source of truth for logs / stdout table / HTML dashboard.
const FLOW_STEP_LABELS = {
  // Phase 1: Prerequisite
  login: 'Login',
  lotBidder: 'Lot-Bidder Number',
  visitLot: 'WS VisitLot',
  connected: 'WS Connected',
  wsJoinPrepare: 'WS Join Prepare',
  // Phase 2: Bidding / Offer
  bidding: 'Bidding Send',
  ack: 'Bidding ACK',
  // Phase 3: Postrequisite
  pendingAckDrained: 'Pending ACK Drained',
  postBidHold: 'Post-Bid Hold',
  wsClose: 'WS Closed Normally',
  reconnect: 'WS Reconnect',
  hold: 'WS Hold',
  // Phase 4: Disconnect cleanup (optional)
  leaveLot: 'WS LeaveLot',
  disconnected: 'WS Disconnected',
};

const START_LOOP_INDEX = Math.max(1, Number(__ENV.START_LOOP_INDEX || 1));
const END_LOOP_INDEX = Math.max(START_LOOP_INDEX, Number(__ENV.END_LOOP_INDEX || 100));
const USERNAME_PREFIX = String(__ENV.USERNAME_PREFIX || 'loadtestuser');

export const BUYER_USERS = getMockBuyer(START_LOOP_INDEX, END_LOOP_INDEX, USERNAME_PREFIX);

// Backward-compatible alias — new code should use BUYER_USERS (plural).
export const BUYER_USER = BUYER_USERS;

function parseDurationMs(value, fallbackMs) {
  if (value == null || value === '') return fallbackMs;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'ms') return n;
  if (u === 's') return n * 1000;
  if (u === 'm') return n * 60 * 1000;
  if (u === 'h') return n * 60 * 60 * 1000;
  return fallbackMs;
}

function msToDuration(ms) {
  const n = Math.max(1, Math.ceil(Number(ms) || 0));
  if (n >= 3600000 && n % 3600000 === 0) return `${n / 3600000}h`;
  if (n >= 60000 && n % 60000 === 0) return `${n / 60000}m`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

// ---------------------------------------------------------------------------
// Run config — grouped by concern (ENV names unchanged for CLI compatibility)
// ---------------------------------------------------------------------------
function envFlag(name, defaultValue) {
  const raw = __ENV[name];
  if (raw == null || raw === '') return defaultValue;
  const s = String(raw).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return defaultValue;
}

const CONFIG = {
  baseUrl: (__ENV.BASE_URL || 'https://auctlive-sit.auct.co.th/api/v1').replace(/\/$/, ''),
  wsUrl: (__ENV.WS_URL || 'wss://auctlive-sit.auct.co.th/api/v1/websocket').replace(/\/$/, ''),
  lotId: String(__ENV.LOT_ID || ''),
  // Run shape
  userPickMode: String(__ENV.USER_PICK || 'vu').toLowerCase(), // vu | round
  executor: String(__ENV.EXECUTOR || 'per-vu').toLowerCase(), // per-vu | constant
  virtualUsers: Number(__ENV.VUS || BUYER_USERS.length),
  iterationsPerVu: Number(__ENV.ITERATIONS || 1),
  // 3-Phase Timing: Bidding Duration (main test window) vs Post-Bid Hold (drain & quiet period)
  postBidHoldMs: parseDurationMs(__ENV.POST_BID_HOLD || __ENV.POST_BID_HOLD_MS || '10s', 10 * 1000),
  biddingDurationMs: (__ENV.BIDDING_DURATION || __ENV.BIDDING_DURATION_MS)
    ? parseDurationMs(__ENV.BIDDING_DURATION || __ENV.BIDDING_DURATION_MS, 5 * 60 * 1000)
    : Math.max(1000, parseDurationMs(__ENV.WS_HOLD_MS || __ENV.WS_HOLD || '5m', 5 * 60 * 1000) - parseDurationMs(__ENV.POST_BID_HOLD || __ENV.POST_BID_HOLD_MS || '10s', 10 * 1000)),
  // WS join/hold
  wsJoinTimeoutMs: Number(__ENV.WS_TIMEOUT_MS || 15000),
  wsJoinSettleMs: Number(__ENV.JOIN_SETTLE_MS || 1000),
  wsRejoinStaggerMs: Number(__ENV.WS_REJOIN_STAGGER_MS || 200),
  wsReconnectEnabled: envFlag('WS_RECONNECT', true),
  wsReconnectDelayMs: Number(__ENV.WS_RECONNECT_DELAY_MS || 1000),
  wsReconnectMax: Number(__ENV.WS_RECONNECT_MAX || 0), // 0 = unlimited until hold deadline
  // Bidding payload
  lotLineId: Number(__ENV.LOT_LINE_ID || 10360),
  auctionNo: Number(__ENV.AUCTION_NO || 1),
  biddingEvent: String(__ENV.BIDDING_EVENT || 'online'),
  biddingAction: String(__ENV.BIDDING_ACTION || 'bid'),
  biddingEnabled: envFlag('BIDDING', true),
  biddingIntervalMs: Number(__ENV.BIDDING_INTERVAL_MS || 1000),
  biddingDelayMs: Number(__ENV.BIDDING_DELAY_MS || 0),
  // ลำดับการส่ง offer: sequence = ไล่เทียร์ VU1→VU2→…→VUS แล้ววน (round-robin), parallel = ทุก VU ยิงอิสระ
  biddingOrder: String(__ENV.BIDDING_ORDER || 'sequence').toLowerCase(),
  // turn ต้อง >= เวลา process/settle bid ของ server (ดู ws_ack_wait_ms p95) — ถ้า turn สั้นกว่า
  // bid ถัดไปจะโดน E5002 ระหว่าง server กำลัง settle bid ก่อนหน้า เป้าหมาย sent ผ่าน ~100% คือ turn >= settle
  biddingTurnMs: Number(__ENV.BIDDING_TURN_MS || 2000),
  // ACK loop
  ackEnabled: envFlag('ACK', true),
  biddingStaggerMs: Number(__ENV.STAGGER_MS || 500),
  ackTimeoutMs: Number(__ENV.ACK_TIMEOUT_MS || 8000),
  ackRetryMs: Number(__ENV.ACK_RETRY_MS || 1000),
  ackCooldownMs: Number(__ENV.ACK_COOLDOWN_MS || 1500),
  ackTickMs: Number(__ENV.ACK_TICK_MS || 50),
  // Setup prep (lot-bidder)
  lotBidderGapMs: Number(__ENV.LOT_BIDDER_GAP_MS || 0),
  lotBidderRetries: Number(__ENV.LOT_BIDDER_RETRIES || 3),
  lotBidderRetryMs: Number(__ENV.LOT_BIDDER_RETRY_MS || 500),
  httpTimeoutMs: Number(__ENV.HTTP_TIMEOUT_MS || 15000),
  logWsMessages: envFlag('LOG_WS_MSG', false),
  // หลัง bidding: leaveLot → disconnected ทีละ VU (cleanup — ไม่นับ metric)
  disconnectedEnabled: envFlag('DISCONNECTED', true),
  disconnectGapMs: Number(__ENV.DISCONNECT_GAP_MS || 100),
};

// WS_JOIN_GAP_MS defaults to lot-bidder gap (keeps old pacing behaviour).
CONFIG.wsJoinGapMs = Number(
  __ENV.WS_JOIN_GAP_MS != null && __ENV.WS_JOIN_GAP_MS !== '' ? __ENV.WS_JOIN_GAP_MS : CONFIG.lotBidderGapMs
);

// 3-Phase Timing constants
const POST_BID_HOLD_MS = CONFIG.postBidHoldMs;
const BIDDING_DURATION_MS = CONFIG.biddingDurationMs;
const DISCONNECTED_ENABLED = CONFIG.disconnectedEnabled;
const DISCONNECT_GAP_MS = Math.max(0, Number(CONFIG.disconnectGapMs) || 0);

// Legacy flat names — do not use in new code (kept so the rest of the file works).
const BASE_URL = CONFIG.baseUrl;
const WS_URL = CONFIG.wsUrl;
const LOT_ID = CONFIG.lotId;
const USER_PICK = CONFIG.userPickMode;
const EXECUTOR = CONFIG.executor;
const VUS = CONFIG.virtualUsers;
const ITERATIONS = CONFIG.iterationsPerVu;
const WS_TIMEOUT_MS = CONFIG.wsJoinTimeoutMs;
const JOIN_SETTLE_MS = CONFIG.wsJoinSettleMs;
const LOT_LINE_ID = CONFIG.lotLineId;
const AUCTION_NO = CONFIG.auctionNo;
const BIDDING_EVENT = CONFIG.biddingEvent;
const BIDDING_ACTION = CONFIG.biddingAction;
const BIDDING_INTERVAL_MS = CONFIG.biddingIntervalMs;
const BIDDING_DELAY_MS = CONFIG.biddingDelayMs;
const BIDDING_ENABLED = CONFIG.biddingEnabled;
const LOG_WS_MSG = CONFIG.logWsMessages;
const BIDDING_ORDER = CONFIG.biddingOrder;
const BIDDING_TURN_MS = CONFIG.biddingTurnMs;
const ACK_ENABLED = CONFIG.ackEnabled;
const STAGGER_MS = CONFIG.biddingStaggerMs;
const ACK_TIMEOUT_MS = CONFIG.ackTimeoutMs;
const ACK_RETRY_MS = CONFIG.ackRetryMs;
const ACK_COOLDOWN_MS = CONFIG.ackCooldownMs;
const ACK_TICK_MS = CONFIG.ackTickMs;
const LOT_BIDDER_GAP_MS = CONFIG.lotBidderGapMs;
const LOT_BIDDER_RETRIES = CONFIG.lotBidderRetries;
const LOT_BIDDER_RETRY_MS = CONFIG.lotBidderRetryMs;
const HTTP_TIMEOUT_MS = CONFIG.httpTimeoutMs;
const WS_JOIN_GAP_MS = CONFIG.wsJoinGapMs;
const WS_REJOIN_STAGGER_MS = CONFIG.wsRejoinStaggerMs;
const WS_RECONNECT_ENABLED = CONFIG.wsReconnectEnabled;
const WS_RECONNECT_DELAY_MS = CONFIG.wsReconnectDelayMs;
const WS_RECONNECT_MAX = CONFIG.wsReconnectMax;

/** หน่วงคิว disconnect ทีละคน หลัง barrier รวมแล้ว — (vu-1)×turnMs */
function disconnectTurnWaitMs(vuIndex) {
  const vu = Math.max(1, Number(vuIndex) || 1);
  const turnMs = Math.max(DISCONNECT_GAP_MS, 50);
  return Math.max(0, vu - 1) * turnMs;
}

/** เวลารอให้ VU สุดท้ายเข้า bidding แล้วบิดครบ (นับจากปลาย setup) */
function disconnectBarrierOffsetMs() {
  const n = Math.max(1, VUS);
  const spreadMs = Math.max(WS_REJOIN_STAGGER_MS, STAGGER_MS, DISCONNECT_GAP_MS);
  return (
    Math.max(0, n - 1) * spreadMs +
    BIDDING_DURATION_MS +
    JOIN_SETTLE_MS +
    ACK_TIMEOUT_MS +
    30000
  );
}

/** budget รวมของ scenario เมื่อ disconnect — สูตรจากจำนวน VU */
function disconnectScenarioBudgetMs() {
  const n = Math.max(1, VUS);
  const turnMs = Math.max(DISCONNECT_GAP_MS, 50);
  return (
    disconnectBarrierOffsetMs() +
    Math.max(0, n - 1) * turnMs +
    n * 5000 +
    180000
  );
}

const DISCONNECT_CLEANUP_MS = DISCONNECTED_ENABLED ? disconnectScenarioBudgetMs() - BIDDING_DURATION_MS : 0;
// disconnect ทำใน group 4 (barrier → คิวทีละคน → WS leaveLot) — WS hold ครอบแค่ bidding + drain
const WS_HOLD_MS = DISCONNECTED_ENABLED
  ? BIDDING_DURATION_MS + ACK_TIMEOUT_MS + JOIN_SETTLE_MS + 30000
  : BIDDING_DURATION_MS + POST_BID_HOLD_MS;

// Log action names — single source of truth (JS key -> wire action string).
// Convention: <domain>.<step>.<phase> e.g. auth.login.ok, ws.join.setup.ok
const ACTION_NAMES = {
  authLoginStart: 'auth.login.start',
  authLoginOk: 'auth.login.ok',
  authLoginFail: 'auth.login.fail',
  authLoginHint: 'auth.login.hint',
  lotBidderWarn: 'lotbidder.fetch.warn',
  lotBidderStart: 'lotbidder.fetch.start',
  lotBidderOk: 'lotbidder.fetch.ok',
  lotBidderFail: 'lotbidder.fetch.fail',
  lotBidderRetry: 'lotbidder.fetch.retry',
  lotBidderPreparedFail: 'lotbidder.prepared.fail',
  wsJoinSetupStart: 'ws.join.setup.start',
  wsJoinSetupOpen: 'ws.join.setup.open',
  wsJoinSetupSettled: 'ws.join.setup.settled',
  wsJoinSetupFail: 'ws.join.setup.fail',
  wsJoinSetupTimeout: 'ws.join.setup.timeout',
  wsJoinPreparedFail: 'ws.join.prepared.fail',
  wsRejoinStart: 'ws.rejoin.start',
  wsRejoinStagger: 'ws.rejoin.stagger',
  wsOpen: 'ws.open',
  wsClose: 'ws.close',
  wsHoldStart: 'ws.hold.start',
  wsHoldEnd: 'ws.hold.end',
  wsHoldError: 'ws.hold.notification_error',
  wsJoinTimeout: 'ws.join.timeout',
  wsConnectedFail: 'ws.connected.fail',
  wsSocketError: 'ws.socket.error',
  wsPingRecv: 'ws.ping.recv',
  wsPongSend: 'ws.pong.send',
  wsMessage: 'ws.message',
  wsMessageRaw: 'ws.message.raw',
  visitLotSend: 'ws.visitLot.send',
  connectedSend: 'ws.connected.send',
  leaveLotSend: 'ws.leaveLot.send',
  leaveLotWait: 'ws.leaveLot.wait',
  disconnectedSend: 'ws.disconnected.send',
  biddingSend: 'ws.bidding.send',
  biddingLoopStart: 'ws.bidding.loop.start',
  biddingSkipped: 'ws.bidding.skip',
  ackLoopStart: 'ws.ack.loop.start',
  ackPhase: 'ws.ack.phase',
  ackOk: 'ws.ack.ok',
  ackSelf: 'ws.ack.self',
  ackRetry: 'ws.ack.retry',
  ackTimeout: 'ws.ack.timeout',
  ackFail: 'ws.ack.fail',
  wsReconnect: 'ws.reconnect',
  wsReconnectGaveUp: 'ws.reconnect.gave_up',
  wsReconnectLoginOk: 'ws.reconnect.login.ok',
  wsReconnectLoginFail: 'ws.reconnect.login.fail',
  batchPreparedUse: 'setup.use_prepared',
  iterationStart: 'iteration.start',
  iterationAbort: 'iteration.abort',
  iterationDone: 'iteration.done',
  pickBuyer: 'buyer.pick',
  vuComplete: 'vu.complete',
  // Phase 2 & 3 transitions
  biddingLoopEnd: 'ws.bidding.loop.end',
  postreqDrainStart: 'postreq.drain.start',
  postreqDrainOk: 'postreq.drain.ok',
  postreqDrainTimeout: 'postreq.drain.timeout',
  postreqHoldStart: 'postreq.hold.start',
  postreqCloseOk: 'postreq.close.ok',
};

// VU step names (stored in vu-complete JSON) -> display labels for stdout/HTML.
// Raw values stay stable; only the display layer uses STEP_DISPLAY_NAMES.
const STEP_DISPLAY_NAMES = {
  login: 'Login',
  setup_prepared: 'Setup prepared data',
  setup_ws_join: 'Setup WS join',
  ws_bidding: 'WS bidding',
  'ws.hold.end': 'WS hold done',
  ws_upgrade_failed: 'WS upgrade failed',
  socket_error: 'WS socket error',
  join_timeout: 'WS join timeout',
  join_notification_error: 'WS join rejected',
  ws_remote_close: 'WS remote close',
  ws_join_setup: 'Setup WS join',
  postrequisite_drain_timeout: 'Postreq drain timeout',
  postrequisite_disconnect: 'Postreq disconnect',
  exception: 'Exception',
  unknown: 'Unknown',
};

function biddingGapMs() {
  if (!ACK_ENABLED) {
    return BIDDING_DELAY_MS > 0 ? BIDDING_DELAY_MS : BIDDING_INTERVAL_MS;
  }
  return ACK_COOLDOWN_MS + BIDDING_DELAY_MS;
}

const SETUP_UNLIMITED_MS = 24 * 60 * 60 * 1000;

function resolveSetupTimeout() {
  const raw = String(__ENV.SETUP_TIMEOUT || __ENV.SETUP_TIMEOUT_MS || '0').trim();
  if (['0', '0s', '0ms', 'unlimited', 'none', 'inf', 'infinite'].includes(raw.toLowerCase())) {
    return '24h';
  }
  return msToDuration(parseDurationMs(raw, SETUP_UNLIMITED_MS));
}

const SETUP_TIMEOUT = resolveSetupTimeout();

const REJOIN_STAGGER_BUDGET_MS = Math.max(0, (Math.max(1, VUS) - 1) * Math.max(0, WS_REJOIN_STAGGER_MS));
const SCENARIO_WALL_CLOCK_MS = DISCONNECTED_ENABLED
  ? REJOIN_STAGGER_BUDGET_MS + disconnectScenarioBudgetMs()
  : WS_HOLD_MS + WS_TIMEOUT_MS + REJOIN_STAGGER_BUDGET_MS + 120000;
const MAX_DURATION =
  __ENV.MAX_DURATION ||
  `${Math.max(2, Math.ceil(SCENARIO_WALL_CLOCK_MS / 60000))}m`;
const GRACEFUL_STOP = DISCONNECTED_ENABLED
  ? msToDuration(Math.max(180000, Math.max(0, VUS - 1) * Math.max(DISCONNECT_GAP_MS, 50) + 120000))
  : '10s';

function nowIso() {
  return new Date().toISOString();
}

// vuContext / logInfo / logWarn / logError / logSetup* มาจาก lib/k6-pretty-log.js

function newVuCompleteRecord() {
  const { vu, iter } = vuContext();
  return {
    vu: vu,
    iter: iter,
    username: '',
    step: 'unknown',
    error: '',
    outcome: 'error',
    result: 'FAIL',
    at: nowIso(),
  };
}

function formatVuCompleteError(err) {
  if (err == null || err === '') return '';
  if (typeof err === 'string') return err.slice(0, 500);
  const parts = [];
  if (err.reason) parts.push(String(err.reason));
  if (err.code) parts.push('code=' + err.code);
  if (err.message) parts.push(String(err.message));
  if (err.detail && String(err.detail) !== String(err.message || '')) parts.push(String(err.detail));
  if (err.httpStatus != null) parts.push('httpStatus=' + err.httpStatus);
  if (err.timeoutMs != null) parts.push('timeoutMs=' + err.timeoutMs);
  return parts.join(' ').slice(0, 500);
}

function recordVuComplete(rec) {
  const row = {
    vu: rec && rec.vu != null ? rec.vu : 0,
    iter: rec && rec.iter != null ? rec.iter : 0,
    username: rec && rec.username ? String(rec.username) : '',
    buyer: rec && rec.username ? String(rec.username) : '',
    step: rec && rec.step ? String(rec.step) : 'unknown',
    stepLabel: STEP_DISPLAY_NAMES[rec && rec.step] || String((rec && rec.step) || 'unknown'),
    error: rec && rec.error ? String(rec.error) : '',
    outcome: rec && rec.outcome === 'ok' ? 'ok' : 'error',
    result: rec && rec.outcome === 'ok' ? 'PASS' : 'FAIL',
    at: rec && rec.at ? rec.at : nowIso(),
  };
  const line = `buyer=${row.username || '-'} vu=${row.vu} iter=${row.iter} step=${row.stepLabel} result=${row.result} detail=${row.error || '-'}`;
  if (row.outcome === 'ok') {
    logInfo(ACTION_NAMES.vuComplete, line);
  } else {
    logError(ACTION_NAMES.vuComplete, line);
  }
  check(null, {
    [VU_COMPLETE_CHECK_PREFIX + encoding.b64encode(JSON.stringify(row))]: () => true,
  });
}

function collectGroupChecks(group, out) {
  if (!group) return;
  const checks = group.checks || [];
  for (let i = 0; i < checks.length; i++) {
    out.push(checks[i]);
  }
  const groups = group.groups || [];
  for (let j = 0; j < groups.length; j++) {
    collectGroupChecks(groups[j], out);
  }
}

function extractVuCompletions(summaryData) {
  const checks = [];
  collectGroupChecks(summaryData && summaryData.root_group, checks);
  const items = [];
  const seen = {};
  for (let i = 0; i < checks.length; i++) {
    const name = checks[i] && checks[i].name ? String(checks[i].name) : '';
    if (name.indexOf(VU_COMPLETE_CHECK_PREFIX) !== 0) continue;
    const b64 = name.slice(VU_COMPLETE_CHECK_PREFIX.length);
    let parsed = null;
    try {
      parsed = JSON.parse(encoding.b64decode(b64, 'std', 's'));
    } catch (_) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const buyerName = parsed.username || parsed.buyer || '';
    const stepName = parsed.step || 'unknown';
    const key = [parsed.vu, parsed.iter, buyerName, stepName, parsed.at].join('|');
    if (seen[key]) continue;
    seen[key] = true;
    items.push({
      vu: parsed.vu,
      iter: parsed.iter,
      username: buyerName,
      buyer: buyerName,
      step: stepName,
      stepLabel: parsed.stepLabel || STEP_DISPLAY_NAMES[stepName] || stepName,
      error: parsed.error || '',
      outcome: parsed.outcome || 'error',
      result: parsed.result || (parsed.outcome === 'ok' ? 'PASS' : 'FAIL'),
      at: parsed.at || '',
    });
  }
  items.sort(function (a, b) {
    const ua = String(a.username || '');
    const ub = String(b.username || '');
    if (ua < ub) return -1;
    if (ua > ub) return 1;
    const va = Number(a.vu) || 0;
    const vb = Number(b.vu) || 0;
    if (va !== vb) return va - vb;
    return (Number(a.iter) || 0) - (Number(b.iter) || 0);
  });
  return items;
}

function formatVuCompleteStdout(items) {
  const rows = (items || []).map(function (r) {
    const ok = r.outcome === 'ok' || r.result === 'PASS';
    const stepLabel = r.stepLabel || STEP_DISPLAY_NAMES[r.step] || String(r.step || '-');
    return [
      { text: truncateVis(String(r.buyer || r.username || '-'), 28) },
      { text: String(r.vu), align: 'right' },
      { text: truncateVis(stepLabel, 28) },
      { text: (ok ? '✔ ' : '✖ ') + (ok ? 'PASS' : 'FAIL'), color: ok ? 'green' : 'red' },
      { text: r.error ? truncateVis(String(r.error), 34) : '-', color: r.error ? 'red' : 'gray' },
    ];
  });
  const headers = [
    { label: 'buyer', width: 28 },
    { label: 'vu', width: 4, align: 'right' },
    { label: 'step', width: 28 },
    { label: 'result', width: 10 },
    { label: 'detail', width: 34 },
  ];
  const table = boxTable('VU results (' + rows.length + ') — sorted by buyer', headers, rows);
  return ['', table, ''].join('\n');
}

function vuCompleteJsonPath() {
  const reportDir = (__ENV.REPORT_DIR || 'k6-reports').replace(/\/$/, '');
  const basename = __ENV.REPORT_BASENAME || 'buyer-send-bidding-buffer-2';
  return __ENV.VU_COMPLETE_JSON || reportDir + '/' + basename + '-vu-complete.json';
}

function formatHttpError(res, body) {
  const parts = [];
  if (res) parts.push(`status=${res.status}`);
  if (body && body.code) parts.push(`code=${body.code}`);
  if (body && body.message) parts.push(`message=${body.message}`);
  return parts.join(' ');
}

function describeWsNotification(msg) {
  if (!msg || typeof msg !== 'object') return `raw=${String(msg).slice(0, 120)}`;
  const payload = msg.payload || {};
  const parts = [
    `type=${msg.type || '-'}`,
    payload.code ? `code=${payload.code}` : null,
    payload.level ? `level=${payload.level}` : null,
    payload.message ? `message=${payload.message}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

/** banner สรุป config ของ run — แสดงตอน setup() เริ่ม (labels ตรงกับ dashboard) */
function logRunBanner() {
  logBanner('k6 buyer bidding — buffer-2 (3-Phase Flow)', [
    ['ENDPOINT', BASE_URL],
    ['WEBSOCKET', WS_URL],
    ['TARGET', `lot=${LOT_ID} · lotLine=${LOT_LINE_ID} · auctionNo=${AUCTION_NO}`],
    ['BUYERS', `${BUYER_USERS.length} buyers · ${USERNAME_PREFIX} ${START_LOOP_INDEX}..${END_LOOP_INDEX} · pickMode=${USER_PICK}`],
    ['LOAD', `executor=${EXECUTOR} · vus=${VUS} · iterationsPerVu=${ITERATIONS}`],
    ['PHASE 1 (PREREQ)', `setup=sequential (login → lot-bidder → wsJoin) · vu=staggered start (${WS_REJOIN_STAGGER_MS}ms login→join) · settle=${JOIN_SETTLE_MS}ms`],
    ['PHASE 2 (BIDDING)', `${BIDDING_ENABLED ? `window=${msToDuration(BIDDING_DURATION_MS)} · ack=${ACK_ENABLED ? 'on' : 'off'} · order=${BIDDING_ORDER}${BIDDING_ORDER === 'sequence' ? ` (turn=${BIDDING_TURN_MS}ms · cycle≈${VUS * BIDDING_TURN_MS}ms)` : ''} · gap=${biddingGapMs()}ms · stagger=${STAGGER_MS}ms` : 'disabled'}`],
    ['PHASE 3 (POSTREQ)', DISCONNECTED_ENABLED
      ? `drainPendingAck → then PHASE 4 Disconnect (leaveLot→disconnected · vu1→vu${VUS} · gap=${DISCONNECT_GAP_MS}ms · after ALL bidding done) · totalHold≈${msToDuration(WS_HOLD_MS)}`
      : `postBidHold=${msToDuration(POST_BID_HOLD_MS)} · drainPendingAck=on · totalHold=${msToDuration(WS_HOLD_MS)} · reconnect=${WS_RECONNECT_ENABLED ? 'on' : 'off'}`],
    ...(DISCONNECTED_ENABLED
      ? [
          [
            'PHASE 4 (DISCONNECT)',
            `step1=wait all bidding (barrier=${msToDuration(disconnectBarrierOffsetMs())}) · step2=vu1→vu${VUS} gap=${DISCONNECT_GAP_MS}ms · budget=${msToDuration(disconnectScenarioBudgetMs())}`,
          ],
          ['SCENARIO LIMITS', `maxDuration=${MAX_DURATION} · gracefulStop=${GRACEFUL_STOP} · wallClock≈${msToDuration(SCENARIO_WALL_CLOCK_MS)}`],
        ]
      : []),
    ['TIMEOUTS', `setup=${SETUP_TIMEOUT} · wsJoin=${WS_TIMEOUT_MS}ms · http=${HTTP_TIMEOUT_MS}ms`],
  ]);
}

function maskToken(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 10) return '***';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function buildScenario() {
  if (EXECUTOR === 'constant') {
    return {
      executor: 'constant-vus',
      vus: VUS,
      duration: __ENV.DURATION || `${Math.ceil(WS_HOLD_MS / 1000)}s`,
      gracefulStop: GRACEFUL_STOP,
    };
  }
  // default: ทุก VU join แล้วค้าง connection ตาม WS_HOLD
  return {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: ITERATIONS,
    maxDuration: MAX_DURATION,
    gracefulStop: GRACEFUL_STOP,
  };
}

export const options = {
  setupTimeout: SETUP_TIMEOUT,
  scenarios: {
    buyer_send_bidding: buildScenario(),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    http_req_failed: ['rate<0.1'],
    checks: ['rate>0.9'],
    login_duration_ms: ['p(95)<5000'],
    lot_bidder_number_duration_ms: ['p(95)<15000'],
    ws_join_prepare_duration_ms: ['p(95)<15000'],
  },
};

function requireEnv() {
  if (!LOT_ID) {
    fail(`ขาด env: LOT_ID — ตัวอย่าง: -e LOT_ID=975`);
  }
  if (!Array.isArray(BUYER_USERS) || BUYER_USERS.length === 0) {
    fail('BUYER_USERS ต้องเป็น array และมีอย่างน้อย 1 buyer');
  }
  if (BIDDING_ENABLED) {
    if (!Number.isFinite(LOT_LINE_ID) || LOT_LINE_ID <= 0) {
      fail(`ขาด/ผิด env: LOT_LINE_ID — ตัวอย่าง: -e LOT_LINE_ID=10360`);
    }
    if (!Number.isFinite(AUCTION_NO) || AUCTION_NO <= 0) {
      fail(`ขาด/ผิด env: AUCTION_NO — ตัวอย่าง: -e AUCTION_NO=1`);
    }
    if (ACK_ENABLED) {
      if (!Number.isFinite(STAGGER_MS) || STAGGER_MS < 0) {
        fail(`ผิด env: STAGGER_MS ต้องเป็นจำนวน >= 0 (ms)`);
      }
      if (!Number.isFinite(ACK_TIMEOUT_MS) || ACK_TIMEOUT_MS <= 0) {
        fail(`ผิด env: ACK_TIMEOUT_MS ต้องเป็นจำนวนบวก (ms)`);
      }
      if (!Number.isFinite(ACK_RETRY_MS) || ACK_RETRY_MS < 0) {
        fail(`ผิด env: ACK_RETRY_MS ต้องเป็นจำนวน >= 0 (ms)`);
      }
      if (!Number.isFinite(ACK_COOLDOWN_MS) || ACK_COOLDOWN_MS < 0) {
        fail(`ผิด env: ACK_COOLDOWN_MS ต้องเป็นจำนวน >= 0 (ms)`);
      }
      if (!Number.isFinite(ACK_TICK_MS) || ACK_TICK_MS <= 0) {
        fail(`ผิด env: ACK_TICK_MS ต้องเป็นจำนวนบวก (ms)`);
      }
      if (BIDDING_ORDER !== 'sequence' && BIDDING_ORDER !== 'parallel') {
        fail(`ผิด env: BIDDING_ORDER ต้องเป็น sequence หรือ parallel (ได้: ${BIDDING_ORDER})`);
      }
      if (BIDDING_ORDER === 'sequence' && (!Number.isFinite(BIDDING_TURN_MS) || BIDDING_TURN_MS <= 0)) {
        fail(`ผิด env: BIDDING_TURN_MS ต้องเป็นจำนวนบวก (ms)`);
      }
    } else if (!Number.isFinite(BIDDING_INTERVAL_MS) || BIDDING_INTERVAL_MS <= 0) {
      fail(`ผิด env: BIDDING_INTERVAL_MS ต้องเป็นจำนวนบวก (ms)`);
    }
  }
  if (!Number.isFinite(WS_REJOIN_STAGGER_MS) || WS_REJOIN_STAGGER_MS < 0) {
    fail(`ผิด env: WS_REJOIN_STAGGER_MS ต้องเป็นจำนวน >= 0 (ms)`);
  }
  if (!Number.isFinite(WS_RECONNECT_DELAY_MS) || WS_RECONNECT_DELAY_MS < 0) {
    fail(`ผิด env: WS_RECONNECT_DELAY_MS ต้องเป็นจำนวน >= 0 (ms)`);
  }
  if (!Number.isFinite(WS_RECONNECT_MAX) || WS_RECONNECT_MAX < 0) {
    fail(`ผิด env: WS_RECONNECT_MAX ต้องเป็นจำนวน >= 0 (0 = unlimited)`);
  }
}

/** รอจนถึงขอบ interval ถัดไปของ wall-clock เพื่อให้ทุก VU ส่งพร้อมกัน */
function msUntilNextAlignedTick(intervalMs) {
  const now = Date.now();
  const rem = now % intervalMs;
  return rem === 0 ? 0 : intervalMs - rem;
}

/**
 * เลือก buyer จาก list
 * - round: (__VU - 1 + __ITER) % n
 * - vu:    (__VU - 1) % n   (sticky ต่อ VU)
 */
function pickBuyer() {
  const n = BUYER_USERS.length;
  let idx;
  if (USER_PICK === 'vu') {
    idx = (__VU - 1) % n;
  } else {
    idx = (__VU - 1 + __ITER) % n;
  }
  const buyer = BUYER_USERS[idx];
  if (!buyer || !buyer.username || !buyer.password || !buyer.loginType) {
    fail(`BUYER_USERS[${idx}] ไม่ครบ username/password/loginType`);
  }
  logInfo(ACTION_NAMES.pickBuyer, `idx=${idx} buyer=${buyer.username} loginType=${buyer.loginType} pickMode=${USER_PICK}`);
  return { buyer, idx };
}

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function authHeaders(accessToken, serviceName, buyer) {
  const headers = {
    'Content-Type': 'application/json',
    'X-User-Type': buyer.loginType,
  };
  if (serviceName) {
    headers['X-Service-Name'] = serviceName;
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function login(buyer, opts) {
  const o = opts || {};
  const log = o.log || logInfo;
  const setupMeta = o.setupMeta || null;
  const logStep = function (action, detail, meta) {
    if (setupMeta) {
      logSetup(action, detail, Object.assign({}, setupMeta, meta || {}));
      return;
    }
    log(action, detail);
  };

  logStep(ACTION_NAMES.authLoginStart, `POST ${BASE_URL}/auth/login buyer=${buyer.username} loginType=${buyer.loginType}`, {
    phase: 'LOGIN',
  });
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      username: buyer.username,
      password: buyer.password,
      loginType: buyer.loginType,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-User-Type': buyer.loginType,
      },
      tags: { name: 'POST /auth/login', username: buyer.username, phase: 'prerequisite' },
    }
  );
  loginDuration.add(res.timings.duration, { phase: 'prerequisite' });

  const body = parseJson(res);
  const data = body && body.data ? body.data : {};
  const ok = check(res, {
    'login status 200': (r) => r.status === 200,
    'login has accessToken': () => !!data.accessToken,
    'login has entryKey': () => !!data.entryKey,
  }, { phase: 'prerequisite' });
  if (!ok) {
    loginFail.add(1, { phase: 'prerequisite' });
    const errDetail = formatHttpError(res, body);
    logError(ACTION_NAMES.authLoginFail, `buyer=${buyer.username} ${errDetail} durationMs=${res.timings.duration} body=${res.body}`);
    logError(
      ACTION_NAMES.authLoginHint,
      `E2001 = buyer not found for buyer="${buyer.username}" loginType="${buyer.loginType}" on ${BASE_URL}`
    );
    if (setupMeta) {
      logSetup(ACTION_NAMES.authLoginFail, `buyer=${buyer.username} ${errDetail}`, Object.assign({}, setupMeta, { phase: 'LOGIN', status: 'FAIL' }));
    }
    return {
      session: null,
      error: {
        step: 'login',
        username: buyer.username,
        status: res.status,
        code: body && body.code,
        message: body && body.message,
      },
    };
  }

  loginOk.add(1, { phase: 'prerequisite' });
  logStep(
    ACTION_NAMES.authLoginOk,
    `buyer=${buyer.username} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} entryKey=${maskToken(data.entryKey)} sessionId=${maskToken(data.sessionId)} accessToken=${maskToken(data.accessToken)}`,
    { phase: 'LOGIN', status: 'OK' }
  );

  return {
    session: {
      accessToken: data.accessToken,
      entryKey: data.entryKey,
      sessionId: data.sessionId || '',
      buyer,
    },
    error: null,
  };
}

function fetchLotBidderNumber(session, options) {
  const opts = options || {};
  const buyerName = session.buyer.username;
  const sequential = opts.sequential === true;
  const recordChecks = opts.recordChecks !== false;
  const setupMeta = opts.setupMeta || null;

  if (!sequential) {
    logWarn(ACTION_NAMES.lotBidderWarn, 'called outside setup — buffer script expects setup() prep');
  }

  let lastRes = null;
  let lastBody = null;
  let bidderNumber = '';

  for (let attempt = 1; attempt <= LOT_BIDDER_RETRIES; attempt++) {
    const attemptMeta = {
      phase: 'LOT-BIDDER',
      attempt: attempt,
      maxAttempts: LOT_BIDDER_RETRIES,
    };
    if (attempt > 1) {
      if (setupMeta) {
        logSetupRule();
        logSetup(
          ACTION_NAMES.lotBidderRetry,
          `buyer=${buyerName} lotId=${LOT_ID} waitingMs=${LOT_BIDDER_RETRY_MS}`,
          Object.assign({}, setupMeta, attemptMeta, { status: 'RETRY' })
        );
      } else {
        logInfo(
          ACTION_NAMES.lotBidderRetry,
          `buyer=${buyerName} lotId=${LOT_ID} attempt=${attempt}/${LOT_BIDDER_RETRIES} waitingMs=${LOT_BIDDER_RETRY_MS}`
        );
      }
    }

    if (setupMeta) {
      logSetup(
        ACTION_NAMES.lotBidderStart,
        `POST ${BASE_URL}/users/lot-bidder-number buyer=${buyerName} lotId=${LOT_ID}`,
        Object.assign({}, setupMeta, attemptMeta)
      );
    } else {
      logInfo(
        ACTION_NAMES.lotBidderStart,
        `POST ${BASE_URL}/users/lot-bidder-number buyer=${buyerName} lotId=${LOT_ID} attempt=${attempt}/${LOT_BIDDER_RETRIES}`
      );
    }
    const res = http.post(
      `${BASE_URL}/users/lot-bidder-number`,
      JSON.stringify({ lotId: Number(LOT_ID) }),
      {
        headers: authHeaders(session.accessToken, 'user-service', session.buyer),
        tags: {
          name: sequential ? 'SETUP POST /users/lot-bidder-number' : 'POST /users/lot-bidder-number',
          username: buyerName,
          phase: 'prerequisite',
        },
        timeout: `${HTTP_TIMEOUT_MS}ms`,
      }
    );
    lastRes = res;
    lastBody = parseJson(res);
    const data = lastBody && lastBody.data ? lastBody.data : null;
    bidderNumber = data && data.bidderNumber != null ? String(data.bidderNumber) : '';

    const ok = res.status === 200 && bidderNumber !== '';
    if (ok) {
      bidderDuration.add(res.timings.duration, { phase: 'prerequisite' });
      if (recordChecks) {
        check(res, {
          'lot-bidder fetch status 200': (r) => r.status === 200,
          'lot-bidder fetch has bidderNumber': () => bidderNumber !== '',
        }, { phase: 'prerequisite' });
      }
      if (setupMeta) {
        logSetup(
          ACTION_NAMES.lotBidderOk,
          `buyer=${buyerName} lotId=${LOT_ID} bidderNumber=${bidderNumber} status=${res.status} durationMs=${res.timings.duration.toFixed(1)}`,
          Object.assign({}, setupMeta, attemptMeta, { status: 'OK' })
        );
      } else {
        logInfo(
          ACTION_NAMES.lotBidderOk,
          `buyer=${buyerName} lotId=${LOT_ID} bidderNumber=${bidderNumber} status=${res.status} durationMs=${res.timings.duration.toFixed(1)} attempt=${attempt}`
        );
      }
      return bidderNumber;
    }

    if (setupMeta) {
      logSetup(
        ACTION_NAMES.lotBidderFail,
        `buyer=${buyerName} lotId=${LOT_ID} status=${res.status} code=${lastBody && lastBody.code} durationMs=${res.timings.duration.toFixed(1)}`,
        Object.assign({}, setupMeta, attemptMeta, { status: 'FAIL' })
      );
    } else {
      logError(
        ACTION_NAMES.lotBidderFail,
        `buyer=${buyerName} lotId=${LOT_ID} attempt=${attempt}/${LOT_BIDDER_RETRIES} status=${res.status} code=${lastBody && lastBody.code} durationMs=${res.timings.duration} body=${res.body}`
      );
    }
    if (attempt < LOT_BIDDER_RETRIES) {
      sleep(LOT_BIDDER_RETRY_MS / 1000);
    }
  }

  if (recordChecks) {
    check(lastRes, {
      'lot-bidder fetch status 200': (r) => r && r.status === 200,
      'lot-bidder fetch has bidderNumber': () => bidderNumber !== '',
    }, { phase: 'prerequisite' });
  }
  return '';
}

function prepareLotBidderNumbers() {
  const preparedByBuyer = {};
  const failedBuyers = [];
  const total = BUYER_USERS.length;

  logSetupDivider('lot-bidder + WS join batch START', '📦');
  logSetup(
    'setup.batch.config',
    `buyers=${total} lotId=${LOT_ID} lotBidderGapMs=${LOT_BIDDER_GAP_MS} wsJoinGapMs=${WS_JOIN_GAP_MS} lotBidderRetries=${LOT_BIDDER_RETRIES} httpTimeoutMs=${HTTP_TIMEOUT_MS} wsJoinSettleMs=${JOIN_SETTLE_MS}`,
    {
      phase: 'CONFIG',
    }
  );
  logSetupRule();

  for (let i = 0; i < total; i++) {
    const buyer = BUYER_USERS[i];
    const round = `${i + 1}/${total}`;
    const setupMeta = { round: round };

    logSetupDivider(`BUYER ${round} — ${buyer.username}`, '🎫');

    const loginResult = login(buyer, { setupMeta: setupMeta });
    if (!loginResult.session) {
      const err = loginResult.error || {};
      failedBuyers.push(buyer.username);
      lotBidderPrepareFail.add(1, { phase: 'prerequisite' });
      logSetup(
        'setup.batch.buyer.result',
        `buyer=${buyer.username} reason=login_failed step=${err.step || 'login'} code=${err.code || '-'} message=${err.message || '-'}`,
        {
          round: round,
          phase: 'RESULT',
          status: 'FAIL',
        }
      );
      logSetupRule();
      continue;
    }

    const session = loginResult.session;
    const bidderNumber = fetchLotBidderNumber(session, {
      sequential: true,
      recordChecks: true,
      setupMeta: setupMeta,
    });
    if (!bidderNumber) {
      failedBuyers.push(buyer.username);
      lotBidderPrepareFail.add(1, { phase: 'prerequisite' });
      logSetup('setup.batch.buyer.result', `buyer=${buyer.username} reason=lot_bidder_failed`, {
        round: round,
        phase: 'RESULT',
        status: 'FAIL',
      });
      logSetupRule();
      continue;
    }

    lotBidderPrepareOk.add(1, { phase: 'prerequisite' });

    const joinResult = runSetupWsJoin(session, bidderNumber, { setupMeta: setupMeta });
    if (!joinResult.ok) {
      const err = joinResult.error || {};
      failedBuyers.push(buyer.username);
      wsJoinPrepareFail.add(1, { phase: 'prerequisite' });
      logSetup(
        'setup.batch.buyer.result',
        `buyer=${buyer.username} reason=ws_join_failed step=${err.step || 'ws_join_setup'} code=${err.code || '-'} message=${err.message || err.detail || err.reason || '-'}`,
        {
          round: round,
          phase: 'RESULT',
          status: 'FAIL',
        }
      );
      logSetupRule();
      continue;
    }

    wsJoinPrepareOk.add(1, { phase: 'prerequisite' });
    preparedByBuyer[buyer.username] = {
      idx: i,
      username: buyer.username,
      bidderNumber: bidderNumber,
      joinOk: true,
      joinDurationMs: joinResult.durationMs || 0,
    };
    logSetup(
      'setup.batch.buyer.result',
      `buyer=${buyer.username} bidderNumber=${bidderNumber} joinOk=true joinMs=${joinResult.durationMs || 0}`,
      {
        round: round,
        phase: 'RESULT',
        status: 'OK',
      }
    );
    logSetupRule();

    const gapMs = WS_JOIN_GAP_MS > 0 ? WS_JOIN_GAP_MS : LOT_BIDDER_GAP_MS;
    if (gapMs > 0 && i < total - 1) {
      logSetup('setup.batch.gap', `waitingMs=${gapMs} before next buyer`, { round: round, phase: 'GAP' });
      sleep(gapMs / 1000);
    }
  }

  logSetupDivider('lot-bidder + WS join batch DONE', '🏁');
  logSetup(
    'setup.batch.summary',
    `ok=${Object.keys(preparedByBuyer).length} fail=${failedBuyers.length} total=${total}`,
    { phase: 'SUMMARY', status: failedBuyers.length > 0 ? 'PARTIAL' : 'OK' }
  );

  if (failedBuyers.length > 0) {
    logError('setup.batch.failed_buyers', `buyers=${failedBuyers.join(', ')}`);
  }

  return {
    preparedByUsername: preparedByBuyer,
    preparedCount: Object.keys(preparedByBuyer).length,
    failedUsernames: failedBuyers,
    prepareMode: 'setup-sequential-lot-bidder-and-ws-join',
    // absolute time: หลังจุดนี้ถือว่าทุก VU ควรบิดครบแล้ว → เริ่มคิว disconnect ทีละคน
    disconnectBarrierAtMs: DISCONNECTED_ENABLED ? Date.now() + disconnectBarrierOffsetMs() : 0,
  };
}

export function setup() {
  requireEnv();
  logRunBanner();
  return prepareLotBidderNumbers();
}

function isJoinError(msg) {
  if (!msg || msg.type !== 'notification') return false;
  const payload = msg.payload || {};
  const level = String(payload.level || '').toLowerCase();
  const code = String(payload.code || '');
  if (level === 'error') return true;
  if (code === 'WS00043') return true;
  if (code.toLowerCase().includes('connectedincorrectly')) return true;
  return false;
}

function msgCode(msg) {
  const payload = msg && msg.payload ? msg.payload : {};
  return String(payload.code || '');
}

function isAckExpectedError(code) {
  return (
    code === 'E5002' ||
    code === 'E5013' ||
    code === 'WS20003' ||
    code === 'WS20005' ||
    code === 'WS20009' ||
    code === 'WS20010' ||
    code === 'WS20012' ||
    code === 'WS40002' ||
    code === 'WS40003' ||
    code === 'WS40004'
  );
}


function bidBlockedStatus(status) {
  return (
    status === 'pause' ||
    status === 'sold' ||
    status === 'pass' ||
    status === 'hold' ||
    status === 'waiting' ||
    status === 'pending' ||
    status === 'ready'
  );
}

function isOwnBidder(payload, bidderNumber) {
  const p = payload || {};
  if (bidderNumber && String(p.bidderNumber || '') === String(bidderNumber)) return true;
  return false;
}

/**
 * สร้าง WS message แบบ dynamic
 * @param {string} type
 * @param {object} [options]
 * @param {string[]} [options.lots]
 * @param {object} [options.payload]  ถ้ามีจะใส่ใต้ key payload
 * @param {object} [options.fields]   merge เข้า top-level ของ message
 */
function buildWsMessage(type, options) {
  const opts = options || {};
  const msg = { type: type };
  if (opts.lots !== undefined) {
    msg.lots = opts.lots;
  } else if (type !== 'pong') {
    msg.lots = [LOT_ID];
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

/** สรุป field สำหรับ log (mask ค่า sensitive) */
function summarizeWsMessage(msg) {
  const parts = [`type=${msg.type || '-'}`];
  if (msg.lots) parts.push(`lots=[${msg.lots.join(',')}]`);
  if (msg.bidderNumber != null) parts.push(`bidderNumber=${msg.bidderNumber}`);
  if (msg.isControl != null) parts.push(`isControl=${msg.isControl}`);
  if (msg.entryKey) parts.push(`entryKey=${maskToken(msg.entryKey)}`);
  if (msg.payload) {
    if (msg.payload.entryKey) parts.push(`payload.entryKey=${maskToken(msg.payload.entryKey)}`);
    if (msg.payload.lots) parts.push(`payload.lots=[${msg.payload.lots.join(',')}]`);
    if (msg.payload.isControl != null) parts.push(`payload.isControl=${msg.payload.isControl}`);
    if (msg.payload.bidderNumber != null) parts.push(`payload.bidderNumber=${msg.payload.bidderNumber}`);
    if (msg.payload.action != null) parts.push(`payload.action=${msg.payload.action}`);
    if (msg.payload.lotLineId != null) parts.push(`payload.lotLineId=${msg.payload.lotLineId}`);
    if (msg.payload.auctionNo != null) parts.push(`payload.auctionNo=${msg.payload.auctionNo}`);
    if (msg.payload.event != null) parts.push(`payload.event=${msg.payload.event}`);
  }
  return parts.join(' ');
}

/**
 * ส่ง WS message แบบ reuse ได้
 * @param {object} socket
 * @param {object} buyer
 * @param {string} type
 * @param {object} [options]  ดู buildWsMessage + logAction
 * @returns {object} message ที่ส่งไป
 */
function sendWsMessage(socket, buyer, type, options) {
  const opts = options || {};
  const msg = buildWsMessage(type, opts);
  const logAction = opts.logAction || `ws.${type}.send`;
  logInfo(logAction, `buyer=${buyer.username} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  return msg;
}

// Backward-compatible alias.
function sendWs(socket, buyer, type, options) {
  return sendWsMessage(socket, buyer, type, options);
}

function sendBiddingOffer(socket, buyer, bidderNumber, reason) {
  const msg = buildWsMessage('bidding', {
    lots: [LOT_ID],
    payload: {
      action: BIDDING_ACTION,
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      event: BIDDING_EVENT,
      bidderNumber: String(bidderNumber),
    },
  });
  const ts = nowIso();
  const reasonStr = reason ? ` reason=${reason}` : '';
  logInfo(ACTION_NAMES.biddingSend, `buyer=${buyer.username}${reasonStr} ts=${ts} ${summarizeWsMessage(msg)}`);
  socket.send(JSON.stringify(msg));
  biddingSent.add(1, { phase: 'bidding' });
  return msg;
}

// Backward-compatible alias.
function sendOffer(socket, buyer, bidderNumber, reason) {
  return sendBiddingOffer(socket, buyer, bidderNumber, reason);
}

/**
 * setup-only: WS visitLot → connected → settle → close (ไม่มี bidding)
 * ใช้ buffer ทีละ buyer ใน setup() — socket เก็บข้ามไป VU ไม่ได้
 */
function runSetupWsJoin(session, bidderNumber, opts) {
  const o = opts || {};
  const setupMeta = o.setupMeta || null;
  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  if (session.sessionId) {
    headers.Cookie = `${buyer.loginType}_session_id=${session.sessionId}`;
  }

  const url = `${WS_URL}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
  const started = Date.now();
  let visitLotSent = false;
  let connectedSent = false;
  let connectedDone = false;
  let failed = false;
  let lastError = null;

  const logJoin = function (action, detail, meta) {
    if (setupMeta) {
      logSetup(action, detail, Object.assign({}, setupMeta, meta || {}));
      return;
    }
    logInfo(action, detail);
  };

  logJoin(
    ACTION_NAMES.wsJoinSetupStart,
    `buyer=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} wsJoinSettleMs=${JOIN_SETTLE_MS} wsJoinTimeoutMs=${WS_TIMEOUT_MS}`,
    { phase: 'WS-JOIN' }
  );

  const res = ws.connect(
    url,
    { headers, tags: { name: 'SETUP WS visitLot → connected', username: buyer.username, phase: 'prerequisite' } },
    function (socket) {
      socket.on('open', function () {
        logJoin(ACTION_NAMES.wsJoinSetupOpen, `buyer=${buyer.username}`, { phase: 'WS-JOIN' });

        sendWsMessage(socket, buyer, 'visitLot', {
          lots: [LOT_ID],
          payload: {
            lots: [LOT_ID],
            isControl: false,
            entryKey: session.entryKey,
          },
          logAction: ACTION_NAMES.visitLotSend,
        });
        visitLotSent = true;
        visitOk.add(1, { phase: 'prerequisite' });

        sendWsMessage(socket, buyer, 'connected', {
          lots: [LOT_ID],
          fields: {
            isControl: false,
            entryKey: session.entryKey,
            bidderNumber: bidderNumber,
          },
          logAction: ACTION_NAMES.connectedSend,
        });
        connectedSent = true;

        socket.setTimeout(function () {
          if (failed || connectedDone) return;
          connectedDone = true;
          connectedOk.add(1, { phase: 'prerequisite' });
          logJoin(
            ACTION_NAMES.wsJoinSetupSettled,
            `buyer=${buyer.username} lotId=${LOT_ID} elapsedMs=${Date.now() - started}`,
            { phase: 'WS-JOIN', status: 'OK' }
          );
          socket.close();
        }, JOIN_SETTLE_MS);
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          return;
        }

        if (msg && msg.type === 'ping') {
          pingReceived.add(1, { phase: 'prerequisite' });
          socket.send(JSON.stringify(buildWsMessage('pong')));
          pongSent.add(1, { phase: 'prerequisite' });
          return;
        }

        if (!connectedDone && (visitLotSent || connectedSent) && isJoinError(msg)) {
          failed = true;
          connectedDone = true;
          connectedFail.add(1, { phase: 'prerequisite' });
          const payload = msg.payload || {};
          lastError = {
            step: 'ws_join_setup',
            reason: 'join_notification_error',
            code: payload.code || '',
            level: payload.level || '',
            message: payload.message || '',
            detail: describeWsNotification(msg),
          };
          logSetup(
            ACTION_NAMES.wsJoinSetupFail,
            `buyer=${buyer.username} lotId=${LOT_ID} ${lastError.detail}`,
            Object.assign({}, setupMeta || {}, { phase: 'WS-JOIN', status: 'FAIL' })
          );
          socket.close();
        }
      });

      socket.on('error', function (e) {
        lastError = {
          step: 'ws_join_setup',
          reason: 'socket_error',
          message: String(e),
        };
        logSetup(
          ACTION_NAMES.wsSocketError,
          `buyer=${buyer.username} error=${e}`,
          Object.assign({}, setupMeta || {}, { phase: 'WS-JOIN', status: 'FAIL' })
        );
      });

      socket.setTimeout(function () {
        if (connectedDone || failed) return;
        failed = true;
        connectedFail.add(1, { phase: 'prerequisite' });
        lastError = {
          step: 'ws_join_setup',
          reason: 'join_timeout',
          timeoutMs: WS_TIMEOUT_MS,
        };
        logSetup(
          ACTION_NAMES.wsJoinSetupTimeout,
          `buyer=${buyer.username} lotId=${LOT_ID} timeoutMs=${WS_TIMEOUT_MS}`,
          Object.assign({}, setupMeta || {}, { phase: 'WS-JOIN', status: 'FAIL' })
        );
        socket.close();
      }, WS_TIMEOUT_MS);
    }
  );

  const elapsed = Date.now() - started;
  wsJoinPrepareDuration.add(elapsed, { phase: 'prerequisite' });
  const upgraded = res && res.status === 101;
  const ok = upgraded && connectedDone && !failed;

  if (!upgraded) {
    return {
      ok: false,
      error: {
        step: 'ws_join_setup',
        reason: 'ws_upgrade_failed',
        httpStatus: res && res.status,
      },
    };
  }
  if (failed && lastError) {
    return { ok: false, error: lastError };
  }
  if (!ok) {
    return {
      ok: false,
      error: { step: 'ws_join_setup', reason: 'join_not_settled' },
    };
  }
  return { ok: true, error: null, durationMs: elapsed };
}

/**
 * Group 4 — leaveLot → disconnected บน WS ใหม่ (cleanup เท่านั้น · ไม่นับ metric)
 */
function runDisconnectOnly(session) {
  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  if (session.sessionId) {
    headers.Cookie = `${buyer.loginType}_session_id=${session.sessionId}`;
  }
  const url = `${WS_URL}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
  let done = false;
  let failed = false;

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS disconnect cleanup', username: buyer.username, phase: 'disconnect' } },
    function (socket) {
      socket.on('open', function () {
        sendWsMessage(socket, buyer, 'leaveLot', {
          lots: [LOT_ID],
          payload: {
            lots: [LOT_ID],
            isControl: false,
            entryKey: session.entryKey,
          },
          logAction: ACTION_NAMES.leaveLotSend,
        });
        sendWsMessage(socket, buyer, 'disconnected', {
          lots: [LOT_ID],
          logAction: ACTION_NAMES.disconnectedSend,
        });
        logInfo(
          ACTION_NAMES.wsHoldEnd,
          `buyer=${buyer.username} lotId=${LOT_ID} leaveLot+disconnected done → closing WS`
        );
        done = true;
        socket.close();
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          return;
        }
        if (msg && msg.type === 'ping') {
          socket.send(JSON.stringify(buildWsMessage('pong')));
        }
      });

      socket.on('error', function (e) {
        failed = true;
        logError(ACTION_NAMES.wsSocketError, `buyer=${buyer.username} phase=disconnect error=${e}`);
      });

      socket.setTimeout(function () {
        if (done) return;
        failed = true;
        logWarn(
          ACTION_NAMES.leaveLotWait,
          `buyer=${buyer.username} disconnect ws timeoutMs=${WS_TIMEOUT_MS}`
        );
        socket.close();
      }, WS_TIMEOUT_MS);
    }
  );

  const upgraded = res && res.status === 101;
  if (!upgraded || failed) {
    return {
      ok: false,
      error: failed ? 'disconnect_ws_error' : `httpStatus=${res && res.status}`,
    };
  }
  return { ok: true, error: null };
}

function runWsRejoinBidding(session, bidderNumber, opts) {
  const o = opts || {};
  const biddingDurationMs =
    Number.isFinite(o.biddingDurationMs) && o.biddingDurationMs > 0
      ? Math.floor(o.biddingDurationMs)
      : BIDDING_DURATION_MS;
  const postBidHoldMs =
    Number.isFinite(o.postBidHoldMs) && o.postBidHoldMs >= 0
      ? Math.floor(o.postBidHoldMs)
      : POST_BID_HOLD_MS;
  const holdMs =
    Number.isFinite(o.holdMs) && o.holdMs > 0
      ? Math.floor(o.holdMs)
      : biddingDurationMs + postBidHoldMs;
  const attempt = Number(o.attempt) || 1;
  const biddingStaggerMs =
    o.biddingStaggerMs != null ? Math.max(0, Number(o.biddingStaggerMs)) : Math.max(0, (__VU - 1) * STAGGER_MS);

  const buyer = session.buyer;
  const headers = {
    Authorization: `Bearer ${session.accessToken}`,
    'X-User-Type': buyer.loginType,
  };
  if (session.sessionId) {
    headers.Cookie = `${buyer.loginType}_session_id=${session.sessionId}`;
  }

  const url = `${WS_URL}?userType=${encodeURIComponent(buyer.loginType)}&service=websocket-service`;
  logInfo(
    ACTION_NAMES.wsRejoinStart,
    `buyer=${buyer.username} url=${url} lotId=${LOT_ID} bidderNumber=${bidderNumber} mode=rejoin attempt=${attempt} wsJoinSettleMs=${JOIN_SETTLE_MS} wsJoinTimeoutMs=${WS_TIMEOUT_MS} biddingDurationMs=${biddingDurationMs} postBidHoldMs=${postBidHoldMs} totalHoldMs=${holdMs} bidding=${BIDDING_ENABLED} ack=${ACK_ENABLED} biddingStaggerMs=${biddingStaggerMs} biddingIntervalMs=${BIDDING_INTERVAL_MS} biddingDelayMs=${BIDDING_DELAY_MS}`
  );

  const started = Date.now();
  let visitLotSent = false;
  let connectedSent = false;
  let connectedDone = false;
  let failed = false;
  let holding = false;
  let biddingActive = false;
  let holdTimerFired = false;
  let reachedHolding = false;
  let lastError = null;
  const ackState = {
    pending: false,
    phase: 'bidding',
    retryAt: 0,
    // เวลาส่ง bidding ล่าสุด (ใช้วัด ws_ack_wait_ms แบบ round-trip)
    sentAt: 0,
    // true เมื่อ bid ล่าสุดหมดเวลา ACK_TIMEOUT_MS ไปแล้วแต่ ACK เพิ่งมาถึงทีหลัง
    timedOut: false,
    lastBidBidderNumber: '',
    lastAuctionStatus: '',
    ackGen: 0,
  };

  function switchPhase(next, reason) {
    if (ackState.phase === next) return;
    logInfo(ACTION_NAMES.ackPhase, `buyer=${buyer.username} ${ackState.phase} → ${next} reason=${reason}`);
    ackState.phase = next;
  }

  // เก็บระยะเวลารอ ACK จริง (round-trip ตั้งแต่ส่ง bidding จนได้ response) ลง ws_ack_wait_ms
  // wasLate=true เมื่อ response มาถึงหลัง client timeout ไปแล้ว — ใช้แยก false timeout ฝั่ง client
  function settleAckResponse() {
    const waitedMs = ackState.sentAt > 0 ? Math.max(0, Date.now() - ackState.sentAt) : 0;
    if (waitedMs > 0) ackWaitDurationMs.add(waitedMs, { phase: 'bidding' });
    const wasLate = ackState.timedOut === true;
    ackState.timedOut = false;
    return { waitedMs: waitedMs, wasLate: wasLate };
  }

  const res = ws.connect(
    url,
    { headers, tags: { name: 'WS rejoin → bidding', username: buyer.username, phase: 'prerequisite' } },
    function (socket) {
      function armAckTimeout() {
        const gen = ++ackState.ackGen;
        socket.setTimeout(function () {
          if (gen !== ackState.ackGen || !ackState.pending || failed) return;
          const waitedMs = ackState.sentAt > 0 ? Math.max(0, Date.now() - ackState.sentAt) : ACK_TIMEOUT_MS;
          ackWaitDurationMs.add(waitedMs, { phase: 'bidding' });
          ackState.pending = false;
          // ACK ยังไม่มา — ถ้ามาทีหลังจะถูกนับเป็น ws_ack_late (false timeout ฝั่ง client)
          ackState.timedOut = true;
          ackState.retryAt = Date.now() + ACK_RETRY_MS;
          ackTimeoutCounter.add(1, { phase: 'bidding' });
          logInfo(
            ACTION_NAMES.ackTimeout,
            `buyer=${buyer.username} phase=${ackState.phase} timeoutMs=${ACK_TIMEOUT_MS} waitedMs=${waitedMs} retryInMs=${ACK_RETRY_MS}`
          );
        }, ACK_TIMEOUT_MS);
      }

      function trySendAck() {
        if (!holding || !biddingActive || failed || ackState.pending || ackState.phase === 'idle') return;
        if (Date.now() < ackState.retryAt) return;
        if (bidBlockedStatus(ackState.lastAuctionStatus)) return;
        if (bidderNumber && ackState.lastBidBidderNumber && ackState.lastBidBidderNumber === String(bidderNumber)) return;

        ackState.pending = true;
        ackState.ackGen += 1;
        ackState.sentAt = Date.now(); // เริ่มจับเวลารอ ACK (ws_ack_wait_ms)
        ackState.timedOut = false;
        sendBiddingOffer(socket, buyer, bidderNumber, 'ack');
        armAckTimeout();
      }

      // k6 socket.setTimeout rejects delay <= 0 (VU 1 stagger is 0 by design).
      function schedule(fn, delayMs) {
        const ms = Number(delayMs);
        if (!Number.isFinite(ms) || ms <= 0) {
          fn();
          return;
        }
        socket.setTimeout(fn, ms);
      }

      // Must register setInterval in the connect callback (not inside setTimeout).
      // Nested setInterval never ticks — that is why offer ran once then stopped.
      let ackReadyAt = Number.POSITIVE_INFINITY;
      // โหมด sequence: แบ่งเวลาเป็น slot ละ BIDDING_TURN_MS — VU ที่ n ส่งเฉพาะ slot ที่ (n-1) mod VUS
      // เช่น VUS=100, turn=200ms → VU1 ส่งที่ slot 0, VU2 ที่ slot 1, … VU100 ที่ slot 99 แล้ววนใหม่
      // ผลคือ offer ออกไปทีละคนตามลำดับ ไม่แย่งกัน (cycle = VUS × turnMs)
      const totalVuSlots = Math.max(1, VUS);
      const vuSlotIndex = Math.max(0, (__VU - 1) % totalVuSlots);
      let lastTurnSlot = -1;
      // โดน reject (expected error) แล้วข้ามเทิร์นถัดไป 1 รอบ — ลด retry ซ้ำจากสถานะที่ยังไม่ฟื้น
      let skipNextTurn = false;
      function isMyTurnSlot() {
        const slotIdx = Math.floor(Date.now() / BIDDING_TURN_MS);
        if (slotIdx === lastTurnSlot) return false; // ส่งไปแล้วในเทิร์นนี้
        if (slotIdx % totalVuSlots !== vuSlotIndex) return false; // ไม่ใช่เทิร์นของ VU นี้
        lastTurnSlot = slotIdx;
        return true;
      }
      if (ACK_ENABLED && BIDDING_ENABLED) {
        socket.setInterval(function () {
          if (!holding || !biddingActive || failed) return;
          if (BIDDING_ORDER === 'sequence') {
            if (!isMyTurnSlot()) return;
            if (skipNextTurn) {
              // consume เทิร์นนี้เป็นการข้าม — เว้น 1 cycle ให้สถานะ auction นิ่งก่อนยิงใหม่
              skipNextTurn = false;
              logInfo(ACTION_NAMES.ackPhase, `buyer=${buyer.username} skip 1 turn (backoff หลังโดน reject)`);
              return;
            }
          } else if (Date.now() < ackReadyAt) {
            return;
          }
          trySendAck();
        }, ACK_TICK_MS);
      }

      function startAckLoop() {
        ackReadyAt = Date.now() + biddingStaggerMs;
        logInfo(
          ACTION_NAMES.ackLoopStart,
          `buyer=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${BIDDING_EVENT} action=${BIDDING_ACTION} bidderNumber=${bidderNumber} attempt=${attempt} order=${BIDDING_ORDER}${BIDDING_ORDER === 'sequence' ? ` turnMs=${BIDDING_TURN_MS} vuSlot=${vuSlotIndex + 1}/${totalVuSlots}` : ` staggerMs=${biddingStaggerMs}`} timeoutMs=${ACK_TIMEOUT_MS} retryMs=${ACK_RETRY_MS} cooldownMs=${ACK_COOLDOWN_MS} biddingDelayMs=${BIDDING_DELAY_MS} gapMs=${biddingGapMs()} biddingDurationMs=${biddingDurationMs}`
        );
        if (BIDDING_ORDER === 'parallel' && biddingStaggerMs <= 0) trySendAck();
      }

      // โหมดไล่ลำดับ (ACK=false): VU ที่ n ส่งเฉพาะ slot ของตัวเอง — VU1→VU2→…→VUS แล้ววน
      function startTurnBiddingLoop() {
        logInfo(
          ACTION_NAMES.biddingLoopStart,
          `buyer=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${BIDDING_EVENT} bidderNumber=${bidderNumber} attempt=${attempt} order=sequence turnMs=${BIDDING_TURN_MS} vuSlot=${vuSlotIndex + 1}/${totalVuSlots} biddingDurationMs=${biddingDurationMs}`
        );
        socket.setInterval(function () {
          if (failed || !holding || !biddingActive) return;
          if (!isMyTurnSlot()) return;
          ackState.sentAt = Date.now();
          ackState.timedOut = false;
          sendBiddingOffer(socket, buyer, bidderNumber, 'turn');
        }, ACK_TICK_MS);
      }

      function startAlignedBiddingLoop() {
        const gapMs = biddingGapMs();
        const alignMs = msUntilNextAlignedTick(gapMs);
        logInfo(
          ACTION_NAMES.biddingLoopStart,
          `buyer=${buyer.username} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} event=${BIDDING_EVENT} bidderNumber=${bidderNumber} attempt=${attempt} intervalMs=${BIDDING_INTERVAL_MS} biddingDelayMs=${BIDDING_DELAY_MS} gapMs=${gapMs} alignMs=${alignMs} biddingDurationMs=${biddingDurationMs}`
        );
        function tick() {
          if (failed || !holding || !biddingActive) return;
          ackState.sentAt = Date.now();
          ackState.timedOut = false;
          sendBiddingOffer(socket, buyer, bidderNumber, 'interval');
          socket.setTimeout(tick, gapMs);
        }
        schedule(tick, alignMs);
      }

      function handleAckMessage(msg) {
        const type = msg && msg.type ? msg.type : '';
        const payload = msg && msg.payload ? msg.payload : {};
        const code = msgCode(msg);

        if (type === 'bidInfo') {
          ackState.lastBidBidderNumber = String(payload.bidderNumber || '');
          ackState.lastAuctionStatus = String(payload.auctionStatus || '');
          return;
        }

        const isNotif = type === 'notification';
        const isBroadcast = type === 'broadcastBuyer' || type === 'broadcastSeller';
        if (!isNotif && !isBroadcast) return;

        const settleOwnAck = function () {
          const ackRt = settleAckResponse();
          ackState.pending = false;
          ackState.ackGen += 1;
          ackState.lastBidBidderNumber = String(payload.bidderNumber || bidderNumber || '');
          ackState.retryAt = Date.now() + biddingGapMs();
          if (ackRt.wasLate) {
            // ACK มาหลัง client timeout ไปแล้ว — นับ late แยกออกจาก ok เพื่อไม่ให้ตีความว่า server ตอบทันเวลา
            ackLateCounter.add(1, { phase: 'bidding' });
          } else {
            ackOkCounter.add(1, { phase: 'bidding', code: code }); // แยกตาม code เช่น ws_ack_ok{code=WS40005}
          }
          logInfo(
            ACTION_NAMES.ackOk,
            `buyer=${buyer.username} code=${code} waitMs=${ackRt.waitedMs}${ackRt.wasLate ? ' late=true (ACK มาหลัง client timeout)' : ''} phase=${ackState.phase}`
          );
        };
        if (code === 'WS40005' || (code === 'WS40001' && isOwnBidder(payload, bidderNumber))) {
          settleOwnAck();
          return;
        }
        if (code === 'WS20001' && isOwnBidder(payload, bidderNumber)) {
          settleOwnAck();
          return;
        }

        if (!ackState.pending && !isAckExpectedError(code)) return;

        if (code === 'E5002') {
          const ackRt = settleAckResponse();
          ackState.pending = false;
          ackState.ackGen += 1;
          ackState.retryAt = Date.now() + ACK_RETRY_MS;
          skipNextTurn = true; // backoff: ข้ามเทิร์นถัดไป 1 รอบ — server ยังไม่รับ bid รออีก cycle
          ackRetryCounter.add(1, { phase: 'bidding', code: 'E5002' }); // ws_ack_retry{code=E5002}
          logInfo(ACTION_NAMES.ackRetry, `buyer=${buyer.username} code=E5002 waitMs=${ackRt.waitedMs} retryInMs=${ACK_RETRY_MS} skipNextTurn=true phase=${ackState.phase}`);
          return;
        }

        if (code === 'E5013') {
          const ackRt = settleAckResponse();
          ackState.pending = false;
          ackState.ackGen += 1;
          ackState.retryAt = Date.now() + ACK_RETRY_MS;
          skipNextTurn = true; // backoff: ข้ามเทิร์นถัดไป 1 รอบ
          ackRetryCounter.add(1, { phase: 'bidding', code: 'E5013' }); // ws_ack_retry{code=E5013}
          logInfo(ACTION_NAMES.ackRetry, `buyer=${buyer.username} code=E5013 waitMs=${ackRt.waitedMs} retryInMs=${ACK_RETRY_MS} skipNextTurn=true phase=${ackState.phase}`);
          return;
        }

        if (code === 'WS20003') {
          const ackRt = settleAckResponse();
          ackState.pending = false;
          ackState.ackGen += 1;
          ackState.lastBidBidderNumber = String(bidderNumber || payload.bidderNumber || '');
          ackState.retryAt = Date.now() + biddingGapMs();
          ackRetryCounter.add(1, { phase: 'bidding', code: 'WS20003' }); // self-bid — ราคาปัจจุบันเป็นของตัวเอง
          logInfo(ACTION_NAMES.ackSelf, `buyer=${buyer.username} code=WS20003 waitMs=${ackRt.waitedMs} cooldownMs=${biddingGapMs()}`);
          return;
        }

        if (isAckExpectedError(code)) {
          const ackRt = settleAckResponse();
          ackState.pending = false;
          ackState.ackGen += 1;
          ackState.retryAt = Date.now() + ACK_RETRY_MS;
          skipNextTurn = true; // backoff: ข้ามเทิร์นถัดไป 1 รอบ
          ackRetryCounter.add(1, { phase: 'bidding', code: code }); // แยกตาม code เช่น ws_ack_retry{code=WS20005}
          logInfo(ACTION_NAMES.ackRetry, `buyer=${buyer.username} code=${code} waitMs=${ackRt.waitedMs} retryInMs=${ACK_RETRY_MS} skipNextTurn=true phase=${ackState.phase}`);
          return;
        }

        // Error ชนิดอื่นระหว่างรอ ACK — นับเป็น ack fail เพื่อให้ dashboard เห็น
        if (ackState.pending && isJoinError(msg)) {
          settleAckResponse();
          ackState.pending = false;
          ackState.ackGen += 1;
          ackFailCounter.add(1, { phase: 'bidding' });
          ackState.retryAt = Date.now() + ACK_RETRY_MS;
          logError(ACTION_NAMES.ackFail, `buyer=${buyer.username} code=${code || '-'} detail=${describeWsNotification(msg)}`);
        }
      }

      socket.on('open', function () {
        logInfo(ACTION_NAMES.wsOpen, `buyer=${buyer.username} status=connected attempt=${attempt} phase=prerequisite`);

        sendWsMessage(socket, buyer, 'visitLot', {
          lots: [LOT_ID],
          payload: {
            lots: [LOT_ID],
            isControl: false,
            entryKey: session.entryKey,
          },
          logAction: ACTION_NAMES.visitLotSend,
        });
        visitLotSent = true;
        visitOk.add(1, { phase: 'prerequisite' });
        check(null, { 'ws visitLot sent': () => true }, { phase: 'prerequisite' });

        sendWsMessage(socket, buyer, 'connected', {
          lots: [LOT_ID],
          fields: {
            isControl: false,
            entryKey: session.entryKey,
            bidderNumber: bidderNumber,
          },
          logAction: ACTION_NAMES.connectedSend,
        });
        connectedSent = true;

        socket.setTimeout(function () {
          if (failed || connectedDone) return;
          connectedDone = true;
          holding = true;
          reachedHolding = true;
          connectedOk.add(1, { phase: 'prerequisite' });
          check(null, { 'ws rejoin settled': () => true }, { phase: 'prerequisite' });
          logInfo(
            ACTION_NAMES.wsHoldStart,
            `buyer=${buyer.username} lotId=${LOT_ID} biddingDurationMs=${biddingDurationMs} postBidHoldMs=${postBidHoldMs} attempt=${attempt} ack=${ACK_ENABLED} — [Phase 1 Prerequisite PASS]`
          );

          // -------------------------------------------------------------
          // Phase 2: Bidding / Offer (Test Window) — ต้องครบเวลาเต็มก่อน leaveLot
          // -------------------------------------------------------------
          if (BIDDING_ENABLED) {
            biddingActive = true;
            if (ACK_ENABLED) {
              startAckLoop();
            } else if (BIDDING_ORDER === 'sequence') {
              startTurnBiddingLoop();
            } else {
              startAlignedBiddingLoop();
            }
          } else {
            logInfo(ACTION_NAMES.biddingSkipped, `buyer=${buyer.username} reason=BIDDING=false`);
          }

          // Rule: DISCONNECTED cleanup ต้องรอให้ bidding ครบเวลาเต็มก่อนเสมอ — ไม่ตัด activeDuration
          const activeDuration = DISCONNECTED_ENABLED
            ? biddingDurationMs
            : Math.min(biddingDurationMs, Math.max(1000, holdMs - postBidHoldMs));
          socket.setTimeout(function () {
            if (failed) return;
            biddingActive = false; // STOP sending offers — bidding window จบแล้วเท่านั้น
            logInfo(
              ACTION_NAMES.biddingLoopEnd,
              DISCONNECTED_ENABLED
                ? `buyer=${buyer.username} [Phase 2 Bidding Complete] duration=${activeDuration}ms (full window) → drain ACK แล้วเข้า Phase 4 Disconnect (หลังทุก VU ครบ bidding)`
                : `buyer=${buyer.username} [Phase 2 Bidding Complete] duration=${activeDuration}ms → entering Phase 3 Postrequisite (drain ACK + post-bid hold ${postBidHoldMs}ms)`
            );

            // Phase 3: Postrequisite drain (สั้น ๆ) ก่อน disconnect / post-bid hold
            const drainStartTime = Date.now();
            const maxDrainMs = DISCONNECTED_ENABLED
              ? Math.min(ACK_TIMEOUT_MS, Math.max(500, ACK_RETRY_MS))
              : Math.min(ACK_TIMEOUT_MS, Math.max(1000, postBidHoldMs));

            function finishPostrequisite() {
              const drained = !ackState.pending;
              wsPendingAckDrainedCounter.add(drained ? 1 : 0, { phase: 'postrequisite' });
              check(null, { 'ws pending ack drained': () => drained }, { phase: 'postrequisite' });

              const elapsedDrain = Date.now() - drainStartTime;

              // DISCONNECTED: ปิด WS หลัง drain — leaveLot/disconnect ทำใน group 4 (sleep ตามจำนวน VU)
              if (DISCONNECTED_ENABLED) {
                holdTimerFired = true;
                holding = false;
                logInfo(
                  ACTION_NAMES.wsHoldEnd,
                  `buyer=${buyer.username} lotId=${LOT_ID} bidding+drain done → close WS (group 4 leaveLot/disconnect)`
                );
                socket.close();
                return;
              }

              const remainingHoldMs = Math.max(0, postBidHoldMs - elapsedDrain);

              socket.setTimeout(function () {
                if (failed) return;
                holdTimerFired = true;
                holding = false;
                wsClosedNormallyCounter.add(1, { phase: 'postrequisite' });
                check(null, { 'ws closed normally': () => true }, { phase: 'postrequisite' });
                logInfo(
                  ACTION_NAMES.wsHoldEnd,
                  `buyer=${buyer.username} lotId=${LOT_ID} post-bid hold ended (${postBidHoldMs}ms) → closing WS normally`
                );
                socket.close();
              }, remainingHoldMs);
            }

            function pollDrain() {
              if (!ackState.pending || (Date.now() - drainStartTime >= maxDrainMs)) {
                finishPostrequisite();
              } else {
                socket.setTimeout(pollDrain, 100);
              }
            }

            pollDrain();
          }, activeDuration);
        }, JOIN_SETTLE_MS);
      });

      socket.on('message', function (raw) {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch (_) {
          logInfo(ACTION_NAMES.wsMessageRaw, `buyer=${buyer.username} unparsed=${String(raw).slice(0, 200)}`);
          return;
        }

        const currentPhase = holding ? (biddingActive ? 'bidding' : 'postrequisite') : 'prerequisite';

        if (msg && msg.type === 'ping') {
          const pingTs = nowIso();
          logInfo(ACTION_NAMES.wsPingRecv, `buyer=${buyer.username} ts=${pingTs} phase=${currentPhase} ${summarizeWsMessage(msg)}`);
          pingReceived.add(1, { phase: currentPhase });

          const pongMsg = buildWsMessage('pong');
          const pongTs = nowIso();
          logInfo(ACTION_NAMES.wsPongSend, `buyer=${buyer.username} ts=${pongTs} phase=${currentPhase} ${summarizeWsMessage(pongMsg)}`);
          socket.send(JSON.stringify(pongMsg));
          pongSent.add(1, { phase: currentPhase });
          return;
        }

        if (ACK_ENABLED && holding && BIDDING_ENABLED) {
          handleAckMessage(msg);
        }

        if (LOG_WS_MSG) {
          const code = msg.payload && msg.payload.code ? msg.payload.code : '';
          logInfo(
            ACTION_NAMES.wsMessage,
            `buyer=${buyer.username} type=${msg.type || '-'} code=${code || '-'} holding=${holding} phase=${currentPhase} body=${JSON.stringify(msg).slice(0, 300)}`
          );
        }

        if (!connectedDone && (visitLotSent || connectedSent) && isJoinError(msg)) {
          failed = true;
          connectedDone = true;
          connectedFail.add(1, { phase: 'prerequisite' });
          check(null, { 'ws rejoin settled': () => false }, { phase: 'prerequisite' });
          const payload = msg.payload || {};
          lastError = {
            step: 'ws_bidding',
            reason: 'join_notification_error',
            code: payload.code || '',
            level: payload.level || '',
            message: payload.message || '',
            detail: describeWsNotification(msg),
          };
          logError(
            ACTION_NAMES.wsConnectedFail,
            `buyer=${buyer.username} lotId=${LOT_ID} ${lastError.detail} msg=${raw}`
          );
          socket.close();
        } else if (holding && isJoinError(msg)) {
          const code = msgCode(msg);
          if (ACK_ENABLED && isAckExpectedError(code)) {
            return;
          }
          wsUnexpectedDisconnectCounter.add(1, { phase: 'postrequisite' });
          logError(
            ACTION_NAMES.wsHoldError,
            `buyer=${buyer.username} lotId=${LOT_ID} ${describeWsNotification(msg)} msg=${raw}`
          );
        }
      });

      socket.on('error', function (e) {
        if (holding) {
          wsUnexpectedDisconnectCounter.add(1, { phase: 'postrequisite' });
        }
        lastError = {
          step: 'ws_bidding',
          reason: 'socket_error',
          message: String(e),
        };
        logError(ACTION_NAMES.wsSocketError, `buyer=${buyer.username} error=${e}`);
      });

      socket.on('close', function () {
        logInfo(
          ACTION_NAMES.wsClose,
          `buyer=${buyer.username} holdingWas=${holding} failed=${failed} phase=${ackState.phase} attempt=${attempt} holdTimerFired=${holdTimerFired}`
        );
      });

      socket.setTimeout(function () {
        if (connectedDone || failed) return;
        failed = true;
        connectedFail.add(1, { phase: 'prerequisite' });
        check(null, { 'ws rejoin within timeout': () => false }, { phase: 'prerequisite' });
        lastError = {
          step: 'ws_bidding',
          reason: 'join_timeout',
          timeoutMs: WS_TIMEOUT_MS,
        };
        logError(
          ACTION_NAMES.wsJoinTimeout,
          `buyer=${buyer.username} lotId=${LOT_ID} timeoutMs=${WS_TIMEOUT_MS}`
        );
        socket.close();
      }, WS_TIMEOUT_MS);
    }
  );

  const elapsed = Date.now() - started;
  wsSessionDuration.add(elapsed, { phase: 'postrequisite' });
  const upgraded = res && res.status === 101;
  check(res, {
    'ws upgrade status 101': (r) => r && r.status === 101,
  }, { phase: 'prerequisite' });
  logInfo(
    upgraded ? 'ws.session.done' : 'ws.session.fail',
    `buyer=${buyer.username} httpStatus=${res && res.status} durationMs=${elapsed} wsHoldMs=${holdMs} attempt=${attempt} reachedHolding=${reachedHolding} holdTimerFired=${holdTimerFired}`
  );

  function withFlags(result) {
    result.reachedHolding = reachedHolding;
    result.holdTimerFired = holdTimerFired;
    result.attempt = attempt;
    result.durationMs = elapsed;
    return result;
  }

  if (!upgraded) {
    return withFlags({
      ok: false,
      step: 'ws_upgrade_failed',
      error: {
        step: 'ws_bidding',
        reason: 'ws_upgrade_failed',
        httpStatus: res && res.status,
      },
    });
  }
  if (holdTimerFired) {
    return withFlags({ ok: true, step: 'ws.hold.end', error: null });
  }
  if (lastError) {
    return withFlags({
      ok: false,
      step: lastError.reason || lastError.step || 'ws_bidding',
      error: lastError,
    });
  }
  if (failed) {
    return withFlags({
      ok: false,
      step: 'ws_bidding',
      error: { step: 'ws_bidding', reason: 'unknown' },
    });
  }
  return withFlags({
    ok: false,
    step: 'ws.remote_close',
    error: {
      step: 'ws_bidding',
      reason: 'ws_remote_close',
      message: 'websocket closed before WS_HOLD ended',
    },
  });
}

/**
 * Stagger VU rejoin แล้วค้างจนครบ WS_HOLD wall-clock
 * ถ้าโดน remote_close / join fail จะ reconnect (ถ้าเปิด WS_RECONNECT)
 */
function runWsHoldWithReconnect(session, bidderNumber) {
  const buyer = session.buyer;
  const holdDeadline = Date.now() + WS_HOLD_MS;
  let attempt = 0;
  let reconnectCount = 0;
  let everHolding = false;
  let lastResult = null;
  let currentSession = session;

  while (true) {
    const remainingMs = holdDeadline - Date.now();
    if (remainingMs <= 0) {
      if (lastResult && lastResult.holdTimerFired) {
        return Object.assign({}, lastResult, {
          reconnectCount: reconnectCount,
          attempts: attempt,
          reachedHolding: everHolding,
        });
      }
      if (everHolding) {
        return {
          ok: true,
          step: 'ws.hold.end',
          error: null,
          reconnectCount: reconnectCount,
          attempts: attempt,
          reachedHolding: true,
        };
      }
      return Object.assign({}, lastResult || { ok: false, step: 'ws_bidding', error: { reason: 'hold_deadline_no_session' } }, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: false,
      });
    }

    attempt += 1;
    const biddingStaggerMs = attempt === 1 ? Math.max(0, (__VU - 1) * STAGGER_MS) : 0;
    lastResult = runWsRejoinBidding(currentSession, bidderNumber, {
      holdMs: remainingMs,
      attempt: attempt,
      biddingStaggerMs: biddingStaggerMs,
    });
    if (lastResult.reachedHolding) everHolding = true;

    if (lastResult.ok) {
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: everHolding,
      });
    }

    const timeLeft = holdDeadline - Date.now();
    if (timeLeft <= 0) {
      if (everHolding) {
        return {
          ok: true,
          step: 'ws.hold.end',
          error: null,
          reconnectCount: reconnectCount,
          attempts: attempt,
          reachedHolding: true,
          lastCloseStep: lastResult.step,
        };
      }
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: false,
      });
    }

    if (!WS_RECONNECT_ENABLED) {
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: everHolding,
      });
    }

    if (WS_RECONNECT_MAX > 0 && reconnectCount >= WS_RECONNECT_MAX) {
      wsReconnectGaveUp.add(1, { phase: 'postrequisite' });
      logError(
        ACTION_NAMES.wsReconnectGaveUp,
        `buyer=${buyer.username} reconnectCount=${reconnectCount} max=${WS_RECONNECT_MAX} lastStep=${lastResult.step} remainingMs=${timeLeft}`
      );
      return Object.assign({}, lastResult, {
        reconnectCount: reconnectCount,
        attempts: attempt,
        reachedHolding: everHolding,
      });
    }

    reconnectCount += 1;
    wsReconnect.add(1, { phase: 'postrequisite' });
    logInfo(
      ACTION_NAMES.wsReconnect,
      `buyer=${buyer.username} reconnect=${reconnectCount} nextAttempt=${attempt + 1} reason=${lastResult.step} remainingMs=${timeLeft} everHolding=${everHolding}`
    );

    // token/session อาจหมดอายุหลังถูกตัด — re-login ก่อนเปิด WS ใหม่
    if (
      lastResult.step === 'ws_upgrade_failed' ||
      lastResult.step === 'socket_error' ||
      lastResult.step === 'join_timeout' ||
      lastResult.step === 'ws.remote_close'
    ) {
      const loginResult = login(buyer);
      if (loginResult.session) {
        currentSession = loginResult.session;
        logInfo(ACTION_NAMES.wsReconnectLoginOk, `buyer=${buyer.username} reconnect=${reconnectCount}`);
      } else {
        logError(
          ACTION_NAMES.wsReconnectLoginFail,
          `buyer=${buyer.username} reconnect=${reconnectCount} ${formatVuCompleteError(loginResult.error || {})}`
        );
      }
    }

    const reconnectStaggerMs = Math.max(0, (__VU - 1) * Math.min(WS_REJOIN_STAGGER_MS, 300));
    const delayMs = Math.min(WS_RECONNECT_DELAY_MS + reconnectStaggerMs, timeLeft);
    if (delayMs > 0) {
      sleep(delayMs / 1000);
    }
  }
}

export default function (setupData) {
  const rec = newVuCompleteRecord();

  try {
    requireEnv();

    logInfo(
      ACTION_NAMES.iterationStart,
      `baseUrl=${BASE_URL} wsUrl=${WS_URL} lotId=${LOT_ID} lotLineId=${LOT_LINE_ID} auctionNo=${AUCTION_NO} buyerCount=${BUYER_USERS.length} vus=${VUS} executor=${EXECUTOR} pickMode=${USER_PICK} ack=${ACK_ENABLED} staggerMs=${STAGGER_MS} rejoinStaggerMs=${WS_REJOIN_STAGGER_MS} reconnect=${WS_RECONNECT_ENABLED} prepared=${setupData && setupData.preparedCount}`
    );

    const { buyer, idx } = pickBuyer();
    rec.username = buyer.username;
    const prepared =
      setupData && setupData.preparedByUsername ? setupData.preparedByUsername[buyer.username] : null;

    if (!prepared || !prepared.bidderNumber) {
      rec.step = 'setup_prepared';
      rec.error = `ไม่มี prepared lot-bidder/ws-join สำหรับ buyer=${buyer.username}`;
      fail(
        `ไม่มี prepared lot-bidder/ws-join สำหรับ buyer=${buyer.username} — ตรวจ setup log (failed=${setupData && setupData.failedUsernames ? setupData.failedUsernames.join(',') : '-'})`
      );
    }

    if (!prepared.joinOk) {
      rec.step = 'setup_ws_join';
      rec.error = `buyer=${buyer.username} ยังไม่ผ่าน setup WS visitLot→connected`;
      fail(`buyer=${buyer.username} ยังไม่ผ่าน setup WS visitLot→connected`);
    }

    let session;
    let loginError = null;
    const bidderNumber = prepared.bidderNumber;

    // Stagger VU start (Prerequisite phase):
    // แต่ละคนจะเว้นช่วง (+WS_REJOIN_STAGGER_MS ms) ก่อนเริ่ม Login และ Join ลาน
    // เพื่อป้องกัน Login Storm และ WS Connection Storm พร้อมกัน 100 คน
    const vuStaggerMs = Math.max(0, (__VU - 1) * WS_REJOIN_STAGGER_MS);
    if (vuStaggerMs > 0 && (__ITER === 0 || !__ITER)) {
      logInfo(
        ACTION_NAMES.wsRejoinStagger,
        `buyer=${buyer.username} vu=${__VU} waitMs=${vuStaggerMs} staggerMs=${WS_REJOIN_STAGGER_MS} (staggering prerequisite login + ws-join)`
      );
      sleep(vuStaggerMs / 1000);
    }

    group(`1. Prerequisite - Login [${FLOW_STEP_LABELS.login}] (${buyer.username} #${idx})`, () => {
      const loginResult = login(buyer);
      session = loginResult.session;
      loginError = loginResult.error;
    });
    if (!session) {
      const err = loginError || {};
      rec.step = 'login';
      rec.error = formatVuCompleteError(err) || 'login_failed';
      logError(
        ACTION_NAMES.iterationAbort,
        `step=${err.step || 'login'} reason=login_failed buyer=${buyer.username} status=${err.status || '-'} code=${err.code || '-'} message=${err.message || '-'}`
      );
      sleep(1);
      return;
    }

    group(`2. Prerequisite - Lot-Bidder + WS Join [setup prepared] (${buyer.username})`, () => {
      const preparedOk = bidderNumber !== '';
      const buyerMatch = prepared.username === buyer.username;
      const joinOk = prepared.joinOk === true;
      if (!preparedOk) {
        logError(
          ACTION_NAMES.lotBidderPreparedFail,
          `buyer=${buyer.username} reason=empty_bidder_number lotId=${LOT_ID} source=setup`
        );
      }
      if (!buyerMatch) {
        logError(
          ACTION_NAMES.lotBidderPreparedFail,
          `buyer=${buyer.username} reason=buyer_mismatch expected=${prepared.username} got=${buyer.username}`
        );
      }
      if (!joinOk) {
        logError(
          ACTION_NAMES.wsJoinPreparedFail,
          `buyer=${buyer.username} reason=join_not_prepared lotId=${LOT_ID} source=setup`
        );
      }
      check(null, {
        'lot-bidder prepared': () => preparedOk,
        'lot-bidder matches buyer': () => buyerMatch,
        'ws visitLot+connected prepared': () => joinOk,
      }, { phase: 'prerequisite' });
      if (!preparedOk || !buyerMatch || !joinOk) {
        rec.step = 'setup_prepared';
        rec.error = !preparedOk
          ? 'empty_bidder_number'
          : !buyerMatch
            ? 'buyer_mismatch'
            : 'join_not_prepared';
        logError(
          ACTION_NAMES.iterationAbort,
          `step=setup_prepared reason=${rec.error} buyer=${buyer.username} lotId=${LOT_ID}`
        );
        sleep(1);
        return;
      }
      logInfo(
        ACTION_NAMES.batchPreparedUse,
        `buyer=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber} joinOk=true joinMs=${prepared.joinDurationMs || 0} source=setup`
      );
    });
    if (!bidderNumber || prepared.username !== buyer.username || !prepared.joinOk) {
      if (rec.step === 'unknown') {
        rec.step = 'setup_prepared';
        rec.error = 'prepared_invalid';
      }
      return;
    }

    let wsResult;
    group(
      DISCONNECTED_ENABLED
        ? `3. Bidding Window (${msToDuration(BIDDING_DURATION_MS)}) (${buyer.username})`
        : `3. Bidding Window (${msToDuration(BIDDING_DURATION_MS)}) & Postrequisite (${buyer.username})`,
      () => {
        wsResult = runWsHoldWithReconnect(session, bidderNumber);
      }
    );
    if (wsResult && !wsResult.ok) {
      const err = wsResult.error || {};
      rec.step = (wsResult && wsResult.step) || err.reason || err.step || 'ws_bidding';
      const reconnectInfo =
        wsResult.reconnectCount != null ? ` reconnects=${wsResult.reconnectCount}` : '';
      rec.error = (formatVuCompleteError(err) || rec.step) + reconnectInfo;
      logError(
        ACTION_NAMES.iterationAbort,
        `step=${err.step || 'ws_bidding'} reason=${err.reason || 'unknown'} buyer=${buyer.username} lotId=${LOT_ID} code=${err.code || '-'} message=${err.message || err.detail || '-'} httpStatus=${err.httpStatus || '-'} reconnects=${wsResult.reconnectCount || 0} attempts=${wsResult.attempts || 0}`
      );
      sleep(1);
      return;
    }

    if (DISCONNECTED_ENABLED) {
      const vuIndex = typeof __VU !== 'undefined' && __VU > 0 ? __VU : 1;
      const n = Math.max(1, VUS);
      const turnMs = Math.max(DISCONNECT_GAP_MS, 50);
      const barrierAtMs =
        setupData && setupData.disconnectBarrierAtMs
          ? Number(setupData.disconnectBarrierAtMs)
          : Date.now() + disconnectBarrierOffsetMs();
      group(
        `4. Disconnect [${FLOW_STEP_LABELS.leaveLot} → ${FLOW_STEP_LABELS.disconnected}] (${buyer.username})`,
        function () {
          // Step 1: รอให้ทุกคนบิดครบ (barrier รวม) — ยังไม่ disconnect
          const waitBarrierMs = Math.max(0, barrierAtMs - Date.now());
          logInfo(
            ACTION_NAMES.leaveLotWait,
            `buyer=${buyer.username} vu=${vuIndex}/${n} step=1/2 waitAllBiddingDoneMs=${waitBarrierMs} barrierAt=${new Date(barrierAtMs).toISOString()} — wait until ALL VUs finish bidding`
          );
          if (waitBarrierMs > 0) {
            sleep(waitBarrierMs / 1000);
          }

          // Step 2: disconnect ทีละคน ตามลำดับ VU1 → VU2 → … → VUN
          const turnWaitMs = disconnectTurnWaitMs(vuIndex);
          logInfo(
            ACTION_NAMES.leaveLotWait,
            `buyer=${buyer.username} vu=${vuIndex}/${n} step=2/2 turnWaitMs=${turnWaitMs} formula=(vu-1)×${turnMs} — sequential leaveLot→disconnected`
          );
          if (turnWaitMs > 0) {
            sleep(turnWaitMs / 1000);
          }

          const disc = runDisconnectOnly(session);
          if (!disc.ok) {
            logWarn(
              ACTION_NAMES.leaveLotWait,
              `buyer=${buyer.username} vu=${vuIndex}/${n} disconnect cleanup failed error=${disc.error || '-'}`
            );
          }
        }
      );
    }

    rec.step = (wsResult && wsResult.step) || 'ws.hold.end';
    rec.outcome = 'ok';
    rec.result = 'PASS';
    rec.error =
      wsResult && wsResult.reconnectCount
        ? `reconnects=${wsResult.reconnectCount} attempts=${wsResult.attempts || 0}`
        : '';
    logInfo(
      ACTION_NAMES.iterationDone,
      `buyer=${buyer.username} lotId=${LOT_ID} bidderNumber=${bidderNumber} reconnects=${(wsResult && wsResult.reconnectCount) || 0} attempts=${(wsResult && wsResult.attempts) || 0}`
    );
    sleep(1);
  } catch (e) {
    if (!rec.error) rec.error = String(e && e.message ? e.message : e);
    if (!rec.step || rec.step === 'unknown') rec.step = 'exception';
    throw e;
  } finally {
    rec.at = nowIso();
    recordVuComplete(rec);
  }
}

export const handleSummary = createHandleSummary(function (data) {
  const vuCompletions = extractVuCompletions(data);
  const vuCompletePassCount = vuCompletions.filter(function (item) {
    return item.outcome === 'ok';
  }).length;
  const vuCompleteFailCount = vuCompletions.length - vuCompletePassCount;
  const vuCompletePath = vuCompleteJsonPath();
  const extraFiles = {};
  extraFiles[vuCompletePath] = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      count: vuCompletions.length,
      passCount: vuCompletePassCount,
      failCount: vuCompleteFailCount,
      items: vuCompletions,
    },
    null,
    2
  );

  return {
    titleBase: __ENV.REPORT_TITLE || 'k6 bidding load test (3-phase)',
    reportDir: __ENV.REPORT_DIR || 'k6-reports',
    reportBasename: __ENV.REPORT_BASENAME || 'buyer-send-bidding-buffer-2',
    extraStdout: formatVuCompleteStdout(vuCompletions),
    extraFiles: extraFiles,
    // JSON: เฉพาะ bidding metrics; HTML ใช้ source data เต็มเพื่อคำนวณ denominator/count
    metricNames: BIDDING_REPORT_METRICS,
    checkNameRe: /login|lot-?bidder|visitlot|connected|rejoin|bidding|ack|upgrade|drained|closed/i,
    dropVuComplete: true,
    keepContextMetrics: true,
    meta: {
      reportScope: 'bidding',
      reportMetrics: BIDDING_REPORT_METRICS,
      dashboardVersion: 'v3-phases',
      flowSteps: FLOW_STEP_LABELS,
      baseUrl: BASE_URL,
      wsUrl: WS_URL,
      lotId: LOT_ID,
      vus: VUS,
      executor: EXECUTOR,
      pickMode: USER_PICK,
      startLoopIndex: START_LOOP_INDEX,
      endLoopIndex: END_LOOP_INDEX,
      usernamePrefix: USERNAME_PREFIX,
      buyerCount: BUYER_USERS.length,
      buyers: BUYER_USERS.map(function (u) {
        return u.username;
      }),
      biddingDurationMs: BIDDING_DURATION_MS,
      postBidHoldMs: POST_BID_HOLD_MS,
      wsHoldMs: WS_HOLD_MS,
      wsJoinSettleMs: JOIN_SETTLE_MS,
      biddingEnabled: BIDDING_ENABLED,
      ackEnabled: ACK_ENABLED,
      biddingStaggerMs: STAGGER_MS,
      wsRejoinStaggerMs: WS_REJOIN_STAGGER_MS,
      wsReconnect: WS_RECONNECT_ENABLED,
      wsReconnectDelayMs: WS_RECONNECT_DELAY_MS,
      wsReconnectMax: WS_RECONNECT_MAX,
      ackTimeoutMs: ACK_TIMEOUT_MS,
      ackRetryMs: ACK_RETRY_MS,
      ackCooldownMs: ACK_COOLDOWN_MS,
      biddingIntervalMs: BIDDING_INTERVAL_MS,
      biddingDelayMs: BIDDING_DELAY_MS,
      biddingOrder: BIDDING_ORDER,
      biddingTurnMs: BIDDING_TURN_MS,
      disconnected: DISCONNECTED_ENABLED,
      disconnectGapMs: DISCONNECT_GAP_MS,
      lotBidderGapMs: LOT_BIDDER_GAP_MS,
      wsJoinGapMs: WS_JOIN_GAP_MS,
      lotBidderRetries: LOT_BIDDER_RETRIES,
      lotBidderRetryMs: LOT_BIDDER_RETRY_MS,
      httpTimeoutMs: HTTP_TIMEOUT_MS,
      setupTimeout: SETUP_TIMEOUT,
      lotBidderPrepareMode: 'setup-sequential-lot-bidder-and-ws-join',
      // โซน report: performance เริ่มนับที่ bid offer — prerequisite (login/lot-bidder/WS join) นับสถานะเท่านั้น
      perfZoneStartsAt: 'bid_offer',
      perfStartsAt: 'bid_offer',
      perfStageLabel: 'Bidding Send → Bidding ACK',
      prereqStages: ['login', 'lot_bidder_number', 'ws_visitlot', 'ws_connected', 'ws_join_prepare'],
      biddingStages: ['bidding_send', 'bidding_ack'],
      postreqStages: DISCONNECTED_ENABLED
        ? ['pending_ack_drain', 'leave_lot', 'disconnected', 'ws_close']
        : ['pending_ack_drain', 'post_bid_hold', 'ws_close', 'ws_reconnect'],
      lotLineId: LOT_LINE_ID,
      auctionNo: AUCTION_NO,
      biddingEvent: BIDDING_EVENT,
      biddingAction: BIDDING_ACTION,
      vuResultCount: vuCompletions.length,
      vuResultPassCount: vuCompletePassCount,
      vuResultFailCount: vuCompleteFailCount,
      vuCompleteJson: vuCompletePath,
    },
  };
});
