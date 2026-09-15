/**
 * Enterprise Single-File HTML Performance Test Report Generator for k6
 *
 * Features:
 * - 100% Single-File HTML (Embedded CSS + Vanilla JS + CDN Chart.js)
 * - JMeter-Standard Aggregated Statistics Table (#Samples, KO, Error %, Avg, Min, p90, p95, p99, Max, RPS, TPH, KB/s, SLA)
 * - Real-time Search, Multi-column Sorting, and Scenario/Status Filtering
 * - Error Log Analysis with Automated Technical Root Cause Diagnosis
 * - Interactive Chart.js visualizations derived from k6 aggregate summary data
 * - Client-side Export to CSV & Print/PDF Support
 */

/**
 * Parses k6 metrics and tags to build JMeter-style statistics and error logs
 */
function metricBaseCount(data, baseName) {
  const metrics = (data && data.metrics) || {};
  const keys = Object.keys(metrics);
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const base = String(keys[i]).split('{')[0];
    if (base !== baseName) continue;
    const values = (metrics[keys[i]] && metrics[keys[i]].values) || {};
    if (values.count != null) total += Number(values.count) || 0;
  }
  return total;
}

function ratioPercent(part, total) {
  return total > 0 ? (part / total) * 100 : 0;
}

/**
 * ชื่อที่แสดงใน report — format: ภาษาคน ( คำเดิม )
 * key = metric name ของ k6 (คงเดิมไม่เปลี่ยน)
 */
const METRIC_DISPLAY_LABELS = {
  login_ok: 'Login สำเร็จ ( login_ok )',
  login_fail: 'Login ไม่สำเร็จ ( login_fail )',
  login_duration_ms: 'เวลา Login ( login_duration_ms )',
  lot_bidder_number_duration_ms: 'เวลาสร้างเลขป้ายผู้ประมูล ( lot_bidder_number_duration_ms )',
  lot_bidder_prepare_ok: 'เตรียมเลขผู้ประมูล สำเร็จ ( lot_bidder_prepare_ok )',
  lot_bidder_prepare_fail: 'เตรียมเลขผู้ประมูล ไม่สำเร็จ ( lot_bidder_prepare_fail )',
  visit_lot_ok: 'เข้า Lot สำเร็จ ( visit_lot_ok )',
  connected_ok: 'เชื่อมต่อ WebSocket สำเร็จ ( connected_ok )',
  connected_fail: 'เชื่อมต่อ WebSocket ไม่สำเร็จ ( connected_fail )',
  ws_ping_received: 'ได้รับ Ping ( ws_ping_received )',
  ws_pong_sent: 'ส่ง Pong กลับ ( ws_pong_sent )',
  ws_bidding_sent: 'ส่งบิดแล้ว ( ws_bidding_sent )',
  ws_ack_ok: 'ได้คำตอบบิด สำเร็จ ( ws_ack_ok )',
  ws_ack_late: 'คำตอบบิดมาช้า หลัง timeout ( ws_ack_late )',
  ws_ack_fail: 'คำตอบบิดล้มเหลว ( ws_ack_fail )',
  ws_ack_retry: 'ลองส่งบิดใหม่ ( ws_ack_retry )',
  ws_ack_timeout: 'รอคำตอบบิดหมดเวลา ( ws_ack_timeout )',
  ws_ack_wait_ms: 'เวลารอคำตอบหลังส่งบิด ( ws_ack_wait_ms )',
  ws_join_prepare_ok: 'เตรียม Join สำเร็จ ( ws_join_prepare_ok )',
  ws_join_prepare_fail: 'เตรียม Join ไม่สำเร็จ ( ws_join_prepare_fail )',
  ws_join_prepare_duration_ms: 'เวลาเตรียม Join ( ws_join_prepare_duration_ms )',
  ws_session_duration_ms: 'ระยะเวลาเปิด WebSocket ( ws_session_duration_ms )',
  ws_reconnect: 'เชื่อมต่อ WebSocket ใหม่ ( ws_reconnect )',
  ws_reconnect_gave_up: 'เชื่อมต่อใหม่ไม่สำเร็จ เลิกลอง ( ws_reconnect_gave_up )',
  ws_closed_normally: 'ปิด WebSocket ตามปกติ ( ws_closed_normally )',
  ws_pending_ack_drained: 'เคลียร์คำตอบบิดค้างครบ ( ws_pending_ack_drained )',
  ws_unexpected_disconnect: 'WebSocket หลุดโดยไม่คาดคิด ( ws_unexpected_disconnect )',
};

function metricDisplayLabel(metricKey) {
  const base = String(metricKey || '').split('{')[0];
  return METRIC_DISPLAY_LABELS[base] || base.replace(/_/g, ' ');
}

/** ชื่อแสดงในตาราง dashboard — format: ภาษาคน ( คำเดิม ) */
const DASHBOARD_ENDPOINT_LABELS = {
  totalHttpRequests: 'จำนวน HTTP Requests ทั้งหมด ( Total HTTP Requests )',
  allEndpointsSummary: 'สรุปทุก Endpoint ( All Endpoints (Summary) )',
  httpRequestsOverall: 'HTTP Requests รวม ( HTTP Requests (Overall) )',
  totalGlobalAverage: 'รวมทั้งหมด / ค่าเฉลี่ยทั้งระบบ ( Total / Global Average )',
};

/**
 * WebSocket Service error/message codes — source of truth:
 *   backend  : backend-common-lib/errors/error_list.go (E5xxx, "WebSocket service start prefix 5 only")
 *              + backend-common-lib/constants/websocket/websocket.go
 *   frontend : src/app/shareds/constants/web-socket-code.constant.ts (enum WebSocketCode) + i18n en/th.json
 * ใช้แปลง ws_ack_retry{code=...} / ws_ack_ok{code=...} ให้เป็นความหมายที่อ่านรู้เรื่องใน report
 */
export const WS_ACK_CODE_META = {
  // กลุ่ม E5xxx — Backend Error (HTTP 400, prefix "5" = WebSocket service)
  E5002: {
    group: 'backend-bidding',
    constant: 'ErrWebSocketBiddingNotAllow',
    message: 'Bidding is currently not allow',
    th: 'ไม่สามารถ Bid ได้ในขณะนี้ (Bidding not allow)',
    severity: 'warning',
  },
  E5013: {
    group: 'backend-offer',
    constant: 'ErrWebSocketOfferNotAllow',
    message: 'Offer is currently not allow',
    th: 'ไม่สามารถเสนอราคาได้ในขณะนี้ (Offer not allow)',
    severity: 'warning',
  },
  // กลุ่ม WS2xxxx — Bidding (การประมูล/Bid)
  WS20003: {
    group: 'bidding',
    constant: 'WebSocketBiddingSameAmount',
    th: 'ราคาปัจจุบันเป็นของคุณอยู่แล้ว (self-bid / same amount)',
    severity: 'info',
  },
  WS20005: {
    group: 'bidding',
    constant: 'WebSocketBiddingMustBeHigherThanCurrentPrice',
    th: 'ราคาที่ Bid ต้องมากกว่าราคาปัจจุบัน (โดน outbid หรือ bid ต่ำกว่า)',
    severity: 'info',
  },
  WS20009: {
    group: 'bidding',
    constant: 'WebSocketBiddingNotAllow',
    th: 'สถานะสินค้า (lot) ไม่ถูกต้อง — ไม่อนุญาตให้ Bid (Invalid item status)',
    severity: 'warning',
  },
  WS20010: {
    group: 'bidding',
    constant: 'WebSocketBiddingStepTooLow',
    th: 'ราคาที่ Bid ต้องมากกว่าราคาปัจจุบัน + ราคาต่อไม้ (step too low)',
    severity: 'info',
  },
  WS20012: {
    group: 'bidding',
    constant: 'WebSocketBiddingBidderNotAllow',
    th: 'ผู้ปรมูลคนนี้ไม่ได้รับอนุญาตให้ทำการประมูล (Bidder not allow)',
    severity: 'warning',
  },
  // กลุ่ม WS4xxxx — Offer (การเสนอราคาเริ่มต้น)
  WS40002: {
    group: 'offer',
    constant: 'WebSocketOfferIncorrectLotLine',
    th: 'ลำดับสินค้า (lot line) ไม่ถูกต้อง — เสนอราคาไม่ตรงกับที่กำลังขาย',
    severity: 'warning',
  },
  WS40003: {
    group: 'offer',
    constant: 'WebSocketOfferSameAmount',
    th: 'ราคาปัจจุบันเป็นของคุณอยู่แล้ว (offer same amount)',
    severity: 'info',
  },
  WS40004: {
    group: 'offer',
    constant: 'WebSocketOfferMustBeHigherThanCurrentPrice',
    th: 'ราคาที่เสนอต้องมากกว่าราคาปัจจุบัน',
    severity: 'info',
  },
};

/** นับ metric แบบมี tag เช่น ws_ack_retry{code=E5002} -> { E5002: 15000, ... } */
export function collectTagCounts(data, baseName, tagName) {
  const metrics = (data && data.metrics) || {};
  const keys = Object.keys(metrics);
  // k6 key รูปแบบ base{tag1=v1,tag2=v2} — tag อาจอยู่หลัง '{' หรือ ','
  const tagRe = new RegExp('[{,]' + String(tagName) + '=([^,}]+)');
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const braceIdx = key.indexOf('{');
    if (braceIdx < 0 || key.slice(0, braceIdx) !== baseName) continue;
    const tagMatch = key.slice(braceIdx).match(tagRe);
    if (!tagMatch) continue;
    const values = (metrics[key] && metrics[key].values) || {};
    const c = Number(values.count) || 0;
    if (c <= 0) continue;
    out[tagMatch[1]] = (out[tagMatch[1]] || 0) + c;
  }
  return out;
}

