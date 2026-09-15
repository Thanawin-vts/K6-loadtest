/**
 * Shared k6 JSON + HTML report helpers
 *
 * Env:
 *   REPORT_DIR=k6-reports
 *   REPORT_BASENAME=<name>
 *   REPORT_TITLE=<title base>
 *   REPORT_JSON / REPORT_HTML  — optional full path override
 *
 * Output default:
 *   {REPORT_DIR}/yyyyMMdd/HH-mm-ss/{REPORT_BASENAME}.json|html
 * Title:
 *   {REPORT_TITLE} — yyyy/MM/dd HH:mm:ss
 */

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/3.0.4/dist/bundle.js';
import { generateEnterpriseHtmlReport } from './enterprise-html-report.js';

export function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** yyyy/MM/dd HH:mm:ss */
export function formatReportTitleStamp(now) {
  const d = now || new Date();
  return (
    d.getFullYear() +
    '/' +
    pad2(d.getMonth() + 1) +
    '/' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds())
  );
}

/**
 * โครงสร้างโฟลเดอร์รายงาน: yyyyMMdd/HH-mm-ss
 * @param {Date} [now]
 * @param {{ reportDir?: string, reportBasename?: string }} [options]
 */
export function buildReportPaths(now, options) {
  const opts = options || {};
  const reportDir = opts.reportDir || __ENV.REPORT_DIR || 'k6-reports';
  const reportBasename = opts.reportBasename || __ENV.REPORT_BASENAME || 'k6-summary';
  const d = now || new Date();
  const yyyyMMdd = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  const HHmmss = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());

  return {
    dir: reportDir,
    date: yyyyMMdd,
    time: HHmmss,
    json: __ENV.REPORT_JSON || reportDir + '/' + reportBasename + '.json',
    html: __ENV.REPORT_HTML || reportDir + '/' + reportBasename + '.html',
  };
}

function metricBaseName(name) {
  const s = String(name || '');
  const i = s.indexOf('{');
  return i >= 0 ? s.slice(0, i) : s;
}

function metricAllowed(name, allowExact, prefixes) {
  const base = metricBaseName(name);
  if (allowExact[name] || allowExact[base]) return true;
  for (let i = 0; i < prefixes.length; i++) {
    if (base.indexOf(prefixes[i]) === 0) return true;
  }
  return false;
}

function filterRootGroupForReport(group, opts) {
  if (!group) {
    return {
      name: '',
      path: '',
      id: 'd41d8cd98f00b204e9800998ecf8427e',
      groups: [],
      checks: [],
    };
  }
  const checkNameRe = opts.checkNameRe || null;
  const dropVuComplete = opts.dropVuComplete !== false;
  const checks = [];
  const rawChecks = group.checks || [];
  for (let i = 0; i < rawChecks.length; i++) {
    const c = rawChecks[i];
    const name = c && c.name ? String(c.name) : '';
    if (dropVuComplete && name.indexOf('__vu_complete__') === 0) continue;
    if (checkNameRe && !checkNameRe.test(name)) continue;
    checks.push(c);
  }
  return {
    name: group.name || '',
    path: group.path || '',
    id: group.id || 'd41d8cd98f00b204e9800998ecf8427e',
    groups: [],
    checks: checks,
  };
}

function metricValues(data, name) {
  const metric = data && data.metrics && data.metrics[name];
  return (metric && metric.values) || {};
}

function metricBaseCount(data, baseName) {
  const metrics = (data && data.metrics) || {};
  const keys = Object.keys(metrics);
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    if (metricBaseName(keys[i]) !== baseName) continue;
    const values = (metrics[keys[i]] && metrics[keys[i]].values) || {};
    if (values.count != null) total += Number(values.count) || 0;
  }
  return total;
}

function metricBaseValues(data, baseName) {
  const metrics = (data && data.metrics) || {};
  const keys = Object.keys(metrics);
  const merged = {};
  for (let i = 0; i < keys.length; i++) {
    if (metricBaseName(keys[i]) !== baseName) continue;
    const values = (metrics[keys[i]] && metrics[keys[i]].values) || {};
    const valueKeys = Object.keys(values);
    for (let j = 0; j < valueKeys.length; j++) {
      const key = valueKeys[j];
      if (key === 'passes' || key === 'fails' || key === 'count') {
        merged[key] = (merged[key] || 0) + (Number(values[key]) || 0);
      } else if (merged[key] == null && values[key] != null) {
        merged[key] = values[key];
      }
    }
  }
  return merged;
}

function percentage(part, total) {
  if (!total) return 0;
  return (part / total) * 100;
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return (
    pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds)
  );
}

function formatCount(value) {
  return String(Math.round(Number(value) || 0));
}

function formatPercent(value) {
  return (Number(value) || 0).toFixed(2) + '%';
}

