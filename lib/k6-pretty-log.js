/**
 * Shared pretty console logger สำหรับ k6 scripts
 *
 * เป้าหมาย: log ใน terminal อ่านง่าย มีสี มีไอคอน แยก level ชัดเจน
 *  - ปิดสี/ไอคอน: PLAIN_LOG=true หรือ NO_COLOR=true (เหมาะกับ --console-output=file หรือ CI)
 *  - level ของ logInfo สรุปจากชื่อ action อัตโนมัติ:
 *      *.ok / *.done / ws.open                              → ✔ เขียว
 *      *.fail / *.error / *.timeout / *.abort / *.gave_up   → ✖ แดง (console.error)
 *      *.retry / *.warn / *.skip                            → ⚠ เหลือง
 *      อื่น ๆ                                                → ℹ ฟ้า
 *  - ไอคอน emoji ผูกกับ prefix ของ action (login → 🔑, ws.hold → 🕒, ...)
 *  - เลี่ยง emoji ในกล่อง/ตาราง (alignment) — ใช้เฉพาะ box-drawing chars ที่กว้าง 1 ช่องแน่นอน
 *
 * ใช้:
 *   import {
 *     logInfo, logWarn, logError,
 *     logSetup, logSetupDivider, logSetupRule, logBanner, boxTable,
 *     vuContext, isPlainMode, maybeIcon,
 *     visLen, padEndVis, padStartVis, truncateVis, stripAnsi,
 *   } from '../../lib/k6-pretty-log.js';
 */

// ---------------------------------------------------------------- env / mode

function envOf() {
  if (typeof __ENV !== 'undefined' && __ENV) return __ENV;
  if (typeof globalThis !== 'undefined' && globalThis.__ENV) return globalThis.__ENV;
  return {};
}

/** โหมด plain (ไม่มีสี/ไอคอน) — เปิดด้วย PLAIN_LOG=true หรือ NO_COLOR=true */
export function isPlainMode() {
  const env = envOf();
  const names = ['PLAIN_LOG', 'NO_COLOR'];
  for (let i = 0; i < names.length; i++) {
    const raw = env[names[i]];
    if (raw == null || raw === '') continue;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
  }
  return false;
}

/** palette สี ANSI (คืนชุดว่างถ้า plain mode) */
export function palette() {
  if (isPlainMode()) {
    return {
      reset: '', bold: '', dim: '',
      red: '', green: '', yellow: '',
      blue: '', magenta: '', cyan: '', gray: '',
    };
  }
  return {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
  };
}

/** คืน icon เฉพาะโหมดสี (plain mode คืน '') */
export function maybeIcon(emoji) {
  return isPlainMode() ? '' : String(emoji || '');
}

// ---------------------------------------------------------------- width utils

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

/** ความกว้างที่มองเห็นจริง (ตัด ANSI + นับ emoji astral = 2 ช่อง) */
export function visLen(s) {
  const clean = stripAnsi(s);
  let w = 0;
  for (const ch of clean) {
    w += ch.codePointAt(0) > 0xffff ? 2 : 1;
  }
  return w;
}

export function padEndVis(s, n) {
  const str = String(s == null ? '' : s);
  const v = visLen(str);
  return v >= n ? str : str + ' '.repeat(n - v);
}

export function padStartVis(s, n) {
  const str = String(s == null ? '' : s);
  const v = visLen(str);
  return v >= n ? str : ' '.repeat(n - v) + str;
}