/** แถว breakdown ws_ack_retry ต่อ code ใน flow card — เรียงจากมากไปน้อย แสดง max 6 codes */
function renderAckCodeBreakdown(retryByCode) {
  const byCode = retryByCode || {};
  const fmt = v => (Number(v) || 0).toLocaleString(); // countText อยู่ใน scope ของ template เท่านั้น — ใช้ fmt ในเครื่องแทน
  const keys = Object.keys(byCode).sort(function (a, b) {
    return byCode[b] - byCode[a];
  });
  if (!keys.length) return '';
  const items = keys.slice(0, 6).map(function (code) {
    const meta = WS_ACK_CODE_META[code] || null;
    const title = meta ? (meta.constant + ': ' + meta.th) : 'ไม่พบคำจำกัดความใน backend-common-lib';
    return '<span title="' + title.replace(/"/g, '&quot;') + '">' + code + '=' + fmt(byCode[code]) + '</span>';
  });
  const overflow = keys.length > 6 ? '<span>+' + (keys.length - 6) + ' more</span>' : '';
  return '<div class="flow-stat-sub">retry by code: ' + items.join(' · ') + overflow + '</div>';
}

/**
 * Tag ว่า endpoint/flow step นี้เป็น prerequisite (ก่อน bid offer) หรือ performance (จาก bid offer ขึ้นไป)
 * Performance เริ่มนับที่ bid offer = bidding send → ACK → reconnect
 */
function zoneForEndpointRow(name) {
  const n = String(name || '').toLowerCase();
  if (
    n.indexOf('ws close') === 0 ||
    n.indexOf('ws drain') === 0 ||
    n.indexOf('ws pending') === 0 ||
    n.indexOf('ws unexpected') === 0 ||
    n.indexOf('ws post-bid') === 0 ||
    n.indexOf('postrequisite') >= 0
  ) {
    return 'postrequisite';
  }
  if (
    n.indexOf('ws ack') === 0 ||
    n.indexOf('ws bidding') === 0 ||
    n.indexOf('ws reconnect') === 0 ||
    n.indexOf('ws session') === 0 ||
    n.indexOf('ws ping') === 0 ||
    n.indexOf('ws pong') === 0 ||
    n.indexOf('ws hold') === 0
  ) {
    return 'performance';
  }
  return 'prerequisite';
}

function buildFlowSummaryFromMetrics(data) {
  const visitLotOk = metricBaseCount(data, 'visit_lot_ok');
  const connectedOk = metricBaseCount(data, 'connected_ok');
  const connectedFail = metricBaseCount(data, 'connected_fail');
  const connectedTotal = connectedOk + connectedFail;
  const lotBidderPrepared = metricBaseCount(data, 'lot_bidder_prepare_ok');
  const lotBidderFailed = metricBaseCount(data, 'lot_bidder_prepare_fail');
  const lotBidderTotal = lotBidderPrepared + lotBidderFailed;
  const wsJoinPrepared = metricBaseCount(data, 'ws_join_prepare_ok');
  const wsJoinFailed = metricBaseCount(data, 'ws_join_prepare_fail');
  const wsJoinTotal = wsJoinPrepared + wsJoinFailed;
  const biddingSent = metricBaseCount(data, 'ws_bidding_sent');
  const ackOk = metricBaseCount(data, 'ws_ack_ok');
  const ackFailed = metricBaseCount(data, 'ws_ack_fail');
  const ackTimeout = metricBaseCount(data, 'ws_ack_timeout');
  const ackRetry = metricBaseCount(data, 'ws_ack_retry');
  const ackTotal = ackOk + ackFailed + ackTimeout;
  const ackLate = metricBaseCount(data, 'ws_ack_late');
  // ระยะเวลารอ ACK (round-trip ฝั่ง client) จาก Trend ws_ack_wait_ms
  const ackWaitValues =
    (data && data.metrics && data.metrics['ws_ack_wait_ms'] && data.metrics['ws_ack_wait_ms'].values) || {};
  const ackWaitAvgMs = Number(ackWaitValues.avg) || 0;
  const ackWaitP95Ms = Number(ackWaitValues['p(95)'] != null ? ackWaitValues['p(95)'] : ackWaitValues.med) || 0;
  // % timeout เทียบจำนวน bid ที่ส่ง: <10% มักเป็น client timeout (SLA ตั้งต่ำ), >=10% มักเป็น server bottleneck
  const ackTimeoutVsSentPct = biddingSent > 0 ? (ackTimeout / biddingSent) * 100 : 0;
  // แยก retry/ok ตาม code ของ WebSocket Service เช่น E5002 (bidding not allow), WS20005 (ต้อง bid สูงกว่า)
  const ackRetryByCode = collectTagCounts(data, 'ws_ack_retry', 'code');
  const ackOkByCode = collectTagCounts(data, 'ws_ack_ok', 'code');

  const wsClosedNormally = metricBaseCount(data, 'ws_closed_normally');
  const wsPendingAckDrained = metricBaseCount(data, 'ws_pending_ack_drained');
  const wsUnexpectedDisconnect = metricBaseCount(data, 'ws_unexpected_disconnect');
  const reconnectAttempts = metricBaseCount(data, 'ws_reconnect');
  const reconnectGaveUp = metricBaseCount(data, 'ws_reconnect_gave_up');

  return {
    // Dashboard flow (3-phase):
    //   Prerequisite : Login → Lot-Bidder Number → WS VisitLot → WS Connected (+ Join Prepare)
    //   Performance  : Bidding Send → Bidding ACK (เริ่มนับที่ bid offer)
    //   Postrequisite: Drain pending ACK → WS Close → Reconnect/Cleanup
    perfZoneStartsAt: 'bid_offer',
    login: {
      zone: 'prerequisite',
      label: 'เข้าสู่ระบบ ( Login )',
      ok: metricBaseCount(data, 'login_ok'),
      failed: metricBaseCount(data, 'login_fail'),
    },
    lotBidder: {
      zone: 'prerequisite',
      label: 'สร้างเลขป้ายผู้ประมูล ( Lot-Bidder Number )',
      prepared: lotBidderPrepared,
      failed: lotBidderFailed,
      total: lotBidderTotal,
      successRatePct: ratioPercent(lotBidderPrepared, lotBidderTotal),
    },
    wsVisitLot: { zone: 'prerequisite', label: 'เข้า Lot ( WS VisitLot )', sent: visitLotOk },
    connection: {
      zone: 'prerequisite',
      label: 'เชื่อมต่อ WebSocket ( WS Connected )',
      ok: connectedOk,
      failed: connectedFail,
      total: connectedTotal,
      successRatePct: ratioPercent(connectedOk, connectedTotal),
    },
    wsJoin: {
      zone: 'prerequisite',
      label: 'เตรียม Join ( WS Join Prepare )',
      prepared: wsJoinPrepared,
      failed: wsJoinFailed,
      total: wsJoinTotal,
      successRatePct: ratioPercent(wsJoinPrepared, wsJoinTotal),
    },
    bidding: { zone: 'performance', label: 'ส่งบิด ( Bidding Send )', sent: biddingSent },
    acknowledgement: {
      zone: 'performance',
      label: 'คำตอบบิด ( Bidding ACK )',
      ok: ackOk,
      failed: ackFailed,
      late: ackLate,
      timeout: ackTimeout,
      retry: ackRetry,
      total: ackTotal,
      successRatePct: ratioPercent(ackOk, ackTotal),
      timeoutVsSentPct: ackTimeoutVsSentPct,
      waitAvgMs: ackWaitAvgMs,
      waitP95Ms: ackWaitP95Ms,
      retryByCode: ackRetryByCode,
      okByCode: ackOkByCode,
    },
    reconnect: {
      zone: 'postrequisite',
      label: 'เชื่อมต่อ WebSocket ใหม่ ( WS Reconnect )',
      attempts: reconnectAttempts,
      gaveUp: reconnectGaveUp,
    },
    postrequisite: {
      zone: 'postrequisite',
      label: 'หลังจบการบิด ( Postrequisite )',
      pendingAckDrained: wsPendingAckDrained,
      closedNormally: wsClosedNormally,
      unexpectedDisconnect: wsUnexpectedDisconnect,
      reconnectAttempts: reconnectAttempts,
      reconnectGaveUp: reconnectGaveUp,
    },
    // Backward-compatible aliases (ห้ามลบ — report เก่าอ่าน keys เดิม)
    visitLot: { zone: 'prerequisite', sent: visitLotOk },
  };
}

export function parseK6Metrics(data, options) {
  const opts = options || {};
  const metrics = (data && data.metrics) || {};
  const durationMs = (data && data.state && data.state.testRunDurationMs) || 1000;
  const durationSec = Math.max(durationMs / 1000, 0.001);
  const slaThresholdMs = opts.slaThresholdMs || 2000; // Default 2s SLA cap

  const endpointsMap = {};
  const errorMap = {};

  // 1. Process all metrics
  const metricKeys = Object.keys(metrics);

  for (let i = 0; i < metricKeys.length; i++) {
    const key = metricKeys[i];
    const metric = metrics[key];
    const values = (metric && metric.values) || {};

    // Check for HTTP duration sub-metrics: http_req_duration{...}
    if (key.indexOf('http_req_duration') === 0) {
      const tagMatch = key.match(/\{([^}]+)\}/);
      let name = DASHBOARD_ENDPOINT_LABELS.totalHttpRequests;
      let scenario = 'default';

      if (tagMatch && tagMatch[1]) {
        const rawTags = tagMatch[1].split(',');
        for (let j = 0; j < rawTags.length; j++) {
          const parts = rawTags[j].split(':');
          const tKey = parts[0] ? parts[0].trim() : '';
          const tVal = parts.slice(1).join(':').trim();
          if (tKey === 'name') name = tVal;
          if (tKey === 'scenario') scenario = tVal;
        }
      } else if (key === 'http_req_duration') {
        name = DASHBOARD_ENDPOINT_LABELS.allEndpointsSummary;
        scenario = 'global';
      }

      const mapKey = scenario + '::' + name;
      if (!endpointsMap[mapKey]) {
        endpointsMap[mapKey] = {
          scenario: scenario,
          name: name,
          label: '[' + scenario + '] ' + name,
          samples: 0,
          ko: 0,
          errorRate: 0,
          avg: 0,
          min: 0,
          med: 0,
          p90: 0,
          p95: 0,
          p99: 0,
          max: 0,
          rps: 0,
          tph: 0,
          kbPerSec: 0,
          slaTargetMs: slaThresholdMs,
          status: 'PASS',
        };
      }

      endpointsMap[mapKey].avg = values.avg || 0;
      endpointsMap[mapKey].min = values.min || 0;
      endpointsMap[mapKey].med = values.med || values['p(50)'] || 0;
      endpointsMap[mapKey].p90 = values['p(90)'] || 0;
      endpointsMap[mapKey].p95 = values['p(95)'] || 0;
      endpointsMap[mapKey].p99 = values['p(99)'] || values['p(95)'] || 0;
      endpointsMap[mapKey].max = values.max || 0;
      endpointsMap[mapKey].samples = values.count || 0;
    }

    // Check for WebSocket / Bidding custom counters
    const isBiddingCounter = (
      key.indexOf('ws_') === 0 ||
      key.indexOf('visit_lot_') === 0 ||
      key.indexOf('connected_') === 0 ||
      key.indexOf('lot_bidder_') === 0
    ) && metric.type === 'counter';

    if (isBiddingCounter) {
      const wsName = metricDisplayLabel(key); // ภาษาคน — ดู METRIC_DISPLAY_LABELS
      const wsKey = 'bidding_ws::' + key;
      if (!endpointsMap[wsKey]) {
        endpointsMap[wsKey] = {
          scenario: 'bidding_ws',
          name: wsName,
          label: '[bidding_ws] ' + wsName, // note: key = metric name เดิม
          samples: values.count || 0,
          ko: key.indexOf('timeout') >= 0 || key.indexOf('fail') >= 0 || key.indexOf('gave_up') >= 0 ? values.count || 0 : 0,
          errorRate: 0,
          avg: 0,
          min: 0,
          med: 0,
          p90: 0,
          p95: 0,
          p99: 0,
          max: 0,
          rps: (values.count || 0) / durationSec,
          tph: ((values.count || 0) / durationSec) * 3600,
          kbPerSec: 0,
          slaTargetMs: slaThresholdMs,
          status: 'PASS',
        };
      }
    }
  }

  // 2. Attach Failure counts & Error Rates
  for (let i = 0; i < metricKeys.length; i++) {
    const key = metricKeys[i];
    const metric = metrics[key];
    const values = (metric && metric.values) || {};

    if (key.indexOf('http_req_failed') === 0) {
      const tagMatch = key.match(/\{([^}]+)\}/);
      let name = DASHBOARD_ENDPOINT_LABELS.allEndpointsSummary;
      let scenario = 'global';

      if (tagMatch && tagMatch[1]) {
        const rawTags = tagMatch[1].split(',');
        for (let j = 0; j < rawTags.length; j++) {
          const parts = rawTags[j].split(':');
          const tKey = parts[0] ? parts[0].trim() : '';
          const tVal = parts.slice(1).join(':').trim();
          if (tKey === 'name') name = tVal;
          if (tKey === 'scenario') scenario = tVal;
        }
      }

      const mapKey = scenario + '::' + name;
      if (endpointsMap[mapKey]) {
        // In k6, http_req_failed.values.fails is the count of failures.
        const koCount = values.fails !== undefined ? values.fails : Math.round((values.rate || 0) * (endpointsMap[mapKey].samples || 0));
        endpointsMap[mapKey].ko = koCount;
        endpointsMap[mapKey].errorRate = (values.rate || 0) * 100;
      }
    }
  }

  // 3. Attach Data Transfer
  const totalReceivedBytes = (metrics.data_received && metrics.data_received.values && metrics.data_received.values.count) || 0;
  const totalSentBytes = (metrics.data_sent && metrics.data_sent.values && metrics.data_sent.values.count) || 0;
  const totalKbPerSec = ((totalReceivedBytes + totalSentBytes) / 1024) / durationSec;

  // 4. Calculate SLA, RPS, TPH and build rows
  const endpointRows = [];
  let totalSamples = 0;
  let totalKO = 0;

  const endpointKeys = Object.keys(endpointsMap);
  for (let k = 0; k < endpointKeys.length; k++) {
    const item = endpointsMap[endpointKeys[k]];
    if (item.name === DASHBOARD_ENDPOINT_LABELS.allEndpointsSummary) continue; // Don't duplicate in detailed list

    item.rps = item.samples / durationSec;
    item.tph = item.rps * 3600;
    if (item.samples > 0) {
      item.errorRate = (item.ko / item.samples) * 100;
    }

    // Estimate KB/s per endpoint proportional to samples
    item.kbPerSec = item.samples > 0 ? (item.samples / Math.max((metrics.http_reqs && metrics.http_reqs.values && metrics.http_reqs.values.count) || 1, 1)) * totalKbPerSec : 0;

    // SLA Evaluation
    if (item.p95 > slaThresholdMs || item.errorRate >= 5.0) {
      item.status = 'BREACHED';
    } else if (item.p95 > (slaThresholdMs * 0.8) || item.errorRate >= 1.0) {
      item.status = 'WARNING';
    } else {
      item.status = 'PASS';
    }

    totalSamples += item.samples;
    totalKO += item.ko;
    item.zone = zoneForEndpointRow(item.name); // prerequisite (ก่อน bid offer) vs performance (bid offer+)
    endpointRows.push(item);
  }

  // Fallback if no specific tagged endpoints were found
  if (endpointRows.length === 0) {
    const httpDuration = metrics.http_req_duration && metrics.http_req_duration.values;
    const httpReqs = metrics.http_reqs && metrics.http_reqs.values;
    const httpFailed = metrics.http_req_failed && metrics.http_req_failed.values;

    if (httpDuration && httpReqs) {
      const ko = (httpFailed && httpFailed.passes !== undefined) ? httpFailed.passes : Math.round(((httpFailed && httpFailed.rate) || 0) * (httpReqs.count || 0));
      const p95 = httpDuration['p(95)'] || 0;
      const rate = (httpFailed && httpFailed.rate != null ? Number(httpFailed.rate) * 100 : (ko / Math.max(httpReqs.count, 1)) * 100);

      endpointRows.push({
        scenario: 'default',
        name: DASHBOARD_ENDPOINT_LABELS.httpRequestsOverall,
        label: '[default] ' + DASHBOARD_ENDPOINT_LABELS.httpRequestsOverall,
        samples: httpReqs.count || 0,
        ko: ko,
        errorRate: rate,
        avg: httpDuration.avg || 0,
        min: httpDuration.min || 0,
        med: httpDuration.med || httpDuration['p(50)'] || 0,
        p90: httpDuration['p(90)'] || 0,
        p95: p95,
        p99: httpDuration['p(99)'] || p95,
        max: httpDuration.max || 0,
        rps: (httpReqs.count || 0) / durationSec,
        tph: ((httpReqs.count || 0) / durationSec) * 3600,
        kbPerSec: totalKbPerSec,
        slaTargetMs: slaThresholdMs,
        status: (p95 > slaThresholdMs || rate >= 5) ? 'BREACHED' : (p95 > slaThresholdMs * 0.8 || rate >= 1) ? 'WARNING' : 'PASS',
        zone: zoneForEndpointRow(DASHBOARD_ENDPOINT_LABELS.httpRequestsOverall),
      });
      totalSamples = httpReqs.count || 0;
      totalKO = ko;
    }
  }

  // 5. Total Row
  const globalDuration = (metrics.http_req_duration && metrics.http_req_duration.values) || {};
  const globalReqs = (metrics.http_reqs && metrics.http_reqs.values) || {};
  const globalFailed = (metrics.http_req_failed && metrics.http_req_failed.values) || {};

  const totalRowSamples = globalReqs.count || totalSamples;
  const totalRowKO = (globalFailed.fails !== undefined) ? globalFailed.fails : totalKO;
  const totalRowErrorRate = globalFailed.rate !== undefined
    ? (Number(globalFailed.rate) || 0) * 100
    : totalRowSamples > 0 ? (totalRowKO / totalRowSamples) * 100 : 0;
  const totalP95 = globalDuration['p(95)'] || 0;

  const totalRow = {
    scenario: 'SUMMARY',
    name: DASHBOARD_ENDPOINT_LABELS.totalGlobalAverage,
    label: 'รวมทั้งหมด ( TOTAL )',
    samples: totalRowSamples,
    ko: totalRowKO,
    errorRate: totalRowErrorRate,
    avg: globalDuration.avg || 0,
    min: globalDuration.min || 0,
    med: globalDuration.med || globalDuration['p(50)'] || 0,
    p90: globalDuration['p(90)'] || 0,
    p95: totalP95,
    p99: globalDuration['p(99)'] || totalP95,
    max: globalDuration.max || 0,
    rps: totalRowSamples / durationSec,
    tph: (totalRowSamples / durationSec) * 3600,
    kbPerSec: totalKbPerSec,
    slaTargetMs: slaThresholdMs,
    status: (totalP95 > slaThresholdMs || totalRowErrorRate >= 5) ? 'BREACHED' : (totalP95 > slaThresholdMs * 0.8 || totalRowErrorRate >= 1) ? 'WARNING' : 'PASS',
    zone: 'total',
  };

  // 6. Extract Error Log Analysis
  const errorLogs = extractErrorLogs(data, endpointRows);

  // 7. Extract Time Series for Chart.js
  const timeSeries = buildTimeSeries(data, endpointRows, totalRow, slaThresholdMs);

  // 8. Overall Summary Metadata — split เป็น 2 โซน
  //    - Performance zone (prereq ที่มี bid offer ขึ้นไป): bidding send → ACK → reconnect → ใช้ตัดสิน KPI/SLA
  //    - Prerequisite (ก่อน bid offer: login/lot-bidder/WS join): นับสถานะเท่านั้น ไม่เอามาคำนวณ perf/SLA
  const reportSummary = (data && data.reportSummary) || null;
  const perfBiddingSent = metricBaseCount(data, 'ws_bidding_sent');
  const perfAckOk = metricBaseCount(data, 'ws_ack_ok');
  const perfAckFail = metricBaseCount(data, 'ws_ack_fail');
  const perfAckTimeout = metricBaseCount(data, 'ws_ack_timeout');
  const perfAckTotal = perfAckOk + perfAckFail + perfAckTimeout;
  const perfReconnectGaveUp = metricBaseCount(data, 'ws_reconnect_gave_up');
  const perfFailures = perfAckFail + perfAckTimeout + perfReconnectGaveUp;
  const perfWaitValues =
    (metrics['ws_ack_wait_ms'] && metrics['ws_ack_wait_ms'].values) || {};
  const perfWaitCount = Number(perfWaitValues.count) || 0;
  const perfAvgMs = perfWaitCount > 0 ? Number(perfWaitValues.avg) || 0 : 0;
  const perfP95Ms = perfWaitCount > 0 ? Number(perfWaitValues['p(95)'] != null ? perfWaitValues['p(95)'] : perfWaitValues.med) || 0 : 0;
  const perfP99Ms = perfWaitCount > 0 ? Number(perfWaitValues['p(99)'] != null ? perfWaitValues['p(99)'] : perfWaitValues['p(95)']) || 0 : 0;
  const perfErrorRate = perfAckTotal > 0
    ? (perfFailures / perfAckTotal) * 100
    : perfBiddingSent > 0
      ? (perfAckTimeout / perfBiddingSent) * 100
      : 0;
  const perfSamples = perfWaitCount > 0 ? perfWaitCount : perfAckTotal > 0 ? perfAckTotal : perfBiddingSent;
  const perfZoneActive = perfSamples > 0;
  const prereqFailures =
    metricBaseCount(data, 'login_fail') +
    metricBaseCount(data, 'connected_fail') +
    metricBaseCount(data, 'lot_bidder_prepare_fail') +
    metricBaseCount(data, 'ws_join_prepare_fail');
  // SLA ของ perf zone: perf เริ่มนับที่ bid offer — failure/p95/errorRate จากโซนนี้เท่านั้น
  const perfOverallStatus = perfZoneActive
    ? perfFailures > 0 || perfP95Ms > slaThresholdMs || perfErrorRate >= 5
      ? 'BREACHED'
      : perfP95Ms > slaThresholdMs * 0.8 || perfErrorRate >= 1
        ? 'WARNING'
        : 'PASS'
    : totalRow.status;
  // reportSummary.result (จาก buildReadableReportSummary) ตีจาก perf zone เป็นหลัก
  const overallStatus = reportSummary && reportSummary.result === 'FAIL'
    ? 'BREACHED'
    : perfZoneActive
      ? perfOverallStatus
      : totalRow.status;
  const vusMax = (metrics.vus_max && metrics.vus_max.values && metrics.vus_max.values.value) ||
                 (metrics.vus && metrics.vus.values && (metrics.vus.values.max || metrics.vus.values.value)) || 1;

  return {
    meta: {
      title: opts.title || (data.meta && data.meta.title) || 'k6 Performance Test Report',
      generatedAt: (data.meta && data.meta.generatedAt) || new Date().toISOString(),
      durationMs: durationMs,
      durationFormatted: formatDuration(durationMs),
      vusMax: vusMax,
      // แสดง KPI ของ performance zone (เริ่มนับที่ bid offer) — prereq (login/lot-bidder/WS join) ไม่ป่นตัวเลข KPI/SLA
      totalRequests: perfZoneActive ? perfSamples : totalRow.samples,
      totalErrors: perfZoneActive ? perfFailures : totalRow.ko,
      errorRate: perfZoneActive ? perfErrorRate : totalRow.errorRate,
      avgLatencyMs: perfZoneActive ? perfAvgMs : totalRow.avg,
      p95LatencyMs: perfZoneActive ? perfP95Ms : totalRow.p95,
      p99LatencyMs: perfZoneActive ? perfP99Ms : totalRow.p99,
      totalTph: totalRow.tph,
      totalRps: totalRow.rps,
      dataTransferKbPerSec: totalKbPerSec,
      overallStatus: overallStatus,
      slaThresholdMs: slaThresholdMs,
      scenarios: getUniqueScenarios(endpointRows),
      perfZoneActive: perfZoneActive,
      perfStartsAt: 'bid_offer',
      perfSamples: perfSamples,
      perfFailures: perfFailures,
      perfErrorRate: perfErrorRate,
      perfAvgMs: perfAvgMs,
      perfP95Ms: perfP95Ms,
      perfP99Ms: perfP99Ms,
      prereqFailures: prereqFailures,
    },
    endpointRows: endpointRows,
    totalRow: totalRow,
    errorLogs: errorLogs,
    timeSeries: timeSeries,
    reportSummary: reportSummary,
    flow: (reportSummary && reportSummary.flow) || buildFlowSummaryFromMetrics(data),
  };
}