function thresholdSummary(data) {
  let evaluated = 0;
  let failed = 0;

  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.ok === 'boolean') {
      evaluated += 1;
      if (!value.ok) failed += 1;
    }
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === 'ok') continue;
      visit(value[keys[i]]);
    }
  }

  const topLevel = data && data.thresholds;
  if (topLevel && Object.keys(topLevel).length > 0) {
    visit(topLevel);
  } else {
    const metrics = (data && data.metrics) || {};
    const metricKeys = Object.keys(metrics);
    for (let i = 0; i < metricKeys.length; i++) {
      visit(metrics[metricKeys[i]] && metrics[metricKeys[i]].thresholds);
    }
  }
  return {
    evaluated: evaluated,
    passed: evaluated - failed,
    failed: failed,
    status: failed > 0 ? 'FAIL' : evaluated > 0 ? 'PASS' : 'NOT_EVALUATED',
  };
}

function collectCustomCounterCounts(data) {
  const metrics = (data && data.metrics) || {};
  const standard = {
    checks: true,
    data_received: true,
    data_sent: true,
    http_reqs: true,
    http_req_failed: true,
    iterations: true,
    vus: true,
    vus_max: true,
  };
  const bases = {};
  const keys = Object.keys(metrics);
  for (let i = 0; i < keys.length; i++) {
    const base = metricBaseName(keys[i]);
    const metric = metrics[keys[i]];
    if (standard[base] || !metric || metric.type !== 'counter') continue;
    bases[base] = true;
  }

  const result = {};
  const names = Object.keys(bases);
  for (let i = 0; i < names.length; i++) {
    result[names[i]] = metricBaseCount(data, names[i]);
  }
  return result;
}

function collectTrendSummaries(data) {
  const result = {};
  const preferredNames = [
    'login_duration',
    'login_duration_ms',
    'lot_bidder_number_duration',
    'lot_bidder_number_duration_ms',
    'ws_connect_duration',
    'ws_connect_duration_ms',
    'ws_session_duration',
    'ws_session_duration_ms',
    'ws_join_prepare_duration_ms',
    'ws_ack_wait_ms',
  ];

  for (let i = 0; i < preferredNames.length; i++) {
    const name = preferredNames[i];
    const values = metricValues(data, name);
    if (values.count == null) continue;
    result[name] = {
      count: Number(values.count) || 0,
      avg: Number(values.avg) || 0,
      min: Number(values.min) || 0,
      med: Number(values.med != null ? values.med : values['p(50)']) || 0,
      p90: Number(values['p(90)']) || 0,
      p95: Number(values['p(95)']) || 0,
      p99: Number(values['p(99)']) || 0,
      max: Number(values.max) || 0,
    };
  }
  return result;
}

/**
 * นับ metric แบบมี tag เช่น ws_ack_retry{code=E5002} -> { E5002: 15000, ... }
 * (k6 แยก metric key เป็น base{tag=value} เมื่อ Counter.add ส่ง tags)
 */