/** ตัดความยาวตามความกว้างที่มองเห็น + ใส่ … ท้าย (ใช้กับข้อความ plain ไม่มี ANSI) */
export function truncateVis(s, n) {
  const str = String(s == null ? '' : s);
  if (visLen(str) <= n) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = ch.codePointAt(0) > 0xffff ? 2 : 1;
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// ---------------------------------------------------------------- vu context

export function vuContext() {
  return {
    vu: typeof __VU !== 'undefined' ? __VU : 'setup',
    iter: typeof __ITER !== 'undefined' ? __ITER : '-',
  };
}

export function vuTag() {
  const { vu, iter } = vuContext();
  return `[vu=${vu} it=${iter}]`;
}

// ---------------------------------------------------------------- icons / levels

const ICON_RULES = [
  ['login', '🔑'],
  ['lot-bidder', '🎫'],
  ['batch', '📦'],
  ['pickBuyer', '👤'],
  ['iteration', '🎬'],
  ['vu.complete', '🏁'],
  ['setup.use_prepared', '🧩'],
  ['ws.join', '🚪'],
  ['ws.connected', '🤝'],
  ['ws.connect', '🔌'],
  ['ws.open', '🟢'],
  ['ws.visitLot', '👀'],
  ['ws.ping', '🏓'],
  ['ws.pong', '🏓'],
  ['ws.message', '💬'],
  ['ws.bidding', '🔨'],
  ['ws.ack.ok', '🎯'],
  ['ws.ack', '📨'],
  ['ws.hold', '🕒'],
  ['ws.reconnect', '🔁'],
  ['ws.close', '👋'],
  ['ws.socket', '💥'],
  ['ws.session', '🏁'],
  ['ws.', '📡'],
];

/** icon ตาม action prefix (plain mode คืน '') */
export function iconFor(action) {
  if (isPlainMode()) return '';
  const a = String(action || '');
  for (let i = 0; i < ICON_RULES.length; i++) {
    if (a.indexOf(ICON_RULES[i][0]) === 0) return ICON_RULES[i][1] + ' ';
  }
  return '';
}

function inferLevel(action) {
  const a = String(action || '');
  if (/(\.ok|\.done|^ws\.open)$/.test(a)) return 'ok';
  if (/\.(fail|error|timeout|abort|gave_up)$/.test(a)) return 'err';
  if (/\.(retry|warn|skip)$/.test(a)) return 'warn';
  return 'info';
}

const LEVELS = {
  info: { sym: 'ℹ', color: 'cyan', plain: 'INFO', write: console.log },
  ok: { sym: '✔', color: 'green', plain: 'INFO', write: console.log },
  warn: { sym: '⚠', color: 'yellow', plain: 'WARN', write: console.warn },
  err: { sym: '✖', color: 'red', plain: 'ERROR', write: console.error },
};

function emit(levelKey, action, detail) {
  const level = LEVELS[levelKey];
  const c = palette();
  const act = String(action || '');
  const text = detail == null || detail === '' ? '' : String(detail);

  if (isPlainMode()) {
    const extra = text ? ` | ${text}` : '';
    level.write.call(console, `[${level.plain}]${vuTag()} ${act}${extra}`);
    return;
  }

  const lvl = c[level.color] + level.sym + c.reset;
  const tag = c.gray + vuTag() + c.reset;
  const actStyled = c.bold + act + c.reset;
  const sep = text ? ` ${c.gray}·${c.reset} ` : '';
  level.write.call(console, `${lvl} ${tag} ${iconFor(act)}${actStyled}${sep}${text}`);
}

/** log ทั่วไป — level สรุปจากชื่อ action (.ok → ✔, .fail → ✖, .retry → ⚠) */
export function logInfo(action, detail) {
  emit(inferLevel(action), action, detail);
}

/** log บังคับ level ok (✔ เขียว) */
export function logOk(action, detail) {
  emit('ok', action, detail);
}

/** log บังคับ level warn (⚠ เหลือง, console.warn) */
export function logWarn(action, detail) {
  emit('warn', action, detail);
}

/** log บังคับ level error (✖ แดง, console.error) */
export function logError(action, detail) {
  emit('err', action, detail);
}

// ---------------------------------------------------------------- setup logs

const SETUP_PREFIX = '[SETUP]';
const SETUP_LOG_WIDTH = 72;

function setupPrefixStyled(c) {
  return isPlainMode() ? SETUP_PREFIX : c.magenta + SETUP_PREFIX + c.reset;
}

/** divider เส้นคู่ ═ พร้อม title กึ่งกลาง (icon เป็นตัวเลือก เช่น '📦') */
export function logSetupDivider(title, icon) {
  const c = palette();
  const ic = icon ? maybeIcon(icon) + ' ' : '';
  const label = ` ${ic}${title == null ? '' : title} `;
  if (isPlainMode()) {
    const pad = Math.max(0, SETUP_LOG_WIDTH - label.length);
    const left = Math.floor(pad / 2);
    console.log(`${SETUP_PREFIX} ${'═'.repeat(left)}${label}${'═'.repeat(pad - left)}`);
    return;
  }
  const pad = Math.max(0, SETUP_LOG_WIDTH - visLen(label));
  const left = Math.floor(pad / 2);
  const labelStyled = c.bold + label + c.reset;
  console.log(
    `${setupPrefixStyled(c)} ${c.cyan}${'═'.repeat(left)}${c.reset}${labelStyled}${c.cyan}${'═'.repeat(pad - left)}${c.reset}`
  );
}

/** เส้นคั่นบาง ─ */
export function logSetupRule() {
  const c = palette();
  const bar = isPlainMode()
    ? '─'.repeat(SETUP_LOG_WIDTH)
    : c.gray + '─'.repeat(SETUP_LOG_WIDTH) + c.reset;
  console.log(`${setupPrefixStyled(c)} ${bar}`);
}

/**
 * log ฝั่ง setup — meta: { round, phase, attempt, maxAttempts, status }
 * status: OK → ✔ เขียว / FAIL → ✖ แดง / RETRY|PARTIAL → ↻ เหลือง / อื่น ๆ → •
 */
export function logSetup(action, detail, meta) {
  const c = palette();
  const m = meta || {};
  const round = m.round != null ? String(m.round) : '';
  const phase = m.phase != null ? String(m.phase) : '';
  const attempt =
    m.attempt != null && m.maxAttempts != null ? `attempt ${m.attempt}/${m.maxAttempts}` : '';
  const status = m.status != null ? String(m.status) : '';

  if (isPlainMode()) {
    const tags = [];
    if (round) tags.push(round);
    if (phase) tags.push(phase);
    if (attempt) tags.push(attempt);
    if (status) tags.push(status);
    const tagStr = tags.length ? `[${tags.join('][')}] ` : '';
    const extra = detail ? ` | ${detail}` : '';
    console.log(`${SETUP_PREFIX} ${tagStr}${action}${extra}`);
    return;
  }

  const chips = [];
  if (round) chips.push(c.gray + `[${round}]` + c.reset);
  if (phase) chips.push(c.magenta + `[${phase}]` + c.reset);
  if (attempt) chips.push(c.gray + `[${attempt}]` + c.reset);

  let statusStr = '';
  if (status) {
    let sym = '•';
    let color = 'gray';
    if (status === 'OK') { sym = '✔'; color = 'green'; }
    else if (status === 'FAIL') { sym = '✖'; color = 'red'; }
    else if (status === 'RETRY' || status === 'PARTIAL') { sym = '↻'; color = 'yellow'; }
    statusStr = ' ' + c[color] + sym + ' ' + status + c.reset;
  }

  const chipStr = chips.length ? chips.join(' ') + ' ' : '';
  const sep = detail ? ` ${c.gray}·${c.reset} ` : '';
  console.log(
    `${setupPrefixStyled(c)} ${chipStr}${c.bold}${action}${c.reset}${sep}${detail == null ? '' : detail}${statusStr}`
  );
}

/**
 * กล่อง banner (เช่น config ตอน setup เริ่ม) — ใช้เฉพาะตัวอักษรกว้าง 1 ช่องในกล่อง
 * @param {string} title
 * @param {Array<[string, string]>} rows  [label, value]
 */
export function logBanner(title, rows) {
  const c = palette();
  const W = 62;
  const write = function (s) {
    console.log(SETUP_PREFIX + ' ' + s);
  };
  const wrap = function (colorKey, s) {
    return colorKey && c[colorKey] ? c[colorKey] + s + c.reset : s;
  };
  const lineFor = function (txt) {
    return wrap('cyan', '║') + ' ' + padEndVis(txt, W - 2) + ' ' + wrap('cyan', '║');
  };
  const top = wrap('cyan', '╔' + '═'.repeat(W) + '╗');
  const mid = wrap('cyan', '╟' + '─'.repeat(W) + '╢');
  const bot = wrap('cyan', '╚' + '═'.repeat(W) + '╝');

  write(top);
  write(lineFor(wrap('bold', title)));
  if (Array.isArray(rows) && rows.length) {
    write(mid);
    for (let i = 0; i < rows.length; i++) {
      const label = rows[i][0];
      const value = rows[i][1];
      write(lineFor(wrap('blue', padEndVis(label, 8)) + String(value == null ? '' : value)));
    }
  }
  write(bot);
}

/**
 * ตาราง box-drawing สำหรับพิมพ์ใน stdout (เช่น สรุป VU complete)
 * @param {string} title
 * @param {{label: string, width: number, align?: 'left'|'right'}[]} headers
 * @param {Array<Array<{text: string, color?: string, align?: 'left'|'right'}>>} rows
 * @returns {string}
 */
export function boxTable(title, headers, rows) {
  const c = palette();
  const widths = headers.map(function (h) { return h.width; });
  const total = widths.reduce(function (a, b) { return a + b + 2; }, 0) + (headers.length - 1) + 2;

  const wrap = function (colorKey, s) {
    return colorKey && c[colorKey] ? c[colorKey] + s + c.reset : s;
  };
  const border = function (ch) { return wrap('gray', ch); };

  const bodyLine = function (cells) {
    const parts = [];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const cell = (cells && cells[i]) || {};
      const text = String(cell.text == null ? '' : cell.text);
      const align = cell.align || h.align;
      const padded = align === 'right' ? padStartVis(text, h.width) : padEndVis(text, h.width);
      parts.push(' ' + wrap(cell.color, padded) + ' ');
    }
    return border('│') + parts.join(border('│')) + border('│');
  };
  const hr = function (left, mid, right) {
    const parts = [];
    for (let i = 0; i < headers.length; i++) parts.push('─'.repeat(widths[i] + 2));
    return border(left + parts.join(mid) + right);
  };

  const lines = [];
  const titleText = title ? ` ${title} ` : '';
  const titlePad = Math.max(0, total - 2 - visLen(titleText));
  const leftDash = Math.floor(titlePad / 2);
  lines.push(
    border('┌') +
      border('─'.repeat(leftDash)) +
      wrap('cyan', titleText) +
      border('─'.repeat(titlePad - leftDash)) +
      border('┐')
  );
  lines.push(bodyLine(headers.map(function (h) { return { text: h.label, color: 'bold' }; })));
  lines.push(hr('├', '┼', '┤'));
  if (Array.isArray(rows)) {
    for (let r = 0; r < rows.length; r++) lines.push(bodyLine(rows[r]));
  }
  lines.push(hr('└', '┴', '┘'));
  return lines.join('\n');
}