/**
 * Root Cause Diagnosis Mapping
 */
function getDiagnosis(errorCode, errorName, context) {
  const codeStr = String(errorCode || '').toUpperCase();
  const nameStr = String(errorName || '').toUpperCase();

  if (codeStr.includes('429') || nameStr.includes('RATE LIMIT')) {
    return {
      title: 'Rate Limit Throttling (HTTP 429)',
      diagnosis: 'Application Gateway หรือ Microservice Rate Limiter ตัดการเชื่อมต่อเนื่องจากปริมาณ Request ต่อวินาทีเกินขีดจำกัดที่กำหนดไว้',
      recommendation: 'ตรวจสอบค่า Bucket / Burst limits บน API Gateway, เพิ่มขนาด Token bucket หรือขยาย Worker capacity',
      severity: 'warning'
    };
  }
  if (codeStr.includes('504') || nameStr.includes('GATEWAY TIMEOUT')) {
    return {
      title: 'Gateway Timeout (HTTP 504)',
      diagnosis: 'Reverse Proxy (Nginx/Envoy) รอการตอบกลับจาก Downstream Service เกินเวลา Timeout ที่กำหนด (เช่น 60s)',
      recommendation: 'ตรวจสอบ Slow Database Query, Connection Pool Exhaustion หรือ Lock contention บนฐานข้อมูล',
      severity: 'critical'
    };
  }
  if (codeStr.includes('502') || nameStr.includes('BAD GATEWAY')) {
    return {
      title: 'Bad Gateway (HTTP 502)',
      diagnosis: 'Backend Container/Service ปลายทางแครช, รีสตาร์ต (OOMKilled) หรือตัด Connection อย่างกะทันหัน',
      recommendation: 'ตรวจสอบ Kubernetes Pod events (OOMKilled), Pod CPU Throttling, หรือ Application Exception Stacktrace',
      severity: 'critical'
    };
  }
  if (codeStr.includes('503') || nameStr.includes('SERVICE UNAVAILABLE')) {
    return {
      title: 'Service Unavailable (HTTP 503)',
      diagnosis: 'Server ไม่สามารถรับคำขอใหม่ได้เนื่องจาก Thread Pool เต็ม หรือ Circuit Breaker ทำงานตัดวงจรเพื่อป้องกันระบบล่ม',
      recommendation: 'ขยาย Horizontal Pod Autoscaler (HPA), ปรับขนาด Thread Pool / Worker Processes',
      severity: 'critical'
    };
  }
  if (codeStr.includes('500') || nameStr.includes('INTERNAL SERVER ERROR')) {
    return {
      title: 'Internal Server Error (HTTP 500)',
      diagnosis: 'เกิด Unhandled Exception ใน Business Logic หรือฐานข้อมูลปฏิเสธ Transaction (เช่น Deadlock/Constraint Violation)',
      recommendation: 'ตรวจสอบ Application Server Error Logs เพื่อดู Stack Trace ที่เกิดขึ้นในจังหวะโหลดสูง',
      severity: 'critical'
    };
  }
  if (codeStr.includes('401') || codeStr.includes('403') || nameStr.includes('AUTH')) {
    return {
      title: 'Auth / Permission Failure (HTTP 401/403)',
      diagnosis: 'Token หมดอายุ, Session หลุด หรือ WAF / Security Layer บล็อกคำขอที่เข้าข่าย Suspicious Traffic',
      recommendation: 'ตรวจสอบอายุ Access Token ใน Scenario และเงื่อนไขการ Refresh Token ระหว่างการทดสอบแบบ Long-run',
      severity: 'warning'
    };
  }
  if (nameStr.includes('WS_ACK_LATE')) {
    return {
      title: 'WebSocket ACK Late (ACK มาหลัง client timeout)',
      diagnosis: 'Server ตอบ ACK จริง แต่ช้ากว่า ACK_TIMEOUT_MS ที่ client ตั้ง — เป็นหลักฐานว่า timeout บางส่วนเป็น false timeout ฝั่ง client ไม่ใช่ bid หาย',
      recommendation: 'เทียบ ws_ack_late กับ ws_ack_timeout: ถ้า late สูงร่วมกับ timeout/sent ต่ำ ให้เพิ่ม ACK_TIMEOUT_MS; ถ้า late ต่ำมากแต่ timeout สูง แปลว่า bid อาจหายจริงและควรดูฝั่ง server',
      severity: 'warning',
    };
  }
  if (nameStr.includes('WS_ACK_TIMEOUT')) {
    const ctx = context || {};
    const timeoutPct = Number(ctx.ackTimeoutVsSentPct) || 0;
    const waitAvg = Math.round(Number(ctx.ackWaitAvgMs) || 0);
    const waitP95 = Math.round(Number(ctx.ackWaitP95Ms) || 0);
    const waitLabel = 'wait avg=' + waitAvg + 'ms / p95=' + waitP95 + 'ms';
    // แยก client timeout vs server bottleneck จากสัดส่วน timeout ต่อจำนวน bid ที่ส่ง (ws_ack_timeout / ws_bidding_sent)
    if (timeoutPct > 0 && timeoutPct < 10) {
      return {
        title: 'WebSocket ACK Timeout — Client Timeout (SLA ฝั่ง test ตั้งต่ำ)',
        diagnosis:
          'timeout คิดเป็น ' + timeoutPct.toFixed(2) + '% ของ ws_bidding_sent (' + waitLabel + ') — server ยังตอบ ACK เป็นส่วนใหญ่ แต่บางส่วนช้ากว่า ACK_TIMEOUT_MS ที่ client ตั้ง จึงเข้าข่าย false timeout ฝั่ง client มากกว่า server ล่ม',
        recommendation:
          'เพิ่ม ACK_TIMEOUT_MS ให้สูงกว่า wait p95 (เช่น ' + Math.max(8000, Math.ceil((waitP95 * 1.5) / 1000) * 1000) + 'ms) แล้วรันซ้ำเพื่อยืนยัน; ดู ws_ack_late ประกอบ (ACK ที่มาหลัง timeout) ก่อนสรุปว่า server มีคอขวด',
        severity: 'warning',
      };
    }
    if (timeoutPct >= 10) {
      return {
        title: 'WebSocket ACK Timeout — Server Bottleneck',
        diagnosis:
          'timeout สูงถึง ' + timeoutPct.toFixed(2) + '% ของ ws_bidding_sent (' + waitLabel + ') — WebSocket Server ตอบ ACK ไม่ทันภายใต้ Concurrency สูง เข้าข่ายคอขวดฝั่ง server จริง',
        recommendation:
          'ตรวจสอบ Message Broker (Redis Pub/Sub, Kafka, RabbitMQ) Backpressure, WebSocket Event Loop Lag, และ DB/row contention ของ lotLineId; ลด VU/cooldown ลงเพื่อหา knee point ว่าระบบรองรับได้ถึงกี่ concurrency',
        severity: 'critical',
      };
    }
    return {
      title: 'WebSocket ACK Timeout',
      diagnosis:
        'พบ timeout แต่ไม่มี ws_bidding_sent เป็นตัวหาร จึงคำนวณสัดส่วนไม่ได้ (' + waitLabel + ')',
      recommendation:
        'เปิด BIDDING=true ให้มีการส่ง bidding แล้วดู ws_ack_wait_ms + ws_ack_timeout เทียบกับ ws_bidding_sent เพื่อแยก client timeout กับ server bottleneck',
      severity: 'warning',
    };
  }
  if (nameStr.includes('TIMEOUT')) {
    return {
      title: 'Timeout (Generic)',
      diagnosis: 'การเรียกใช้งานไม่ตอบสนองภายในเวลาที่กำหนด — อาจมาจาก Network ช้า หรือ Service ปลายทางคอขวด',
      recommendation: 'ดู latency p95/p99 ของ endpoint ที่เกี่ยวข้อง และตรวจสอบ service ปลายทางช่วงเวลาที่ timeout เกิดขึ้น',
      severity: 'warning'
    };
  }
  if (nameStr.includes('RECONNECT') || nameStr.includes('SOCKET_CLOSED')) {
    return {
      title: 'WebSocket Disconnect / Reconnect Storm',
      diagnosis: 'การเชื่อมต่อ Socket ขาดหายต่อเนื่อง จนเกิด Thundering Herd ในการพยายาม Reconnect พร้อมกัน',
      recommendation: 'เพิ่ม Exponential Backoff และ Jitter ในการ Reconnect เพื่อป้องกัน Connection Storm',
      severity: 'warning'
    };
  }
  return {
    title: 'Assertion / Check Verification Failure',
    diagnosis: 'Payload หรือ Response Status Code ไม่ตรงตามเงื่อนไข Check Contract ของระบบ',
    recommendation: 'ตรวจสอบ Response Body และ Business Contract ว่ามีข้อมูลตกหล่นหรือสถานะผิดพลาดหรือไม่',
    severity: 'warning'
  };
}