function metricBaseTagCounts(data, baseName, tagName) {
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

/**
 * สร้าง summary แบบอ่านเร็ว โดยคง raw k6 summary ไว้ในฟิลด์ summary เดิม
 */
export function buildReadableReportSummary(data, meta) {
  const runMeta = meta || {};
  const httpRequests = metricBaseCount(data, 'http_reqs');
  const httpFailedValues = metricBaseValues(data, 'http_req_failed');
  const httpFailed =
    httpFailedValues.passes != null
      ? httpFailedValues.passes
      : Math.round((Number(httpFailedValues.rate) || 0) * httpRequests);
  const httpPassed =
    httpFailedValues.fails != null
      ? httpFailedValues.fails
      : Math.max(0, httpRequests - httpFailed);
  const checkValues = metricBaseValues(data, 'checks');
  const checkPassed = Number(checkValues.passes) || 0;
  const checkFailed = Number(checkValues.fails) || 0;
  const checkTotal = checkPassed + checkFailed;
  const iterations = metricBaseCount(data, 'iterations');
  const vusValues = metricValues(data, 'vus');
  const vusMaxValues = metricValues(data, 'vus_max');
  const configuredVus =
    runMeta.vus != null ? Number(runMeta.vus) || 0 : Number(vusMaxValues.value) || 0;
  const peakVus =
    Number(vusValues.max != null ? vusValues.max : vusValues.value) ||
    Number(vusMaxValues.value) ||
    configuredVus;

  const loginOk = metricBaseCount(data, 'login_ok');
  const loginFail = metricBaseCount(data, 'login_fail');
  const loginTotal = loginOk + loginFail;
  const visitLotSent = metricBaseCount(data, 'visit_lot_ok');
  const connectedOk = metricBaseCount(data, 'connected_ok');
  const connectedFail = metricBaseCount(data, 'connected_fail');
  const connectedTotal = connectedOk + connectedFail;
  const lotBidderPrepared = metricBaseCount(data, 'lot_bidder_prepare_ok');
  const lotBidderPrepareFail = metricBaseCount(data, 'lot_bidder_prepare_fail');
  const lotBidderTotal = lotBidderPrepared + lotBidderPrepareFail;
  const wsJoinPrepared = metricBaseCount(data, 'ws_join_prepare_ok');
  const wsJoinPrepareFail = metricBaseCount(data, 'ws_join_prepare_fail');
  const wsJoinTotal = wsJoinPrepared + wsJoinPrepareFail;
  const biddingSent = metricBaseCount(data, 'ws_bidding_sent');
  const ackOk = metricBaseCount(data, 'ws_ack_ok');
  const ackLate = metricBaseCount(data, 'ws_ack_late');
  const ackFail = metricBaseCount(data, 'ws_ack_fail');
  const ackTimeout = metricBaseCount(data, 'ws_ack_timeout');
  const ackRetry = metricBaseCount(data, 'ws_ack_retry');
  const ackTotal = ackOk + ackFail + ackTimeout;
  // % timeout เทียบจำนวน bid ที่ส่ง — ต่ำ (<10%) มักเป็น client SLA ตั้งต่ำไป, สูง (>=10%) มักเป็น server คอขวดจริง
  const ackTimeoutVsSentPct = percentage(ackTimeout, biddingSent);
  // ระยะเวลารอ ACK (ws_ack_wait_ms): avg/p95 — ใช้ตัดสินว่า timeout เป็น false timeout หรือ server ช้าจริง
  const ackWaitValues = metricBaseValues(data, 'ws_ack_wait_ms');
  const ackWaitAvgMs = Number(ackWaitValues.avg) || 0;
  const ackWaitP95Ms = Number(ackWaitValues['p(95)'] != null ? ackWaitValues['p(95)'] : ackWaitValues.med) || 0;
  const wsClosedNormally = metricBaseCount(data, 'ws_closed_normally');
  const wsPendingAckDrained = metricBaseCount(data, 'ws_pending_ack_drained');
  const wsUnexpectedDisconnect = metricBaseCount(data, 'ws_unexpected_disconnect');
  const reconnects = metricBaseCount(data, 'ws_reconnect');
  const reconnectGaveUp = metricBaseCount(data, 'ws_reconnect_gave_up');

  const customCounters = collectCustomCounterCounts(data);
  const thresholds = thresholdSummary(data);

  // 1. Prerequisite Readiness
  const prereqFailures = loginFail + connectedFail + lotBidderPrepareFail + wsJoinPrepareFail;
  const prereqPass = prereqFailures === 0;
  const prereqStatus = prereqPass ? 'PASS' : 'FAIL';

  // 2. Bidding Performance
  const perfFailures = ackFail + ackTimeout + reconnectGaveUp;
  const testDurationMs = Number(data && data.state && data.state.testRunDurationMs) || 0;
  const testDurationSec = Math.max(0.001, testDurationMs / 1000);
  const biddingDurationMs = runMeta.biddingDurationMs ? Number(runMeta.biddingDurationMs) : 0;
  const biddingDurationSec = biddingDurationMs > 0 ? (biddingDurationMs / 1000) : testDurationSec;
  const postBidHoldMs = runMeta.postBidHoldMs ? Number(runMeta.postBidHoldMs) : 0;
  const offerRatePerSec = (biddingSent / biddingDurationSec);

  const biddingSuccessRate = percentage(ackOk, biddingSent || ackTotal);
  const biddingTimeoutRate = percentage(ackTimeout, biddingSent || ackTotal);
  const biddingRetryRate = percentage(ackRetry, biddingSent || ackTotal);
  const biddingPass = thresholds.failed === 0 && ackFail === 0 && (biddingSent > 0 ? (biddingTimeoutRate < 10) : true);
  const biddingStatus = biddingPass ? 'PASS' : 'FAIL';

  // 3. Postrequisite Stability
  const postreqFailures = reconnectGaveUp + wsUnexpectedDisconnect;
  const postreqPass = postreqFailures === 0;
  const postreqStatus = postreqPass ? 'PASS' : 'FAIL';

  const flowFailureCount = prereqFailures + perfFailures + postreqFailures;
  const hasActivity = iterations > 0 || httpRequests > 0 || Object.keys(customCounters).length > 0;
  const overallResult = (!prereqPass ? 'FAIL (prereq failed)' : (!biddingPass ? 'FAIL' : hasActivity ? 'PASS' : 'NO_DATA'));

  const trends = collectTrendSummaries(data);
  const ackWaitTrend = trends['ws_ack_wait_ms'] || {};

  return {
    version: 2,
    result: overallResult,
    prerequisiteStatus: prereqStatus,
    biddingStatus: biddingStatus,
    postrequisiteStatus: postreqStatus,
    prerequisiteHasFailures: !prereqPass,
    perfZoneStartsAt: 'bid_offer',
    durationMs: testDurationMs,
    duration: formatDurationMs(testDurationMs),
    biddingDurationMs: biddingDurationMs,
    biddingDuration: biddingDurationMs > 0 ? formatDurationMs(biddingDurationMs) : null,
    postBidHoldMs: postBidHoldMs,
    postBidHold: postBidHoldMs > 0 ? formatDurationMs(postBidHoldMs) : null,
    counts: {
      plannedBuyers: runMeta.buyerCount != null ? Number(runMeta.buyerCount) || 0 : null,
      configuredVus: configuredVus,
      peakVus: peakVus,
      iterations: iterations,
      httpRequests: httpRequests,
      httpPassed: httpPassed,
      httpFailed: httpFailed,
      httpErrorRatePct: percentage(httpFailed, httpRequests),
      checks: checkTotal,
      checksPassed: checkPassed,
      checksFailed: checkFailed,
      checkPassRatePct: percentage(checkPassed, checkTotal),
      flowFailures: flowFailureCount,
      prerequisiteFailures: prereqFailures,
      performanceFailures: perfFailures,
      postrequisiteFailures: postreqFailures,
      completed:
        runMeta.vuResultCount != null
          ? Number(runMeta.vuResultCount) || 0
          : runMeta.vuCompleteCount != null
            ? Number(runMeta.vuCompleteCount) || 0
            : null,
      completedOk:
        runMeta.vuResultPassCount != null
          ? Number(runMeta.vuResultPassCount) || 0
          : runMeta.vuCompleteOkCount != null
            ? Number(runMeta.vuCompleteOkCount) || 0
            : null,
      completedError:
        runMeta.vuResultFailCount != null
          ? Number(runMeta.vuResultFailCount) || 0
          : runMeta.vuCompleteErrorCount != null
            ? Number(runMeta.vuCompleteErrorCount) || 0
            : null,
    },
    phases: {
      prerequisite: {
        status: prereqStatus,
        buyersRequested: runMeta.buyerCount != null ? Number(runMeta.buyerCount) : configuredVus,
        loginReady: loginOk,
        loginTotal: loginTotal,
        loginSuccessRatePct: percentage(loginOk, loginTotal),
        lotBidderReady: lotBidderPrepared,
        lotBidderTotal: lotBidderTotal,
        lotBidderSuccessRatePct: percentage(lotBidderPrepared, lotBidderTotal),
        wsSetupJoinReady: wsJoinPrepared,
        wsSetupJoinTotal: wsJoinTotal,
        wsSetupJoinSuccessRatePct: percentage(wsJoinPrepared, wsJoinTotal),
        wsRejoinReady: connectedOk,
        wsRejoinTotal: connectedTotal,
        wsRejoinSuccessRatePct: percentage(connectedOk, connectedTotal),
      },
      bidding: {
        status: biddingStatus,
        offersSent: biddingSent,
        offersAccepted: ackOk,
        offersRejected: ackRetry,
        ackSuccess: ackOk,
        ackLate: ackLate,
        ackTimeout: ackTimeout,
        ackRetry: ackRetry,
        ackFail: ackFail,
        latency: {
          avg: Number(ackWaitTrend.avg) || ackWaitAvgMs,
          min: Number(ackWaitTrend.min) || 0,
          med: Number(ackWaitTrend.med) || 0,
          p90: Number(ackWaitTrend.p90) || 0,
          p95: Number(ackWaitTrend.p95) || ackWaitP95Ms,
          p99: Number(ackWaitTrend.p99) || 0,
          max: Number(ackWaitTrend.max) || 0,
        },
        successRatePct: biddingSuccessRate,
        timeoutRatePct: biddingTimeoutRate,
        retryRatePct: biddingRetryRate,
        offerRatePerSec: offerRatePerSec,
        retryByCode: metricBaseTagCounts(data, 'ws_ack_retry', 'code'),
      },
      postrequisite: {
        status: postreqStatus,
        pendingAckDrained: wsPendingAckDrained,
        wsClosedNormally: wsClosedNormally,
        reconnectAttempts: reconnects,
        reconnectsGaveUp: reconnectGaveUp,
        unexpectedDisconnects: wsUnexpectedDisconnect,
        sessionCleanup: postreqPass ? 'PASS' : 'FAIL',
      },
    },
    flow: {
      login: {
        zone: 'prerequisite',
        label: 'เข้าสู่ระบบ ( Login )',
        ok: loginOk,
        failed: loginFail,
        total: loginTotal,
        successRatePct: percentage(loginOk, loginTotal),
      },
      lotBidder: {
        zone: 'prerequisite',
        label: 'สร้างเลขป้ายผู้ประมูล ( Lot-Bidder Number )',
        prepared: lotBidderPrepared,
        failed: lotBidderPrepareFail,
        total: lotBidderTotal,
        successRatePct: percentage(lotBidderPrepared, lotBidderTotal),
      },
      wsVisitLot: { zone: 'prerequisite', label: 'เข้า Lot ( WS VisitLot )', sent: visitLotSent },
      visitLot: { zone: 'prerequisite', sent: visitLotSent },
      connection: {
        zone: 'prerequisite',
        label: 'เชื่อมต่อ WebSocket ( WS Connected )',
        ok: connectedOk,
        failed: connectedFail,
        total: connectedTotal,
        successRatePct: percentage(connectedOk, connectedTotal),
      },
      wsJoin: {
        zone: 'prerequisite',
        label: 'เตรียม Join ( WS Join Prepare )',
        prepared: wsJoinPrepared,
        failed: wsJoinPrepareFail,
        total: wsJoinTotal,
        successRatePct: percentage(wsJoinPrepared, wsJoinTotal),
      },
      bidding: { zone: 'performance', label: 'ส่งบิด ( Bidding Send )', sent: biddingSent },
      acknowledgement: {
        zone: 'performance',
        label: 'คำตอบบิด ( Bidding ACK )',
        ok: ackOk,
        failed: ackFail,
        late: ackLate,
        timeout: ackTimeout,
        retry: ackRetry,
        total: ackTotal,
        successRatePct: percentage(ackOk, ackTotal),
        timeoutVsSentPct: ackTimeoutVsSentPct,
        waitAvgMs: ackWaitAvgMs,
        waitP95Ms: ackWaitP95Ms,
        retryByCode: metricBaseTagCounts(data, 'ws_ack_retry', 'code'),
      },
      reconnect: { zone: 'performance', label: 'เชื่อมต่อ WebSocket ใหม่ ( WS Reconnect )', attempts: reconnects, gaveUp: reconnectGaveUp },
      postrequisite: {
        zone: 'postrequisite',
        label: 'หลังจบการบิด ( Postrequisite )',
        pendingAckDrained: wsPendingAckDrained,
        wsClosedNormally: wsClosedNormally,
        unexpectedDisconnect: wsUnexpectedDisconnect,
      },
    },
    customCounters: customCounters,
    trends: trends,
    thresholds: thresholds,
  };
}

/** แสดงผลสรุปใน terminal ให้เห็น count สำคัญโดยไม่ต้องเปิด JSON */
export function formatReadableReportSummary(summary) {
  const s = summary || {};
  const counts = s.counts || {};
  const phases = s.phases || {};
  const prereq = phases.prerequisite || {};
  const b = phases.bidding || {};
  const post = phases.postrequisite || {};
  const lat = b.latency || {};

  const retryByCode = b.retryByCode || {};
  const retryCodeKeys = Object.keys(retryByCode).sort(function (x, y) {
    return retryByCode[y] - retryByCode[x];
  });
  const retryCodeStr = retryCodeKeys.length
    ? ' (' + retryCodeKeys.map(function (c) { return c + '=' + formatCount(retryByCode[c]); }).join(', ') + ')'
    : '';

  const durationStr = s.duration || '00:00:00';
  const timingBreakdown = s.biddingDuration ? ` (Bidding: ${s.biddingDuration} | Post-Hold: ${s.postBidHold || '-'})` : '';

  const buyersRequested = prereq.buyersRequested != null ? formatCount(prereq.buyersRequested) : formatCount(counts.plannedBuyers || counts.configuredVus);
  const loginStr = prereq.loginTotal ? `${formatCount(prereq.loginReady)}/${formatCount(prereq.loginTotal)} (${formatPercent(prereq.loginSuccessRatePct)})` : 'not recorded';
  const lotBidderStr = prereq.lotBidderTotal ? `${formatCount(prereq.lotBidderReady)}/${formatCount(prereq.lotBidderTotal)} (${formatPercent(prereq.lotBidderSuccessRatePct)})` : 'not recorded';
  const wsSetupJoinStr = prereq.wsSetupJoinTotal ? `${formatCount(prereq.wsSetupJoinReady)}/${formatCount(prereq.wsSetupJoinTotal)} (${formatPercent(prereq.wsSetupJoinSuccessRatePct)})` : 'not recorded';
  const wsRejoinStr = prereq.wsRejoinTotal ? `${formatCount(prereq.wsRejoinReady)}/${formatCount(prereq.wsRejoinTotal)} (${formatPercent(prereq.wsRejoinSuccessRatePct)})` : 'not recorded';

  const pendingDrainedStr = post.pendingAckDrained ? `${formatCount(post.pendingAckDrained)} PASS` : (post.status || 'PASS');
  const wsClosedStr = post.wsClosedNormally ? `${formatCount(post.wsClosedNormally)} PASS` : (post.status || 'PASS');

  const lines = [
    '',
    '============================================================',
    ' สรุปผล Load Test การบิด ( 3-PHASE FLOW )',
    '============================================================',
    'ผลลัพธ์               : ' + (s.result || 'NO_DATA'),
    'ระยะเวลา              : ' + durationStr + timingBreakdown,
    'Buyer / VU            : ' + formatCount(counts.plannedBuyers) + ' buyers / ' + formatCount(counts.configuredVus) + ' configured / ' + formatCount(counts.peakVus) + ' peak',
    '',
    '1. ช่วงบิดจริง ( BIDDING PERFORMANCE )',
    '────────────────────────────────────────────────────────────',
    'ส่งบิดแล้ว ( Offers Sent )            : ' + formatCount(b.offersSent),
    'คำตอบบิดรับแล้ว ( Offers Accepted )   : ' + formatCount(b.offersAccepted) + ' (' + formatPercent(b.successRatePct) + ')',
    'คำตอบบิดถูกปฏิเสธ ( Offers Rejected ) : ' + formatCount(b.offersRejected) + ' (' + formatPercent(b.retryRatePct) + ')' + retryCodeStr,
    'คำตอบบิดสำเร็จ ( ACK Success )        : ' + formatCount(b.ackSuccess),
    'คำตอบบิดมาช้า ( ACK Late )            : ' + formatCount(b.ackLate),
    'รอคำตอบบิดหมดเวลา ( ACK Timeout )     : ' + formatCount(b.ackTimeout) + ' (' + formatPercent(b.timeoutRatePct) + ')',
    'ลองส่งบิดใหม่ ( ACK Retry )           : ' + formatCount(b.ackRetry),
    'คำตอบบิดล้มเหลว ( ACK Fail )          : ' + formatCount(b.ackFail),
    '',
    'เวลารอคำตอบหลังส่งบิด ( Offer → ACK Latency / ws_ack_wait_ms ):',
    '  avg                  : ' + (lat.avg != null ? lat.avg.toFixed(1) : '0.0') + ' ms',
    '  p90                  : ' + (lat.p90 != null ? lat.p90.toFixed(1) : '0.0') + ' ms',
    '  p95                  : ' + (lat.p95 != null ? lat.p95.toFixed(1) : '0.0') + ' ms',
    '  p99                  : ' + (lat.p99 != null ? lat.p99.toFixed(1) : '0.0') + ' ms',
    '  max                  : ' + (lat.max != null ? lat.max.toFixed(1) : '0.0') + ' ms',
    '',
    'อัตรา ( Rates ):',
    '  อัตราสำเร็จ ( Success Rate )         : ' + formatPercent(b.successRatePct),
    '  อัตราหมดเวลา ( Timeout Rate )        : ' + formatPercent(b.timeoutRatePct),
    '  อัตราลองใหม่ ( Retry Rate )          : ' + formatPercent(b.retryRatePct),
    '  อัตราส่งบิด/วินาที ( Offer Rate/sec ) : ' + (b.offerRatePerSec != null ? b.offerRatePerSec.toFixed(2) : '0.00') + ' บิด/วินาที',
    '',
    '2. ช่วงเตรียมความพร้อม ( PREREQUISITE )',
    '────────────────────────────────────────────────────────────',
    'จำนวน Buyer ที่ขอ ( Buyers requested ) : ' + buyersRequested,
    'เข้าสู่ระบบพร้อม ( Login ready )       : ' + loginStr,
    'สร้างเลขป้ายผู้ประมูลพร้อม ( Lot-Bidder ready ): ' + lotBidderStr,
    'เตรียม Join พร้อม ( WS Setup Join ready ): ' + wsSetupJoinStr,
    'เชื่อมต่อ WS พร้อม ( WS Rejoin ready ) : ' + wsRejoinStr,
    '',
    'พร้อมบิด ( Ready for bidding )         : ' + (prereq.status || 'PASS'),
    '',
    '3. ช่วงหลังจบการบิด ( POSTREQUISITE )',
    '────────────────────────────────────────────────────────────',
    'เคลียร์คำตอบบิดค้าง ( Pending ACK drained ): ' + pendingDrainedStr,
    'ปิด WebSocket ตามปกติ ( WS closed normally ): ' + wsClosedStr,
    'เชื่อมต่อใหม่ ( Reconnects )           : ' + formatCount(post.reconnectAttempts) + ' ครั้ง | ' + formatCount(post.reconnectsGaveUp) + ' เลิกลอง',
    'หลุดโดยไม่คาดคิด ( Unexpected disconnects ): ' + formatCount(post.unexpectedDisconnects),
    'ทำความสะอาด Session ( Session cleanup ): ' + (post.sessionCleanup || 'PASS'),
    '',
    'ผลรวม ( OVERALL RESULT ): ' + (s.result || 'NO_DATA') + ' (เตรียม: ' + (prereq.status || 'PASS') + ' | บิด: ' + (b.status || 'PASS') + ' | หลังบิด: ' + (post.status || 'PASS') + ')',
    '============================================================',
    '',
  ];
  return lines.join('\n');
}

/**
 * กรอง k6 summary ให้เหลือเฉพาะ metrics ที่ต้องการ (ใช้กับ JSON report)
 */
export function filterSummaryData(data, options) {
  const opts = options || {};
  const metricNames = opts.metricNames || [];
  const metricPrefixes = opts.metricPrefixes || [];
  const allowExact = {};
  for (let i = 0; i < metricNames.length; i++) {
    allowExact[metricNames[i]] = true;
  }
  if (opts.keepContextMetrics !== false) {
    allowExact.vus = true;
    allowExact.vus_max = true;
    allowExact.iterations = true;
  }

  const srcMetrics = (data && data.metrics) || {};
  const filteredMetrics = {};
  const keys = Object.keys(srcMetrics);
  for (let k = 0; k < keys.length; k++) {
    const name = keys[k];
    if (metricAllowed(name, allowExact, metricPrefixes)) {
      filteredMetrics[name] = srcMetrics[name];
    }
  }

  const srcThresholds = (data && data.thresholds) || {};
  const filteredThresholds = {};
  const tKeys = Object.keys(srcThresholds);
  for (let t = 0; t < tKeys.length; t++) {
    const tName = tKeys[t];
    if (metricAllowed(tName, allowExact, metricPrefixes)) {
      filteredThresholds[tName] = srcThresholds[tName];
    }
  }

  return Object.assign({}, data || {}, {
    metrics: filteredMetrics,
    thresholds: filteredThresholds,
    root_group: filterRootGroupForReport(data && data.root_group, opts),
  });
}

/** allowlist สำหรับ phase bidding ของ buyer bidding scripts (labels ตรงกับ FLOW_STEP_LABELS ฝั่งสคริปต์) */
export const BIDDING_REPORT_METRICS = [
  // auth: Login
  'login_ok',
  'login_fail',
  'login_duration',
  'login_duration_ms',
  // lot-bidder: Lot-Bidder Number
  'lot_bidder_number_duration',
  'lot_bidder_number_duration_ms',
  'lot_bidder_prepare_ok',
  'lot_bidder_prepare_fail',
  // ws-join: VisitLot + Connected + Join Prepare
  'visit_lot_ok',
  'connected_ok',
  'connected_fail',
  'ws_connect_duration',
  'ws_connect_duration_ms',
  'ws_join_prepare_ok',
  'ws_join_prepare_fail',
  'ws_join_prepare_duration_ms',
  // bidding: Bidding Send + session hold
  'ws_session_duration',
  'ws_session_duration_ms',
  'ws_bidding_sent',
  // ack: Bidding ACK (ok/late/fail/timeout/retry + ระยะเวลารอ ACK round-trip)
  'ws_ack_ok',
  'ws_ack_late',
  'ws_ack_fail',
  'ws_ack_retry',
  'ws_ack_timeout',
  'ws_ack_wait_ms',
  // net: ping/pong + reconnect
  'ws_ping_received',
  'ws_pong_sent',
  'ws_reconnect',
  'ws_reconnect_gave_up',
  // postrequisite: graceful close & drain
  'ws_closed_normally',
  'ws_pending_ack_drained',
  'ws_unexpected_disconnect',
  // Keep k6 built-ins so filtered JSON still contains the denominator for counts.
  'http_req_duration',
  'http_req_failed',
  'http_reqs',
  'data_received',
  'data_sent',
  'checks',
  'iterations',
  'vus',
  'vus_max',
];

/**
 * benc-uk/k6-reporter 3.0.4 อ่าน metrics เหล่านี้แบบ hardcode ใน EJS
 * ถ้ากรองออกจะได้: Cannot read property 'values' of undefined (data_received)
 */
const HTML_REPORTER_REQUIRED_METRICS = [
  'data_received',
  'data_sent',
  'http_reqs',
  'http_req_failed',
  'checks',
  'iterations',
  'vus',
  'grpc_reqs',
];

function stubHtmlMetric(name) {
  if (name === 'http_req_failed' || name === 'checks') {
    return { type: 'rate', contains: 'rate', values: { rate: 0, passes: 0, fails: 0 } };
  }
  if (name === 'vus') {
    return { type: 'gauge', contains: 'default', values: { value: 0, min: 0, max: 0 } };
  }
  return {
    type: 'counter',
    contains: name.indexOf('data_') === 0 ? 'data' : 'default',
    values: { count: 0, rate: 0 },
  };
}

/** เติม metrics ที่ HTML template ต้องการ — ไม่กระทบ JSON ที่กรองแล้ว */
export function ensureHtmlReporterMetrics(reportData, sourceData) {
  const srcMetrics = (sourceData && sourceData.metrics) || {};
  const metrics = {};
  const reportMetrics = (reportData && reportData.metrics) || {};
  const reportKeys = Object.keys(reportMetrics);
  for (let i = 0; i < reportKeys.length; i++) {
    metrics[reportKeys[i]] = reportMetrics[reportKeys[i]];
  }
  for (let j = 0; j < HTML_REPORTER_REQUIRED_METRICS.length; j++) {
    const name = HTML_REPORTER_REQUIRED_METRICS[j];
    if (metrics[name] && metrics[name].values) continue;
    if (srcMetrics[name] && srcMetrics[name].values) {
      metrics[name] = srcMetrics[name];
    } else {
      metrics[name] = stubHtmlMetric(name);
    }
  }
  return Object.assign({}, reportData || {}, { metrics: metrics });
}

function buildHtmlReportSafe(reportData, sourceData, title, options) {
  const htmlOptions = options || {};
  const enterpriseData = Object.assign({}, sourceData || {}, {
    reportSummary: htmlOptions.reportSummary,
  });

  // 1) ใช้ Modern Single-File Enterprise Dashboard เป็นค่าเริ่มต้น
  if (__ENV.LEGACY_REPORTER !== 'true') {
    try {
      return generateEnterpriseHtmlReport(enterpriseData, {
        title: title,
        slaThresholdMs: htmlOptions.slaThresholdMs,
      });
    } catch (e0) {
      console.error('[REPORT] enterprise dashboard generator failed, fallback to legacy:', String(e0));
    }
  }

  // 2) Fallback ไปยัง legacy k6-reporter (ถ้าตั้ง env LEGACY_REPORTER=true หรือเกิดข้อผิดพลาด)
  try {
    return htmlReport(ensureHtmlReporterMetrics(reportData, sourceData), { title: title });
  } catch (e1) {
    console.error('[REPORT] html filtered failed, fallback to full summary:', String(e1));
  }
  try {
    return htmlReport(sourceData, { title: title });
  } catch (e2) {
    console.error('[REPORT] html full summary failed:', String(e2));
    return '<html><body><pre>HTML report failed: ' + String(e2) + '</pre></body></html>';
  }
}

/**
 * สร้าง handleSummary ที่ reuse ได้
 *
 * - JSON: ใช้ reportData ที่กรองแล้ว (metricNames / metricPrefixes)
 * - HTML: ใช้ enterprise dashboard จาก source data เต็ม เพื่อไม่ให้ denominator/count หาย
 */
export function createHandleSummary(configOrFactory) {
  return function handleSummary(data) {
    const cfg =
      typeof configOrFactory === 'function' ? configOrFactory(data) || {} : configOrFactory || {};

    const now = new Date();
    const titleBase = cfg.titleBase || __ENV.REPORT_TITLE || 'k6 report';
    const paths = buildReportPaths(now, {
      reportDir: cfg.reportDir,
      reportBasename: cfg.reportBasename,
    });
    const titleStamp = formatReportTitleStamp(now);
    const reportTitle = titleBase + ' — ' + titleStamp;

    let reportData = cfg.reportData || data;
    if (cfg.metricNames || cfg.metricPrefixes || cfg.checkNameRe) {
      reportData = filterSummaryData(reportData, {
        metricNames: cfg.metricNames,
        metricPrefixes: cfg.metricPrefixes,
        keepContextMetrics: cfg.keepContextMetrics,
        checkNameRe: cfg.checkNameRe,
        dropVuComplete: cfg.dropVuComplete,
      });
    }

    const meta = Object.assign(
      {
        generatedAt: now.toISOString(),
        reportDir: paths.dir,
        reportDate: paths.date,
        reportTime: paths.time,
        title: reportTitle,
        titleBase: titleBase,
        titleStamp: titleStamp,
      },
      cfg.meta || {}
    );

    const readableSummary = buildReadableReportSummary(data, meta);
    const reportPayload = {
      meta: meta,
      reportSummary: readableSummary,
      summary: reportData,
    };

    console.log('[REPORT] dir  → ' + paths.dir);
    console.log('[REPORT] JSON → ' + paths.json);
    console.log('[REPORT] HTML → ' + paths.html);
    console.log('[REPORT] title → ' + reportTitle);
    if (cfg.metricNames || cfg.metricPrefixes) {
      console.log(
        '[REPORT] scope → filtered metrics (' +
          Object.keys((reportData && reportData.metrics) || {}).length +
          ')'
      );
    }

    const extraFiles = cfg.extraFiles || {};
    const extraKeys = Object.keys(extraFiles);
    for (let i = 0; i < extraKeys.length; i++) {
      console.log('[REPORT] extra → ' + extraKeys[i]);
    }

    let stdout = formatReadableReportSummary(readableSummary);
    stdout += '\n' + textSummary(data, { indent: ' ', enableColors: true });
    if (cfg.extraStdout) {
      stdout = String(cfg.extraStdout) + stdout;
    }

    const result = {
      stdout: stdout,
      [paths.json]: JSON.stringify(reportPayload, null, 2),
      [paths.html]: buildHtmlReportSafe(reportData, data, reportTitle, {
        slaThresholdMs:
          cfg.slaThresholdMs ||
          (typeof __ENV.SLA_THRESHOLD_MS !== 'undefined' ? Number(__ENV.SLA_THRESHOLD_MS) : 2000),
        reportSummary: readableSummary,
      }),
    };
    for (let j = 0; j < extraKeys.length; j++) {
      result[extraKeys[j]] = extraFiles[extraKeys[j]];
    }
    return result;
  };
}