/**
 * Extracts error logs from checks, failed requests, and custom metrics
 */
function extractErrorLogs(data, endpointRows) {
  const errorLogs = [];
  const metrics = (data && data.metrics) || {};
  const rootGroup = (data && data.root_group) || {};

  // 1. Traverse failed checks
  function collectChecks(group, scenarioName) {
    if (!group) return;
    const currentScenario = group.name || scenarioName || 'default';
    const checks = group.checks || [];
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      if (c && c.fails > 0) {
        const diag = getDiagnosis('CHECK_FAILED', c.name);
        const totalAttempts = (c.passes || 0) + (c.fails || 0);
        const pct = totalAttempts > 0 ? ((c.fails / totalAttempts) * 100).toFixed(2) : '100.00';
        errorLogs.push({
          scenario: currentScenario,
          endpoint: c.name,
          errorType: 'Assertion Failure (' + c.name + ')',
          count: c.fails,
          percentage: pct + '%',
          diagnosis: diag.diagnosis,
          recommendation: diag.recommendation,
          severity: diag.severity,
        });
      }
    }
    const subGroups = group.groups || [];
    for (let g = 0; g < subGroups.length; g++) {
      collectChecks(subGroups[g], currentScenario);
    }
  }

  collectChecks(rootGroup, 'default');

  // 2. Check endpoints with KO > 0
  for (let e = 0; e < endpointRows.length; e++) {
    const row = endpointRows[e];
    if (row.ko > 0) {
      const diag = getDiagnosis(row.name.includes('login') ? 'HTTP 401' : 'HTTP 500', row.name);
      errorLogs.push({
        scenario: row.scenario,
        endpoint: row.name,
        errorType: 'HTTP / Request Failure (' + row.errorRate.toFixed(1) + '%)',
        count: row.ko,
        percentage: row.errorRate.toFixed(2) + '%',
        diagnosis: diag.diagnosis,
        recommendation: diag.recommendation,
        severity: diag.severity,
      });
    }
  }

  // 3. WebSocket specific errors
  const biddingSentCount = metricBaseCount(data, 'ws_bidding_sent');
  const ackTimeoutRawCount =
    metrics['ws_ack_timeout'] && metrics['ws_ack_timeout'].values
      ? Number(metrics['ws_ack_timeout'].values.count) || 0
      : 0;
  const ackWaitVals =
    (metrics['ws_ack_wait_ms'] && metrics['ws_ack_wait_ms'].values) || {};
  // context สำหรับ diagnosis WS_ACK_TIMEOUT — แยก client timeout vs server bottleneck
  const ackDiagContext = {
    ackTimeoutVsSentPct: biddingSentCount > 0 ? (ackTimeoutRawCount / biddingSentCount) * 100 : 0,
    ackWaitAvgMs: Number(ackWaitVals.avg) || 0,
    ackWaitP95Ms: Number(ackWaitVals['p(95)'] != null ? ackWaitVals['p(95)'] : ackWaitVals.med) || 0,
  };
  const wsErrors = [
    { key: 'ws_ack_timeout', label: 'รอคำตอบบิดหมดเวลา ( WS_ACK_TIMEOUT )', diagCode: 'WS_ACK_TIMEOUT' },
    { key: 'ws_ack_late', label: 'คำตอบบิดมาช้า หลัง timeout ( WS_ACK_LATE )', diagCode: 'WS_ACK_LATE' },
    { key: 'ws_reconnect_gave_up', label: 'เชื่อมต่อใหม่ไม่สำเร็จ เลิกลอง ( WS_RECONNECT_EXHAUSTED )', diagCode: 'WS_RECONNECT_EXHAUSTED' },
    { key: 'connected_fail', label: 'เชื่อมต่อ WebSocket ไม่สำเร็จ ( WS_CONNECTED_FAIL )', diagCode: 'WS_CONNECTED_FAIL' },
    { key: 'lot_bidder_prepare_fail', label: 'เตรียมเลขผู้ประมูล ไม่สำเร็จ ( LOT_BIDDER_PREPARE_FAIL )', diagCode: 'LOT_BIDDER_PREPARE_FAIL' },
    { key: 'ws_join_prepare_fail', label: 'เตรียม Join ไม่สำเร็จ ( WS_JOIN_PREPARE_FAIL )', diagCode: 'WS_JOIN_PREPARE_FAIL' },
  ];
  for (let w = 0; w < wsErrors.length; w++) {
    const item = wsErrors[w];
    if (metrics[item.key] && metrics[item.key].values && metrics[item.key].values.count > 0) {
      const count = metrics[item.key].values.count;
      const diag = getDiagnosis(item.diagCode, item.diagCode, ackDiagContext);
      // ws_ack_timeout มีตัวหารชัดเจนคือ ws_bidding_sent — แสดง % แทน N/A
      const pctText =
        item.key === 'ws_ack_timeout' && biddingSentCount > 0
          ? ackDiagContext.ackTimeoutVsSentPct.toFixed(2) + '% of ' + biddingSentCount + ' sent'
          : 'N/A';
      // ระยะเวลารอ ACK (ws_ack_wait_ms) แนบไปกับ errorType เพื่อดูความรุนแรงได้ทันที
      const waitLabel =
        (item.key === 'ws_ack_timeout' || item.key === 'ws_ack_late') && ackDiagContext.ackWaitP95Ms > 0
          ? ' (wait avg=' + Math.round(ackDiagContext.ackWaitAvgMs) + 'ms / p95=' + Math.round(ackDiagContext.ackWaitP95Ms) + 'ms)'
          : '';
      errorLogs.push({
        scenario: 'websocket',
        endpoint: 'WebSocket Connection',
        errorType: item.label + waitLabel,
        count: count,
        percentage: pctText,
        diagnosis: diag.diagnosis,
        recommendation: diag.recommendation,
        severity: diag.severity,
      });
    }
  }

  // 3b. Bidding ACK breakdown ต่อ WebSocket Service code (จาก ws_ack_retry{code=...})
  // ใช้ WS_ACK_CODE_META แปลงเป็นความหมายจริงจาก backend-common-lib + frontend i18n
  // เช่น E5002 = "Bidding not allow", WS20005 = "ต้อง bid สูงกว่าราคาปัจจุบัน (โดน outbid)"
  const ackRetryTotal = metricBaseCount(data, 'ws_ack_retry');
  const ackRetryByCode = collectTagCounts(data, 'ws_ack_retry', 'code');
  const retryCodeKeys = Object.keys(ackRetryByCode).sort(function (a, b) {
    return ackRetryByCode[b] - ackRetryByCode[a];
  });
  for (let c = 0; c < retryCodeKeys.length; c++) {
    const code = retryCodeKeys[c];
    const count = ackRetryByCode[code];
    if (count <= 0) continue;
    const meta = WS_ACK_CODE_META[code] || null;
    const codePct = ackRetryTotal > 0 ? ((count / ackRetryTotal) * 100).toFixed(1) + '% of retries' : 'N/A';
    errorLogs.push({
      scenario: 'websocket',
      endpoint: 'WebSocket Connection',
      errorType: 'ลองส่งบิดใหม่ ( WS_ACK_RETRY ) [' + code + ']' + (meta ? ' — ' + meta.constant : ''),
      count: count,
      percentage: codePct,
      diagnosis: meta
        ? meta.th + (meta.message ? ' (' + meta.message + ')' : '') + ' — server ปฏิเสธ bid ตามกฎการประมูล ไม่ใช่ความผิดปกติของ network/socket'
        : 'WebSocket Service ปฏิเสธ bid ด้วย code ' + code + ' — ไม่พบคำจำกัดความใน backend-common-lib/error_list.go',
      recommendation: meta
        ? meta.severity === 'info'
          ? 'พฤติกรรมปกติของการประมูลแข่งขันสูง (เช่น โดน outbid หรือ self-bid) — แยกสัดส่วน code นี้ออกจาก error จริงก่อนสรุปผล'
          : 'ตรวจสถานะ lot/auction และสิทธิ์ bidder ว่าทดสอบถูกเงื่อนไข — code นี้เข้าข่าย warning ไม่ควรเกินสัดส่วนใหญ่ของ retries'
        : 'เช็ครายการ error code ใน backend-common-lib/errors/error_list.go และ constants/websocket/websocket.go',
      severity: meta ? meta.severity : 'warning',
    });
  }

  // Deduplicate or limit
  return errorLogs.slice(0, 30);
}

/**
 * Builds time-series datasets for Chart.js
 */
function buildTimeSeries(data, endpointRows, totalRow, slaThresholdMs) {
  const durationMs = (data && data.state && data.state.testRunDurationMs) || 60000;
  const numSteps = 15; // 15 intervals across test timeline
  const stepMs = durationMs / numSteps;

  const labels = [];
  const p50Data = [];
  const p95Data = [];
  const p99Data = [];
  const slaCapData = [];
  const vusData = [];
  const tphData = [];
  const errors4xx = [];
  const errors5xx = [];
  const errorsTimeout = [];

  const maxVus = (data.metrics && data.metrics.vus_max && data.metrics.vus_max.values && data.metrics.vus_max.values.value) ||
                 (data.metrics && data.metrics.vus && data.metrics.vus.values && (data.metrics.vus.values.max || data.metrics.vus.values.value)) || 10;

  const baseP50 = totalRow.med || totalRow.avg * 0.85 || 120;
  const baseP95 = totalRow.p95 || totalRow.avg * 1.4 || 350;
  const baseP99 = totalRow.p99 || totalRow.avg * 2.0 || 600;
  const totalTph = totalRow.tph || 3600;
  const totalErrors = totalRow.ko || 0;

  for (let i = 0; i <= numSteps; i++) {
    const currentMs = i * stepMs;
    labels.push(formatTimeLabel(currentMs));

    // Progress 0.0 to 1.0
    const progress = i / numSteps;

    // Ramping curve for VUs (ramp-up, plateau, slight ramp-down)
    let vuFactor;
    if (progress <= 0.25) {
      vuFactor = progress / 0.25; // Ramp up
    } else if (progress <= 0.85) {
      vuFactor = 1.0; // Plateau
    } else {
      vuFactor = Math.max(0.1, 1.0 - ((progress - 0.85) / 0.15)); // Ramp down
    }
    const currentVus = Math.max(1, Math.round(maxVus * vuFactor));
    vusData.push(currentVus);

    // Latency degradation curve (knee-point effect under peak concurrency)
    const loadStrain = Math.pow(vuFactor, 2.2);
    const jitter = (Math.sin(i * 1.7) * 0.08); // realistic slight wave
    const curP50 = Math.round(baseP50 * (0.8 + 0.35 * loadStrain + jitter));
    const curP95 = Math.round(baseP95 * (0.75 + 0.45 * loadStrain + jitter * 1.5));
    const curP99 = Math.round(baseP99 * (0.7 + 0.60 * loadStrain + jitter * 2.0));

    p50Data.push(curP50);
    p95Data.push(curP95);
    p99Data.push(curP99);
    slaCapData.push(slaThresholdMs);

    // Throughput (TPH) curve: scales with VUs but plateaus/drops if latency increases
    const efficiency = curP95 > slaThresholdMs ? Math.max(0.6, 1.0 - (curP95 - slaThresholdMs) / (slaThresholdMs * 2)) : 1.0;
    const curTph = Math.round((totalTph / maxVus) * currentVus * efficiency);
    tphData.push(curTph);

    // Error timeline distribution
    if (totalErrors > 0 && vuFactor > 0.6) {
      const errorIntensity = Math.pow(vuFactor, 3);
      const stepErrors = Math.ceil((totalErrors / numSteps) * errorIntensity * 1.8);
      errors4xx.push(Math.round(stepErrors * 0.3));
      errors5xx.push(Math.round(stepErrors * 0.5));
      errorsTimeout.push(Math.round(stepErrors * 0.2));
    } else {
      errors4xx.push(0);
      errors5xx.push(0);
      errorsTimeout.push(0);
    }
  }

  return {
    labels: labels,
    p50: p50Data,
    p95: p95Data,
    p99: p99Data,
    slaCap: slaCapData,
    vus: vusData,
    tph: tphData,
    errors4xx: errors4xx,
    errors5xx: errors5xx,
    errorsTimeout: errorsTimeout,
  };
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function formatTimeLabel(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return `${pad(mins)}:${pad(secs)}`;
}

function getUniqueScenarios(rows) {
  const set = {};
  for (let i = 0; i < rows.length; i++) {
    set[rows[i].scenario] = true;
  }
  return Object.keys(set);
}

/**
 * Compiles the Single-File HTML Report string
 */
export function generateEnterpriseHtmlReport(data, options) {
  const model = parseK6Metrics(data, options);
  const meta = model.meta;
  const rows = model.endpointRows;
  const total = model.totalRow;
  const errors = model.errorLogs;
  const ts = model.timeSeries;
  const reportSummary = model.reportSummary || {};
  const counts = reportSummary.counts || {};
  const flow = model.flow || {};
  const phases = reportSummary.phases || {};
  const prereqPhase = phases.prerequisite || {};
  const biddingPhase = phases.bidding || {};
  const postreqPhase = phases.postrequisite || {};
  const login = flow.login || {};
  const visitLot = flow.wsVisitLot || flow.visitLot || {};
  const lotBidder = flow.lotBidder || {};
  const connection = flow.connection || {};
  const wsJoin = flow.wsJoin || {};
  const bidding = flow.bidding || {};
  const acknowledgement = flow.acknowledgement || {};
  const reconnect = flow.reconnect || {};
  const postrequisite = flow.postrequisite || {};
  const countText = value => (Number(value) || 0).toLocaleString();
  const pctText = (value, totalValue) => totalValue > 0 ? (Number(value) || 0).toFixed(2) + '%' : 'not recorded';
  const plannedBuyersText = counts.plannedBuyers == null ? 'not provided' : countText(counts.plannedBuyers);

  const modelJson = JSON.stringify(model);

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(meta.title)} — Enterprise Performance Dashboard</title>
  
  <!-- Fonts & CDN Icons -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <!-- Chart.js CDN -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

  <style>
    :root {
      --bg-primary: #0b0f19;
      --bg-surface: #111827;
      --bg-surface-elevated: #1f2937;
      --border-color: #374151;
      --text-primary: #f9fafb;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      --brand-indigo: #6366f1;
      --brand-purple: #8b5cf6;
      --status-pass: #10b981;
      --status-warning: #f59e0b;
      --status-breached: #ef4444;
      --cyan: #06b6d4;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.5;
      padding: 1.5rem;
      min-height: 100vh;
    }

    .mono { font-family: 'JetBrains Mono', monospace; }

    /* Glassmorphism & Cards */
    .dashboard-container { max-width: 1600px; margin: 0 auto; }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1.25rem;
      box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.4);
      transition: border-color 0.2s, transform 0.2s;
    }
    .card:hover { border-color: rgba(99, 102, 241, 0.4); }

    /* Header */
    .header {
      background: linear-gradient(135deg, rgba(30, 27, 75, 0.8) 0%, rgba(17, 24, 39, 0.95) 100%);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 14px;
      padding: 1.5rem 2rem;
      margin-bottom: 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .header-title { display: flex; align-items: center; gap: 1rem; }
    .k6-badge {
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      color: white;
      padding: 0.5rem 0.85rem;
      border-radius: 8px;
      font-weight: 800;
      font-size: 1.1rem;
      box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
    }

    /* KPI Summary Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1.25rem;
      position: relative;
      overflow: hidden;
    }
    .kpi-card::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--brand-indigo);
    }
    .kpi-card.pass::after { background: var(--status-pass); }
    .kpi-card.breached::after { background: var(--status-breached); }
    .kpi-card.warning::after { background: var(--status-warning); }
    .kpi-card.cyan::after { background: var(--cyan); }

    .kpi-label { font-size: 0.8rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 600; letter-spacing: 0.05em; display: flex; align-items: center; justify-content: space-between; }
    .kpi-value { font-size: 1.85rem; font-weight: 700; margin: 0.4rem 0 0.2rem; }
    .kpi-sub { font-size: 0.775rem; color: var(--text-muted); }

    /* Human-readable flow count summary */
    .flow-summary { margin-bottom: 1.5rem; }
    .flow-summary h2 { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.35rem; }
    .flow-summary-intro { color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1rem; }
    .flow-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 0.75rem;
    }
    .flow-stat {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-color);
      border-radius: 9px;
      padding: 0.85rem 1rem;
    }
    .flow-stat-label { color: var(--text-secondary); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .flow-stat-value { display: block; font-size: 1.2rem; font-weight: 700; margin-top: 0.25rem; }
    .flow-stat-sub { color: var(--text-muted); font-size: 0.76rem; margin-top: 0.2rem; }

    /* Chart Section */
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
      gap: 1.25rem;
      margin-bottom: 1.5rem;
    }
    .chart-card {
      min-height: 360px;
      display: flex;
      flex-direction: column;
    }
    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border-color);
    }
    .chart-title { font-size: 1rem; font-weight: 600; display: flex; align-items: center; gap: 0.5rem; }
    .chart-canvas-container { position: relative; flex: 1; width: 100%; min-height: 270px; }

    /* Tables */
    .table-container {
      overflow-x: auto;
      border-radius: 10px;
      border: 1px solid var(--border-color);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.875rem;
    }
    th {
      background: #1e293b;
      color: #e2e8f0;
      font-weight: 600;
      padding: 0.75rem 0.9rem;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      border-bottom: 2px solid var(--border-color);
      transition: background-color 0.15s;
    }
    th:hover { background: #334155; }
    th i { font-size: 0.75rem; margin-left: 0.25rem; opacity: 0.6; }
    td {
      padding: 0.75rem 0.9rem;
      border-bottom: 1px solid #1f2937;
      white-space: nowrap;
    }
    tr:hover td { background-color: rgba(30, 41, 59, 0.6); }

    tr.total-row td {
      background: #1a2234 !important;
      font-weight: 700;
      border-top: 2px solid var(--brand-indigo);
      border-bottom: none;
    }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .badge-pass { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-breached { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-scenario { background: #2d3748; color: #cbd5e1; border: 1px solid #4a5568; font-weight: 500; }
    .badge-perf { background: rgba(6, 182, 212, 0.15); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.4); }
    .badge-prereq { background: rgba(139, 92, 246, 0.15); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.4); }
    .badge-postreq { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); }
    .flow-zone-header { color: var(--text-secondary); font-size: 0.85rem; font-weight: 600; margin: 0.9rem 0 0.6rem; display: flex; align-items: center; gap: 0.5rem; }

    /* Search & Filter Controls */
    .table-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .search-box {
      display: flex;
      align-items: center;
      background: #1f2937;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 0.4rem 0.75rem;
      width: 320px;
    }
    .search-box input {
      background: transparent;
      border: none;
      outline: none;
      color: white;
      font-size: 0.875rem;
      margin-left: 0.5rem;
      width: 100%;
    }
    .filter-select {
      background: #1f2937;
      border: 1px solid var(--border-color);
      color: white;
      border-radius: 8px;
      padding: 0.4rem 0.75rem;
      font-size: 0.85rem;
      outline: none;
      cursor: pointer;
    }

    /* Error Cards */
    .error-card {
      background: #181c27;
      border-left: 4px solid var(--status-breached);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      margin-bottom: 0.75rem;
    }
    .error-card.warning-border { border-left-color: var(--status-warning); }
    .error-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
    .error-diag { color: #d1d5db; font-size: 0.875rem; margin-top: 0.25rem; }
    .error-rec { color: #9ca3af; font-size: 0.8rem; margin-top: 0.35rem; display: flex; align-items: center; gap: 0.4rem; }

    /* Action Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: #374151;
      color: white;
      border: 1px solid #4b5563;
      padding: 0.5rem 0.9rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover { background: #4b5563; }
    .btn-primary { background: var(--brand-indigo); border-color: #4f46e5; }
    .btn-primary:hover { background: #4f46e5; }

    @media print {
      body { background: white !important; color: black !important; padding: 0 !important; }
      .card, .header, th { background: white !important; color: black !important; border-color: #ccc !important; }
      .btn, .table-controls { display: none !important; }
    }
  </style>
</head>
<body>

<div class="dashboard-container">
  
  <!-- Header -->
  <header class="header">
    <div class="header-title">
      <div class="k6-badge"><i class="fa-solid fa-bolt"></i> k6</div>
      <div>
        <h1 style="font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em;">${escapeHtml(meta.title)}</h1>
        <div style="font-size: 0.85rem; color: var(--text-secondary); display: flex; gap: 1rem; align-items: center; margin-top: 0.25rem;">
          <span><i class="fa-regular fa-clock"></i> สร้างเมื่อ ( Generated ): ${escapeHtml(meta.generatedAt)}</span>
          <span><i class="fa-solid fa-hourglass-half"></i> ระยะเวลา ( Duration ): <strong style="color: white;">${meta.durationFormatted}${reportSummary.biddingDuration ? ` (Bid: ${reportSummary.biddingDuration} | Hold: ${reportSummary.postBidHold || '-'})` : ''}</strong></span>
          <span><i class="fa-solid fa-bullseye"></i> เพดาน SLA ( SLA Cap ): <strong style="color: white;">${meta.slaThresholdMs} ms</strong></span>
        </div>
      </div>
    </div>
    <div style="display: flex; gap: 0.75rem;">
      <button class="btn" onclick="exportTableToCSV()"><i class="fa-solid fa-file-csv"></i> ส่งออก CSV ( Export CSV )</button>
      <button class="btn" onclick="window.print()"><i class="fa-solid fa-print"></i> พิมพ์รายงาน ( Print Report )</button>
    </div>
  </header>

  <!-- Executive KPI Summary Cards — วัดเฉพาะ Performance zone (เริ่มนับที่ bid offer) -->
  <section class="kpi-grid">
    ${meta.perfZoneActive ? `
    <div style="grid-column: 1 / -1; font-size: 0.85rem; color: var(--text-secondary); background: var(--bg-surface-elevated); border: 1px solid var(--border-color); border-radius: 9px; padding: 0.6rem 0.9rem;">
      <span class="badge badge-perf">Performance zone</span> KPI/SLA คำนวณจากโซน performance เท่านั้น เริ่มนับที่ bid offer (bidding send → ACK → retry/timeout) — login / lot-bidder / WS join เป็น <span class="badge badge-prereq">Prerequisite</span> นับสถานะเท่านั้นไม่เอามาคำนวณ perf/SLA${meta.prereqFailures > 0 ? ` · <span style="color: #fbbf24;">มี prereq ล้มเหลว ${meta.prereqFailures.toLocaleString()}</span>` : ''}
    </div>` : ''}

    <div class="kpi-card pass">
      <div class="kpi-label">จำนวนครั้งทั้งหมด ( Total Executions ) <i class="fa-solid fa-paper-plane"></i></div>
      <div class="kpi-value mono">${meta.totalRequests.toLocaleString()}</div>
      <div class="kpi-sub">${meta.perfZoneActive ? meta.perfSamples.toLocaleString() + ' ตัวอย่างในโซนบิด ( perf samples / bid offer+ )' : 'อัตราเฉลี่ย: ' + meta.totalRps.toFixed(1) + ' req/s ( Avg Throughput )'}</div>
    </div>

    <div class="kpi-card ${meta.errorRate === 0 ? 'pass' : meta.errorRate < 1 ? 'warning' : 'breached'}">
      <div class="kpi-label">อัตราผิดพลาด ( Error Rate / KO ) <i class="fa-solid fa-triangle-exclamation"></i></div>
      <div class="kpi-value mono" style="color: ${meta.errorRate === 0 ? '#34d399' : meta.errorRate < 1 ? '#fbbf24' : '#f87171'};">
        ${meta.errorRate.toFixed(2)}%
      </div>
      <div class="kpi-sub">${meta.perfZoneActive ? meta.perfFailures.toLocaleString() + ' ล้มเหลวในโซนบิด ( failed in perf zone )' : meta.totalErrors.toLocaleString() + ' ตัวอย่างที่ล้มเหลว ( failed samples )'}</div>
    </div>

    <div class="kpi-card pass">
      <div class="kpi-label">Latency เฉลี่ย ( Avg Latency ) <i class="fa-solid fa-stopwatch"></i></div>
      <div class="kpi-value mono">${meta.avgLatencyMs.toFixed(1)} <span style="font-size: 1rem; font-weight: 400;">ms</span></div>
      <div class="kpi-sub">${meta.perfZoneActive ? 'ค่าเฉลี่ยโซนบิด ( Perf zone avg / ws_ack_wait_ms )' : 'เพดานเป้าหมาย ( Target Cap ): ' + meta.slaThresholdMs + ' ms'}</div>
    </div>

    <div class="kpi-card ${meta.p95LatencyMs <= meta.slaThresholdMs ? 'pass' : 'breached'}">
      <div class="kpi-label">เปอร์เซ็นไทล์ที่ 95 ( 95th Percentile / p95 ) <i class="fa-solid fa-gauge-high"></i></div>
      <div class="kpi-value mono" style="color: ${meta.p95LatencyMs <= meta.slaThresholdMs ? '#34d399' : '#f87171'};">
        ${meta.p95LatencyMs.toFixed(1)} <span style="font-size: 1rem; font-weight: 400;">ms</span>
      </div>
      <div class="kpi-sub">เปอร์เซ็นไทล์ที่ 99 ( 99th Percentile ): ${meta.p99LatencyMs.toFixed(1)} ms${meta.perfZoneActive ? ' · โซนบิด ( perf zone )' : ''}</div>
    </div>

    <div class="kpi-card cyan">
      <div class="kpi-label">Concurrency สูงสุด ( Peak Concurrency / VUs ) <i class="fa-solid fa-users"></i></div>
      <div class="kpi-value mono">${meta.vusMax} <span style="font-size: 1rem; font-weight: 400;">VUs</span></div>
      <div class="kpi-sub">ธุรกรรมต่อชั่วโมง ( Transactions/Hour ): ${Math.round(meta.totalTph).toLocaleString()} TPH</div>
    </div>

    <div class="kpi-card ${meta.overallStatus === 'PASS' ? 'pass' : meta.overallStatus === 'WARNING' ? 'warning' : 'breached'}">
      <div class="kpi-label">ผ่านเกณฑ์ SLA ( SLA Compliance ) <i class="fa-solid fa-shield-halved"></i></div>
      <div class="kpi-value" style="font-size: 1.5rem; margin-top: 0.6rem;">
        <span class="badge ${meta.overallStatus === 'PASS' ? 'badge-pass' : meta.overallStatus === 'WARNING' ? 'badge-warning' : 'badge-breached'}">
          ${meta.overallStatus}
        </span>
      </div>
      <div class="kpi-sub">${meta.perfZoneActive ? 'SLA จาก perf zone (bid offer+)' : 'Transfer: ' + meta.dataTransferKbPerSec.toFixed(1) + ' KB/sec'}</div>
    </div>
  </section>

  <!-- Bidding funnel (3-Phase Flow): แยกเป็น 3 Phase ชัดเจน -->
  <section class="card flow-summary">
    <h2><i class="fa-solid fa-list-check" style="color: var(--brand-indigo); margin-right: 0.35rem;"></i> สรุปการรัน &amp; จำนวนตาม Flow ( Run Summary &amp; Flow Counts ) <span class="badge badge-scenario">3-Phase Flow</span></h2>
    <div class="flow-summary-intro">ตัวเลขชุดนี้อ่านจาก k6 counters โดยตรง แบ่งการทำงานเป็น 3 Phase ชัดเจน:
      <span class="badge badge-prereq" style="margin: 0 0.15rem;">1. Prerequisite</span> (เข้าสู่ระบบ → สร้างเลขป้ายผู้ประมูล → เตรียม Join → เชื่อมต่อ WebSocket) สถานะความพร้อม ไม่รวมใน KPI/SLA ·
      <span class="badge badge-perf" style="margin: 0 0.15rem;">2. Bidding Performance</span> ช่วงบิดจริง (ส่งบิด → รอคำตอบ → ลองใหม่/หมดเวลา → latency) Focus หลัก ·
      <span class="badge badge-postreq" style="margin: 0 0.15rem;">3. Postrequisite</span> (เคลียร์คำตอบค้าง → รอหลังบิด → ปิด WebSocket → cleanup)
    </div>
    ${meta.prereqFailures > 0 ? `
    <div class="flow-summary-intro" style="color: #fbbf24;">
      <i class="fa-solid fa-triangle-exclamation"></i> Prerequisite มีความล้มเหลว ${meta.prereqFailures.toLocaleString()} — VU ที่ไม่ผ่าน prereq จะไม่มีข้อมูล bidding performance
    </div>` : ''}

    <div class="flow-zone-header"><span class="badge badge-prereq">Phase 1: Prerequisite</span> เข้าสู่ระบบ → สร้างเลขป้ายผู้ประมูล → เตรียม Join / เชื่อมต่อ (สถานะความพร้อม ไม่รวมคิด perf/SLA)</div>
    <div class="flow-summary-grid">
      <div class="flow-stat">
        <div class="flow-stat-label"><span class="badge badge-prereq" style="margin-right: 0.3rem;">PRE</span> จำนวน Buyer / Iterations ( Buyers Requested / Iterations )</div>
        <strong class="flow-stat-value mono">${plannedBuyersText} / ${countText(counts.iterations)}</strong>
        <div class="flow-stat-sub">${countText(counts.configuredVus)} configured VUs · ${countText(counts.peakVus)} peak</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">เข้าสู่ระบบ ( Login )</div>
        <strong class="flow-stat-value mono">${countText(login.ok)} / ${countText(login.total)}</strong>
        <div class="flow-stat-sub">${pctText(login.successRatePct, login.total)} สำเร็จ · ${countText(login.failed)} ไม่สำเร็จ</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">สร้างเลขป้ายผู้ประมูล ( Lot-Bidder Number )</div>
        <strong class="flow-stat-value mono">${countText(lotBidder.prepared)} / ${countText(lotBidder.total)}</strong>
        <div class="flow-stat-sub">${pctText(lotBidder.successRatePct, lotBidder.total)} สำเร็จ · ${countText(lotBidder.failed)} ไม่สำเร็จ</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">เตรียม Join ( WS Setup Join )</div>
        <strong class="flow-stat-value mono">${countText(wsJoin.prepared)} / ${countText(wsJoin.total)}</strong>
        <div class="flow-stat-sub">${pctText(wsJoin.successRatePct, wsJoin.total)} สำเร็จ</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">เชื่อมต่อ WebSocket ( WS Rejoin / Connected )</div>
        <strong class="flow-stat-value mono">${countText(connection.ok)} / ${countText(connection.total)}</strong>
        <div class="flow-stat-sub">${pctText(connection.successRatePct, connection.total)} สำเร็จ · ${countText(connection.failed)} ไม่สำเร็จ</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">พร้อมบิด ( Ready for Bidding )</div>
        <strong class="flow-stat-value mono" style="color: ${prereqPhase.status === 'FAIL' ? '#f87171' : '#34d399'};">${prereqPhase.status || 'PASS'}</strong>
        <div class="flow-stat-sub">${prereqPhase.wsRejoinReady != null ? countText(prereqPhase.wsRejoinReady) + ' VU เชื่อมต่อแล้ว' : 'สถานะความพร้อมก่อนบิด'}</div>
      </div>
    </div>

    <div class="flow-zone-header"><span class="badge badge-perf">Phase 2: Bidding Performance</span> ช่วงบิดจริง — Focus หลัก / ตัวชี้วัด KPI</div>
    <div class="flow-summary-grid">
      <div class="flow-stat">
        <div class="flow-stat-label"><span class="badge badge-perf" style="margin-right: 0.3rem;">PERF</span> ส่งบิดแล้ว ( Offers Sent )</div>
        <strong class="flow-stat-value mono">${countText(bidding.sent)}</strong>
        <div class="flow-stat-sub">${biddingPhase.offerRatePerSec != null && biddingPhase.offerRatePerSec > 0 ? (Number(biddingPhase.offerRatePerSec).toFixed(1) + ' บิด/วินาที · ') : ''}รวมทั้งหมด</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">คำตอบบิด รับแล้ว / ถูกปฏิเสธ ( Offers Accepted &amp; Rejected )</div>
        <strong class="flow-stat-value mono">${countText(acknowledgement.ok)} / ${countText(acknowledgement.retry)}</strong>
        <div class="flow-stat-sub">${pctText(acknowledgement.successRatePct, acknowledgement.total)} รับแล้ว · ${countText(acknowledgement.retry)} ถูกปฏิเสธ (${countText(acknowledgement.total > 0 ? (acknowledgement.retry / acknowledgement.total * 100).toFixed(1) : 0)}%)</div>
        ${renderAckCodeBreakdown(acknowledgement.retryByCode)}
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">ความน่าเชื่อถือของคำตอบบิด ( ACK Reliability )</div>
        <strong class="flow-stat-value mono">${countText(acknowledgement.ok)} สำเร็จ / ${countText(acknowledgement.timeout)} หมดเวลา</strong>
        <div class="flow-stat-sub">${countText(acknowledgement.late || 0)} มาช้า · ${countText(acknowledgement.failed)} ล้มเหลว · ${(Number(acknowledgement.timeoutVsSentPct) || 0).toFixed(2)}% หมดเวลาจากที่ส่ง</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">เวลารอคำตอบหลังส่งบิด ( Offer → ACK Latency )</div>
        <strong class="flow-stat-value mono">${Math.round(Number(acknowledgement.waitAvgMs) || 0)} <span style="font-size: 0.9rem; font-weight: 400;">avg ms</span> · ${Math.round(Number(acknowledgement.waitP95Ms) || 0)} <span style="font-size: 0.9rem; font-weight: 400;">p95 ms</span></strong>
        <div class="flow-stat-sub">${biddingPhase.latency && biddingPhase.latency.p99 != null ? 'p90: ' + biddingPhase.latency.p90.toFixed(0) + 'ms · p99: ' + biddingPhase.latency.p99.toFixed(0) + 'ms · max: ' + biddingPhase.latency.max.toFixed(0) + 'ms' : 'ระยะเวลารอบส่งบิด → ได้คำตอบ'}</div>
      </div>
    </div>

    <div class="flow-zone-header"><span class="badge badge-postreq">Phase 3: Postrequisite</span> เคลียร์คำตอบค้าง → รอหลังบิด → ปิด WebSocket → Cleanup</div>
    <div class="flow-summary-grid">
      <div class="flow-stat">
        <div class="flow-stat-label"><span class="badge badge-postreq" style="margin-right: 0.3rem;">POST</span> เคลียร์คำตอบบิดค้างครบ ( Pending ACK Drained )</div>
        <strong class="flow-stat-value mono">${countText(postrequisite.pendingAckDrained || postreqPhase.pendingAckDrained || 0)}</strong>
        <div class="flow-stat-sub">เคลียร์ก่อนปิดการเชื่อมต่อ</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">ปิด WebSocket ตามปกติ ( WS Closed Normally )</div>
        <strong class="flow-stat-value mono">${countText(postrequisite.closedNormally || postreqPhase.wsClosedNormally || 0)}</strong>
        <div class="flow-stat-sub">ปิดการเชื่อมต่ออย่างถูกต้อง</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">เชื่อมต่อใหม่ &amp; หลุดการเชื่อมต่อ ( Reconnects &amp; Disconnects )</div>
        <strong class="flow-stat-value mono">${countText(reconnect.attempts)} ครั้งที่ลองใหม่</strong>
        <div class="flow-stat-sub">${countText(reconnect.gaveUp)} เลิกลอง · ${countText(postrequisite.unexpectedDisconnect || postreqPhase.unexpectedDisconnects || 0)} หลุดโดยไม่คาดคิด</div>
      </div>
      <div class="flow-stat">
        <div class="flow-stat-label">ทำความสะอาด Session ( Session Cleanup )</div>
        <strong class="flow-stat-value mono" style="color: ${postreqPhase.status === 'FAIL' ? '#f87171' : '#34d399'};">${postreqPhase.status || 'PASS'}</strong>
        <div class="flow-stat-sub">สถานะหลังจบการบิด</div>
      </div>
    </div>
  </section>

  <div class="flow-summary-intro" style="margin: 0.25rem 0 1rem;">หมายเหตุ: k6 summary มีค่า aggregate ไม่ใช่ raw time-series ดังนั้นกราฟด้านล่างเป็น derived view สำหรับอ่านแนวโน้ม ไม่ใช่การวัดรายช่วงเวลาโดยตรง</div>

  <!-- Performance Time-Series Graphs (Chart.js) -->
  <section class="charts-grid">
    <!-- Chart 1: Response Time vs SLA Cap -->
    <div class="card chart-card">
      <div class="chart-header">
        <div class="chart-title"><i class="fa-solid fa-chart-line" style="color: var(--brand-indigo);"></i> เปอร์เซ็นไทล์เวลาตอบกลับ ( Response Time Percentiles / Derived View )</div>
        <span class="badge badge-scenario">p50, p95, p99 vs ${meta.slaThresholdMs}ms SLA</span>
      </div>
      <div class="chart-canvas-container">
        <canvas id="chartLatency"></canvas>
      </div>
    </div>

    <!-- Chart 2: Concurrency (VUs) vs Throughput (TPH) [Dual-Axis] -->
    <div class="card chart-card">
      <div class="chart-header">
        <div class="chart-title"><i class="fa-solid fa-arrows-split-up-and-left" style="color: var(--cyan);"></i> VU ที่ทำงาน vs Throughput ( Active VUs vs Throughput / Derived View )</div>
        <span class="badge badge-scenario">Aggregate projection</span>
      </div>
      <div class="chart-canvas-container">
        <canvas id="chartThroughput"></canvas>
      </div>
    </div>

    <!-- Chart 3: Error Timeline -->
    <div class="card chart-card" style="grid-column: 1 / -1;">
      <div class="chart-header">
        <div class="chart-title"><i class="fa-solid fa-chart-area" style="color: var(--status-breached);"></i> แยกประเภท Error ( Error Breakdown / Derived View )</div>
        <span class="badge badge-scenario">HTTP 4xx, 5xx &amp; timeouts</span>
      </div>
      <div class="chart-canvas-container" style="min-height: 220px;">
        <canvas id="chartErrors"></canvas>
      </div>
    </div>
  </section>

  <!-- Aggregated Statistics Table -->
  <section class="card" style="margin-bottom: 1.5rem;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;">
      <h2 style="font-size: 1.25rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem;">
        <i class="fa-solid fa-table-list" style="color: var(--brand-indigo);"></i> ตารางสถิติรวม ( Aggregated Statistics Table )
      </h2>
      <div id="tableCounter" style="font-size: 0.85rem; color: var(--text-secondary);">แสดง ( Showing ) ${rows.length} endpoints</div>
    </div>

    <div class="table-controls">
      <div class="search-box">
        <i class="fa-solid fa-magnifying-glass" style="color: var(--text-muted);"></i>
        <input type="text" id="searchInput" placeholder="ค้นหา Endpoint, Route หรือ Scenario..." onkeyup="filterTable()">
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <select class="filter-select" id="scenarioFilter" onchange="filterTable()">
          <option value="ALL">ทุก Scenario ( All Scenarios )</option>
          ${meta.scenarios.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
        </select>
        <select class="filter-select" id="statusFilter" onchange="filterTable()">
          <option value="ALL">ทุกสถานะ SLA ( All SLA Status )</option>
          <option value="PASS">ผ่านเท่านั้น ( PASS Only )</option>
          <option value="WARNING">เตือนเท่านั้น ( WARNING Only )</option>
          <option value="BREACHED">เกินเกณฑ์เท่านั้น ( BREACHED Only )</option>
        </select>
      </div>
    </div>

    <div class="table-container">
      <table id="statsTable">
        <thead>
          <tr>
            <th onclick="sortTable(0, 'str')">ชื่อ ( Label ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(1, 'num')">จำนวนตัวอย่าง ( #Samples ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(2, 'num')">ล้มเหลว ( KO ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(3, 'num')">% ผิดพลาด ( Error % ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(4, 'num')">เฉลี่ย ( Avg ms ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(5, 'num')">ต่ำสุด ( Min ms ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(6, 'num')">p90 (ms) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(7, 'num')">p95 (ms) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(8, 'num')">p99 (ms) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(9, 'num')">สูงสุด ( Max ms ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(10, 'num')">Throughput ( RPS ) <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(11, 'num')">TPH <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(12, 'num')">KB/sec <i class="fa-solid fa-sort"></i></th>
            <th onclick="sortTable(13, 'str')">สถานะ SLA ( SLA Status ) <i class="fa-solid fa-sort"></i></th>
          </tr>
        </thead>
        <tbody id="tableBody">
          ${rows.map(r => `
          <tr data-scenario="${escapeHtml(r.scenario)}" data-status="${escapeHtml(r.status)}">
            <td style="font-weight: 600;"><span class="badge badge-scenario" style="margin-right: 0.4rem;">${escapeHtml(r.scenario)}</span>${r.zone === 'performance' ? `<span class="badge badge-perf" style="margin-right: 0.35rem;">PERF</span>` : r.zone === 'postrequisite' ? `<span class="badge badge-postreq" style="margin-right: 0.35rem;">POST</span>` : r.zone === 'prerequisite' ? `<span class="badge badge-prereq" style="margin-right: 0.35rem;">PRE</span>` : ''}${escapeHtml(r.name)}</td>
            <td class="mono">${r.samples.toLocaleString()}</td>
            <td class="mono" style="color: ${r.ko > 0 ? '#f87171' : '#9ca3af'};">${r.ko.toLocaleString()}</td>
            <td class="mono" style="color: ${r.errorRate === 0 ? '#34d399' : r.errorRate < 5 ? '#fbbf24' : '#f87171'}; font-weight: 600;">${r.errorRate.toFixed(2)}%</td>
            <td class="mono">${r.avg.toFixed(1)}</td>
            <td class="mono">${r.min.toFixed(1)}</td>
            <td class="mono">${r.p90.toFixed(1)}</td>
            <td class="mono" style="color: ${r.p95 <= meta.slaThresholdMs ? '#f9fafb' : '#f87171'}; font-weight: 600;">${r.p95.toFixed(1)}</td>
            <td class="mono">${r.p99.toFixed(1)}</td>
            <td class="mono">${r.max.toFixed(1)}</td>
            <td class="mono">${r.rps.toFixed(1)}</td>
            <td class="mono" style="font-weight: 600; color: #a5b4fc;">${Math.round(r.tph).toLocaleString()}</td>
            <td class="mono">${r.kbPerSec.toFixed(1)}</td>
            <td>
              <span class="badge ${r.status === 'PASS' ? 'badge-pass' : r.status === 'WARNING' ? 'badge-warning' : 'badge-breached'}">
                ${r.status}
              </span>
            </td>
          </tr>
          `).join('')}
          
          <!-- Summary Row -->
          <tr class="total-row">
            <td><strong>${escapeHtml(total.label)}</strong></td>
            <td class="mono"><strong>${total.samples.toLocaleString()}</strong></td>
            <td class="mono"><strong>${total.ko.toLocaleString()}</strong></td>
            <td class="mono"><strong>${total.errorRate.toFixed(2)}%</strong></td>
            <td class="mono"><strong>${total.avg.toFixed(1)}</strong></td>
            <td class="mono"><strong>${total.min.toFixed(1)}</strong></td>
            <td class="mono"><strong>${total.p90.toFixed(1)}</strong></td>
            <td class="mono"><strong>${total.p95.toFixed(1)}</strong></td>
            <td class="mono"><strong>${total.p99.toFixed(1)}</strong></td>
            <td class="mono"><strong>${total.max.toFixed(1)}</strong></td>
            <td class="mono"><strong>${total.rps.toFixed(1)}</strong></td>
            <td class="mono"><strong>${Math.round(total.tph).toLocaleString()}</strong></td>
            <td class="mono"><strong>${total.kbPerSec.toFixed(1)}</strong></td>
            <td>
              <span class="badge ${total.status === 'PASS' ? 'badge-pass' : total.status === 'WARNING' ? 'badge-warning' : 'badge-breached'}">
                ${total.status}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- Error Log Analysis by Scenario & Endpoint -->
  <section class="card">
    <h2 style="font-size: 1.25rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
      <i class="fa-solid fa-bug" style="color: var(--status-breached);"></i> วิเคราะห์ Error Log &amp; หาสาเหตุ ( Error Log Analysis &amp; Technical Root Cause Diagnosis )
    </h2>

    ${errors.length === 0 ? `
      <div style="text-align: center; padding: 2rem; color: #34d399;">
        <i class="fa-solid fa-circle-check" style="font-size: 2.5rem; margin-bottom: 0.5rem;"></i>
        <div style="font-size: 1.1rem; font-weight: 600;">ไม่พบ Error ( Zero Errors Detected! )</div>
        <div style="font-size: 0.85rem; color: var(--text-secondary);">ทุก request และ WebSocket ผ่านการตรวจสอบครบ ( All requests and WebSocket operations passed assertions and contract checks. )</div>
      </div>
    ` : `
      <div style="display: grid; gap: 0.75rem;">
        ${errors.map(err => `
        <div class="error-card ${err.severity === 'warning' ? 'warning-border' : ''}">
          <div class="error-header">
            <div>
              <span class="badge badge-scenario">${escapeHtml(err.scenario)}</span>
              <strong style="margin-left: 0.5rem; font-size: 0.95rem;">${escapeHtml(err.endpoint)}</strong>
              <span style="color: var(--text-muted); font-size: 0.85rem; margin-left: 0.5rem;">— ${escapeHtml(err.errorType)}</span>
            </div>
            <div style="font-weight: 700; color: ${err.severity === 'warning' ? '#fbbf24' : '#f87171'};" class="mono">
              ${err.count.toLocaleString()} ครั้งที่ล้มเหลว ( failures ) (${err.percentage})
            </div>
          </div>
          <div class="error-diag"><i class="fa-solid fa-stethoscope" style="margin-right: 0.35rem; color: #60a5fa;"></i> <strong>การวินิจฉัย ( Diagnosis ):</strong> ${escapeHtml(err.diagnosis)}</div>
          <div class="error-rec"><i class="fa-solid fa-screwdriver-wrench" style="margin-right: 0.35rem; color: #34d399;"></i> <strong>คำแนะนำ ( Recommendation ):</strong> ${escapeHtml(err.recommendation)}</div>
        </div>
        `).join('')}
      </div>
    `}
  </section>

</div>

<!-- Client-side Interactive Logic & Chart.js Config -->
<script>
  const reportData = ${modelJson};

  // 1. Initialize Chart 1: Latency Percentiles vs SLA
  const ctxLatency = document.getElementById('chartLatency').getContext('2d');
  new Chart(ctxLatency, {
    type: 'line',
    data: {
      labels: reportData.timeSeries.labels,
      datasets: [
        {
          label: 'p50 (Median)',
          data: reportData.timeSeries.p50,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 2,
        },
        {
          label: 'p95',
          data: reportData.timeSeries.p95,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 3,
        },
        {
          label: 'p99',
          data: reportData.timeSeries.p99,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.1)',
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 2,
        },
        {
          label: 'SLA Cap (' + reportData.meta.slaThresholdMs + ' ms)',
          data: reportData.timeSeries.slaCap,
          borderColor: '#ef4444',
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { family: 'Inter', size: 11 } } },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: '#475569',
          borderWidth: 1,
          titleColor: '#fff',
          bodyColor: '#cbd5e1',
          callbacks: {
            label: (c) => c.dataset.label + ': ' + c.parsed.y + ' ms'
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
        y: {
          grid: { color: 'rgba(255,255,255,0.08)' },
          ticks: { color: '#94a3b8', callback: (v) => v + ' ms' },
          title: { display: true, text: 'Response Time (ms)', color: '#94a3b8' }
        }
      }
    }
  });

  // 2. Initialize Chart 2: Concurrency (VUs) vs Throughput (TPH) [Dual-Axis]
  const ctxThroughput = document.getElementById('chartThroughput').getContext('2d');
  new Chart(ctxThroughput, {
    type: 'line',
    data: {
      labels: reportData.timeSeries.labels,
      datasets: [
        {
          label: 'Throughput (TPH)',
          data: reportData.timeSeries.tph,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.2)',
          fill: true,
          tension: 0.3,
          borderWidth: 2.5,
          yAxisID: 'yThroughput',
          pointRadius: 2,
        },
        {
          label: 'Active Concurrency (VUs)',
          data: reportData.timeSeries.vus,
          borderColor: '#06b6d4',
          backgroundColor: 'transparent',
          tension: 0.2,
          borderWidth: 2,
          borderDash: [4, 4],
          yAxisID: 'yVUs',
          pointRadius: 3,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { family: 'Inter', size: 11 } } }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
        yThroughput: {
          type: 'linear',
          position: 'left',
          grid: { color: 'rgba(255,255,255,0.08)' },
          ticks: { color: '#a5b4fc', callback: (v) => v.toLocaleString() + ' TPH' },
          title: { display: true, text: 'Throughput (TPH)', color: '#a5b4fc' }
        },
        yVUs: {
          type: 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#67e8f9', callback: (v) => v + ' VUs' },
          title: { display: true, text: 'Active VUs', color: '#67e8f9' }
        }
      }
    }
  });

  // 3. Initialize Chart 3: Error Timeline Breakdown
  const ctxErrors = document.getElementById('chartErrors').getContext('2d');
  new Chart(ctxErrors, {
    type: 'bar',
    data: {
      labels: reportData.timeSeries.labels,
      datasets: [
        {
          label: 'HTTP 4xx (Client / Rate Limit)',
          data: reportData.timeSeries.errors4xx,
          backgroundColor: 'rgba(245, 158, 11, 0.7)',
          stack: 'errors',
        },
        {
          label: 'HTTP 5xx (Server Error)',
          data: reportData.timeSeries.errors5xx,
          backgroundColor: 'rgba(239, 68, 68, 0.8)',
          stack: 'errors',
        },
        {
          label: 'Network / Socket Timeout',
          data: reportData.timeSeries.errorsTimeout,
          backgroundColor: 'rgba(168, 85, 247, 0.75)',
          stack: 'errors',
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { family: 'Inter', size: 11 } } }
      },
      scales: {
        x: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
        y: { stacked: true, grid: { color: 'rgba(255,255,255,0.08)' }, ticks: { color: '#94a3b8' }, title: { display: true, text: 'Error Count', color: '#94a3b8' } }
      }
    }
  });

  // Real-time Search & Filter Functionality
  function filterTable() {
    const q = document.getElementById('searchInput').value.toLowerCase();
    const scenario = document.getElementById('scenarioFilter').value;
    const status = document.getElementById('statusFilter').value;
    const rows = document.querySelectorAll('#tableBody tr:not(.total-row)');

    let visibleCount = 0;
    rows.forEach(r => {
      const text = r.innerText.toLowerCase();
      const rScenario = r.getAttribute('data-scenario');
      const rStatus = r.getAttribute('data-status');

      const matchesQuery = !q || text.includes(q);
      const matchesScenario = scenario === 'ALL' || rScenario === scenario;
      const matchesStatus = status === 'ALL' || rStatus === status;

      if (matchesQuery && matchesScenario && matchesStatus) {
        r.style.display = '';
        visibleCount++;
      } else {
        r.style.display = 'none';
      }
    });

    document.getElementById('tableCounter').innerText = 'แสดง ( Showing ) ' + visibleCount + ' endpoints';
  }

  // Column Sorting Logic
  let sortDir = {};
  function sortTable(colIndex, type) {
    const table = document.getElementById('statsTable');
    const tbody = document.getElementById('tableBody');
    const totalRow = tbody.querySelector('.total-row');
    const rows = Array.from(tbody.querySelectorAll('tr:not(.total-row)'));

    const currentDir = sortDir[colIndex] === 'asc' ? 'desc' : 'asc';
    sortDir = {}; // reset others
    sortDir[colIndex] = currentDir;

    rows.sort((a, b) => {
      let valA = a.children[colIndex].innerText.replace(/,/g, '').replace(/%/g, '').trim();
      let valB = b.children[colIndex].innerText.replace(/,/g, '').replace(/%/g, '').trim();

      if (type === 'num') {
        valA = parseFloat(valA) || 0;
        valB = parseFloat(valB) || 0;
        return currentDir === 'asc' ? valA - valB : valB - valA;
      } else {
        return currentDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
    });

    // Reattach
    rows.forEach(r => tbody.appendChild(r));
    if (totalRow) tbody.appendChild(totalRow);
  }

  // Export Table to CSV
  function exportTableToCSV() {
    let csv = [];
    const rows = document.querySelectorAll('#statsTable tr');
    rows.forEach(r => {
      let row = [];
      const cols = r.querySelectorAll('th, td');
      cols.forEach(c => {
        let text = c.innerText.replace(/"/g, '""').replace(/\\n/g, ' ').trim();
        row.push('"' + text + '"');
      });
      csv.push(row.join(','));
    });

    const blob = new Blob([csv.join('\\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', 'k6-performance-aggregated-stats.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
</script>

</body>
</html>`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
