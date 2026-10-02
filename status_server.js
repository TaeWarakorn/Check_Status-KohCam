/**
 * Desktop\statusprogram\status_server.js (ย้ายออกจาก Myproject 1 ต.ค. 2569) — หน้าสถานะระบบ KohKae (แบบ 1) · เพิ่ม 1 ต.ค. 2569
 *
 * แยกจากระบบสแกน (8000) และหน้าเว็บหลัก (5173) โดยสิ้นเชิง: อ่านอย่างเดียว ไม่สั่งอะไรระบบอื่น
 *   เปิดดู:   http://localhost:8090          (เครื่องอื่นในวงแลน: ตั้ง STATUS_HOST=0.0.0.0)
 *   ข้อมูล:   GET /api/status (JSON)   ·   GET /log (บรรทัดท้ายของ detection.log)
 * เช็คทุก 5 วิ: กล้อง+ส่วนสแกน (8000/api/health), ส่วนบันทึกข้อมูล (5000/api/plates),
 *               Oracle (SELECT ผ่าน database/db.js), พื้นที่ดิสก์ C:, สำรองข้อมูลรายคืน
 * ไม่ตอบ < 60 วิ = เหลือง (ตัวเฝ้ากำลังเปิดใหม่ให้) · ≥ 60 วิ = แดง
 */
const http = require("http");
const fs = require("fs");
const net = require("net");
const { execFile, spawn } = require("child_process");
const path = require("path");

// ── ค่าตั้งทั้งหมดอยู่ใน .env ข้างไฟล์นี้ (ตัวอย่าง: .env.example) · เพิ่ม 2 ต.ค. 2569 ──
// ค่าที่ตั้งไว้ในเครื่อง (environment เช่นจาก start-services.ps1) ชนะค่าในไฟล์ · ไม่มีไฟล์/ไม่มีบรรทัดนั้น = ใช้ค่าเริ่มต้นในโค้ด
const OWN_ENV_FILE = path.join(__dirname, ".env");
for (const [k, v] of Object.entries(readEnvFile(OWN_ENV_FILE))) if (process.env[k] === undefined && v !== "") process.env[k] = v;
const envStr = (k, d) => (process.env[k] ? process.env[k] : d);
const envNum = (k, d) => { const n = parseFloat(process.env[k]); return Number.isFinite(n) ? n : d; };

// โปรแกรมนี้อยู่นอกโปรเจกต์ (Desktop\statusprogram) ชี้ไปที่ Myproject ที่อยู่ข้างกัน — เปลี่ยนได้ด้วย MYPROJECT_DIR
const ROOT = envStr("MYPROJECT_DIR", path.resolve(__dirname, "..", "Myproject"));
const DB_DIR = path.join(ROOT, "database");
for (const p of [path.join(DB_DIR, ".env"), path.join(ROOT, "backend", ".env")])
  require(path.join(DB_DIR, "node_modules", "dotenv")).config({ path: p, quiet: true });
process.env.ORACLE_POOL_MIN = "0";
process.env.ORACLE_POOL_MAX = "2";
const db = require(path.join(DB_DIR, "db"));

const PORT = envNum("STATUS_PORT", 8090);
const HOST = envStr("STATUS_HOST", "127.0.0.1");
// ที่อยู่ของส่วนที่ไปเช็ค
const SVC_HOST = envStr("SERVICE_HOST", "127.0.0.1");
const SCAN_PORT = envNum("SCAN_PORT", 8000);
const API_PORT = envNum("API_PORT", 5000);
const ORACLE_PORT_LABEL = envStr("ORACLE_PORT_LABEL", "1521");   // ใช้แสดงบนการ์ดเท่านั้น (ที่อยู่จริงอยู่ใน Myproject\database\.env)
// รอบเช็ค (เร็วขึ้น 1 ต.ค. 2569 — เดิมทุก 5 วิ กว่าจะเห็นว่าล่ม ระบบก็กลับมาแล้ว)
const FAST_MS = envNum("CHECK_SCAN_MS", 1000);     // ส่วนสแกน + กล้อง (8000/api/health)
const API_MS = envNum("CHECK_API_MS", 2000);      // ส่วนบันทึกข้อมูล (5000)
const ORACLE_MS = envNum("CHECK_ORACLE_MS", 5000);   // Oracle (query จริง)
const SLOW_MS = envNum("CHECK_SLOW_MS", 30000);    // ดิสก์ + สำรองข้อมูล (เปลี่ยนช้า)
const GRACE_MS = envNum("DOWN_AFTER_SECONDS", 60) * 1000;   // ไม่ตอบนานเท่านี้ = แดง (และแจ้งอีเมล)
const DISK_WARN_GB = envNum("DISK_WARN_GB", 15);
const DISK_DOWN_GB = envNum("DISK_DOWN_GB", 5);
const BACKUP_MAX_AGE_DAYS = envNum("BACKUP_MAX_AGE_DAYS", 1);
const envBool = (k, d) => (process.env[k] ? /^(1|true|yes|on)$/i.test(process.env[k]) : d);
// กล้อง: เช็คตรงทางเครือข่าย (แค่เปิด TCP แล้วปิด ไม่แย่งสตรีม) — แทน checkprogram\monitor.py
const CAMERA_HOST = envStr("CAMERA_HOST", "");
const CAMERA_PORT = envNum("CAMERA_PORT", 554);
// คุณภาพภาพกล้อง (frame_check.py)
const IMAGE_CHECK = envBool("IMAGE_CHECK_ENABLED", true);
const IMAGE_SECONDS = envNum("IMAGE_CHECK_SECONDS", 10);
const IMAGE_DARK_MIN = envNum("IMAGE_DARK_MIN", 12);        // สว่างเฉลี่ยต่ำกว่านี้ = ภาพมืดสนิท
const IMAGE_BRIGHT_MAX = envNum("IMAGE_BRIGHT_MAX", 245);   // สูงกว่านี้ = ขาวจ้า
const IMAGE_FLAT_MIN = envNum("IMAGE_FLAT_MIN", 5);         // ความต่างสีต่ำกว่านี้ = สีเดียวทั้งจอ
const IMAGE_BLUR_MIN = envNum("IMAGE_BLUR_MIN", 300);       // ความคมต่ำกว่านี้ = เบลอ (ปกติกลางวัน ~4,700) · 0 = ไม่เช็ค
const IMAGE_FROZEN_SECONDS = envNum("IMAGE_FROZEN_SECONDS", 60);
const IMAGE_PYTHON = envStr("IMAGE_PYTHON", path.join(ROOT, "backend", ".venv_cuda", "Scripts", "python.exe"));
// ซ่อมตัวเอง
const HEAL = { camera: envBool("HEAL_CAMERA", true), oracle: envBool("HEAL_ORACLE", true), backup: envBool("HEAL_BACKUP", true), disk: envBool("HEAL_DISK", true) };
const HEAL_CAMERA_AFTER_MS = envNum("HEAL_CAMERA_AFTER_SECONDS", 60) * 1000;
const HEAL_ORACLE_AFTER_MS = envNum("HEAL_ORACLE_AFTER_SECONDS", 120) * 1000;
const HEAL_RETRY_MS = envNum("HEAL_RETRY_MINUTES", 5) * 60000;   // ลองซ้ำได้หลังกี่นาที
const HEAL_MAX_TRIES = envNum("HEAL_MAX_TRIES", 2);             // ต่อปัญหา 1 รอบ ลองได้กี่ครั้ง แล้วหยุดรอคน
const HEAL_BACKUP_HOUR = envNum("HEAL_BACKUP_HOUR", 6);
const ORACLE_RESTART_TASK = envStr("ORACLE_RESTART_TASK", "KohKae Restart Oracle");
const SCREENSHOT_DIR = envStr("SCREENSHOT_DIR", path.join(ROOT, "Screenshots"));
const IMAGE_ARCHIVE_DIR = envStr("IMAGE_ARCHIVE_DIR", "");
const IMAGE_ARCHIVE_DAYS = envNum("IMAGE_ARCHIVE_DAYS", 90);
const BACKUP_DIR = path.join(ROOT, "backups", "db");
const LOG_FILE = path.join(ROOT, "backend", "mainprogram", "detection.log");
const EVENTS_FILE = path.join(__dirname, "events.json");
const MAIN_UI_PORT = envNum("WEB_PORT", 5173);

// ── ตัวช่วย ────────────────────────────────────────────────────────────
const quiet = (fn) => async (...a) => { const l = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = l; } };
function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 500) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error("ตอบกลับไม่ใช่ JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("ไม่ตอบภายใน " + timeoutMs / 1000 + " วิ")));
    req.on("error", reject);
  });
}
const nowTh = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
const dayTh = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
const thDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."][m - 1]} ${y + 543}`; };
const fmtGB = (b) => (b / 1024 ** 3).toFixed(1) + " GB";

// ── ประวัติเหตุการณ์ (เก็บลงไฟล์ ล่าสุด 200 รายการ) ─────────────────────
let events = [];
try { events = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8")); } catch (_) { events = []; }
function addEvent(st, text) {
  events.unshift({ at: new Date().toISOString(), time: nowTh(), day: dayTh(), st, text });
  events = events.slice(0, 200);
  try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 1), "utf8"); } catch (_) {}
}

// ── สถานะแต่ละส่วน ─────────────────────────────────────────────────────
const NAMES = { camera: "กล้องทางเข้า", scan: "ส่วนสแกนป้าย", api: "ส่วนบันทึกข้อมูล", oracle: "ฐานข้อมูล Oracle", disk: "พื้นที่ดิสก์ C:", backup: "สำรองข้อมูล" };
const SUBS = { camera: "กล้อง RTSP", scan: "พอร์ต " + SCAN_PORT, api: "พอร์ต " + API_PORT, oracle: "พอร์ต " + ORACLE_PORT_LABEL, disk: "ไดรฟ์ระบบ", backup: "ทุกคืน" };
const failSince = {};
const heal = {};       // id → { tries, lastAt } ของปัญหารอบปัจจุบัน (หายแล้วล้าง)
const last = {};       // id → { st, detail }
const prevSt = {};

// ล้มเหลว: ยังไม่ถึง DOWN_AFTER_SECONDS = warn (เหลือง), เกิน = down (แดง)
// problem = อาการเป็นภาษาคน เช่น "ไม่ตอบ" "ภาพมืดสนิท" · hint ต่อท้ายเฉพาะตอนเหลือง
const fmtDur = (secs) => (secs < 60 ? `${secs} วิ` : `${Math.floor(secs / 60)} นาที ${secs % 60} วิ`);
const HINT = {
  scan: "รอระบบเปิดใหม่ให้เอง", api: "รอระบบเปิดใหม่ให้เอง",
  camera: HEAL.camera ? "ถ้าไม่หายจะลองเปิดส่วนสแกนใหม่เอง" : "",
  oracle: HEAL.oracle ? "ถ้าไม่หายจะลองเปิดฐานข้อมูลใหม่เอง" : "",
};
function failed(id, problem) {
  failSince[id] = failSince[id] || Date.now();
  const secs = Math.round((Date.now() - failSince[id]) / 1000);
  const tries = (heal[id] && heal[id].tries) || 0;
  if (secs < GRACE_MS / 1000) return { st: "warn", detail: `${problem} ${fmtDur(secs)}` + (HINT[id] ? ` · ${HINT[id]}` : "") };
  const note = heal[id] && heal[id].blocked ? " · ซ่อมเองไม่ได้ ต้องให้คนดู" : tries ? ` · ลองซ่อมเองแล้ว ${tries} ครั้ง` : "";
  return { st: "down", detail: `${problem}นาน ${fmtDur(secs)}` + note };
}
// ข้อความผิดพลาดทางเทคนิค → อาการที่คนอ่านรู้เรื่อง
function problemOf(id, e) {
  const m = String((e && e.message) || e);
  if (id === "oracle") return /NJS-50[03]|NJS-511|ORA-125|ECONNREFUSED|ETIMEDOUT/i.test(m) ? "เชื่อมต่อฐานข้อมูลไม่ได้" : /ORA-01017|ORA-28000/i.test(m) ? "เข้าฐานข้อมูลไม่ได้ (ชื่อ/รหัสผ่าน)" : "ฐานข้อมูลตอบผิดพลาด";
  return /ECONNREFUSED/i.test(m) ? "ปิดอยู่" : /ไม่ตอบภายใน|ETIMEDOUT|socket hang up/i.test(m) ? "ค้าง ไม่ตอบ" : "ตอบผิดพลาด";
}
const okay = (id, detail) => { delete failSince[id]; delete heal[id]; return { st: "ok", detail }; };

// เปิด TCP ไปที่กล้องแล้วปิดทันที (ไม่ส่งคำสั่ง RTSP → ไม่แย่งสตรีมกับส่วนสแกน)
function tcpOk(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });
}
let camNet = { at: 0, ok: null };   // ผลเช็คเครือข่ายกล้อง (เช็คใหม่ทุก 5 วิ เฉพาะตอนมีปัญหา)
async function cameraOnline() {
  if (!CAMERA_HOST) return null;
  if (Date.now() - camNet.at > 5000) camNet = { at: Date.now(), ok: await tcpOk(CAMERA_HOST, CAMERA_PORT) };
  return camNet.ok;
}

// ── คุณภาพภาพ: อ่านผลจาก frame_check.py (ตัวช่วย Python) ──
let image = null;          // ผลล่าสุด { ok, brightness, contrast, sharpness, diff, at }
let frozenSince = 0;
let imgProc = null;
function startImageCheck() {
  if (!IMAGE_CHECK || imgProc) return;
  if (!fs.existsSync(IMAGE_PYTHON)) { console.error("[STATUS] ไม่พบ python สำหรับตรวจภาพ: " + IMAGE_PYTHON); return; }
  const child = spawn(IMAGE_PYTHON, ["-X", "utf8", path.join(__dirname, "frame_check.py"), `http://${SVC_HOST}:${SCAN_PORT}/video_feed_frame`, String(IMAGE_SECONDS)],
    { cwd: __dirname, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  imgProc = child;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        image = { ...r, at: Date.now() };
        if (r.ok && r.diff !== null && r.diff < 0.05) frozenSince = frozenSince || Date.now(); else frozenSince = 0;
      } catch (_) {}
    }
  });
  const again = () => { if (imgProc === child) { imgProc = null; image = null; setTimeout(startImageCheck, 15000); } };   // ตัวช่วยดับ → เปิดใหม่ใน 15 วิ
  child.on("exit", again); child.on("error", again);
}
process.on("exit", () => { try { if (imgProc) imgProc.kill(); } catch (_) {} });
// คืนอาการของภาพ (null = ภาพดี หรือยังไม่มีผล)
function imageProblem() {
  if (!IMAGE_CHECK || !image || !image.ok || Date.now() - image.at > IMAGE_SECONDS * 3000) return null;
  if (image.brightness < IMAGE_DARK_MIN) return "ภาพมืดสนิท";
  if (image.brightness > IMAGE_BRIGHT_MAX) return "ภาพขาวจ้า";
  if (image.contrast < IMAGE_FLAT_MIN) return "ภาพเป็นสีเดียวทั้งจอ (เลนส์อาจถูกบัง)";
  if (frozenSince && Date.now() - frozenSince >= IMAGE_FROZEN_SECONDS * 1000) return "ภาพค้าง (ภาพเดิมซ้ำ)";
  if (IMAGE_BLUR_MIN > 0 && image.sharpness < IMAGE_BLUR_MIN) return "ภาพเบลอ (เลนส์สกปรก/โฟกัสหลุด)";
  return null;
}

async function checkScanAndCamera() {
  try {
    const h = await getJson(`http://${SVC_HOST}:${SCAN_PORT}/api/health`, 2000);
    last.scan = okay("scan", h.fps ? `${Math.round(h.fps)} เฟรม/วินาที` : "ตอบปกติ");
    const age = Number(h.last_frame_age_seconds);
    if (h.camera_ok && isFinite(age) && age < 5) {
      const bad = imageProblem();
      last.camera = bad ? failed("camera", bad) : okay("camera", `ภาพล่าสุด ${age.toFixed(1)} วินาทีที่แล้ว`);
    } else if (h.is_reconnecting) last.camera = { st: "warn", detail: "กล้องหลุด · กำลังต่อใหม่" };
    else {
      const online = await cameraOnline();
      last.camera = failed("camera", online === false ? "ต่อกล้องไม่ได้ทางเครือข่าย" : isFinite(age) && age < 900 ? "ภาพไม่เข้า" : "ไม่มีภาพ");
    }
  } catch (e) {
    last.scan = failed("scan", problemOf("scan", e));
    const online = await cameraOnline();
    last.camera = online === false ? failed("camera", "ต่อกล้องไม่ได้ทางเครือข่าย")
      : { st: "unknown", detail: online ? "กล้องออนไลน์ · รอส่วนสแกนกลับมา" : "ไม่ทราบ (ส่วนสแกนไม่ตอบ)" };
    if (online !== false) delete failSince.camera;
  }
}
async function checkApi() {
  try {
    const j = await getJson(`http://${SVC_HOST}:${API_PORT}/api/plates?limit=1`, 3000);
    const total = j && j.pagination ? j.pagination.total : null;
    last.api = okay("api", total != null ? `ทั้งหมด ${total} รายการ` : "ตอบปกติ");
  } catch (e) { last.api = failed("api", problemOf("api", e)); }
}
let oracleExtra = { at: 0, text: "" };
const checkOracle = quiet(async () => {
  try {
    await db.withConnection(async (c) => {
      await c.execute("SELECT 1 FROM DUAL");
      if (Date.now() - oracleExtra.at > 60000) {   // ขนาด + บัตรค้าง: นาทีละครั้งพอ
        const mb = (await c.execute("SELECT ROUND(SUM(BYTES)/1024/1024,1) MB FROM USER_SEGMENTS")).rows[0].MB;
        const open = (await c.execute("SELECT COUNT(*) N FROM WEIGH_TICKETS WHERE STATUS = 'OPEN'")).rows[0].N;
        oracleExtra = { at: Date.now(), text: `ใช้ ${mb} MB จาก 12 GB · บัตรค้าง ${open}` };
      }
    });
    last.oracle = okay("oracle", oracleExtra.text || "ตอบปกติ");
  } catch (e) { last.oracle = failed("oracle", problemOf("oracle", e)); }
});
function checkDisk() {
  try {
    const s = fs.statfsSync(path.parse(ROOT).root);
    const free = s.bavail * s.bsize;
    const st = free < DISK_DOWN_GB * 1024 ** 3 ? "down" : free < DISK_WARN_GB * 1024 ** 3 ? "warn" : "ok";
    last.disk = { st, detail: `ว่าง ${fmtGB(free)} จาก ${fmtGB(s.blocks * s.bsize)}` };
  } catch (e) { last.disk = { st: "unknown", detail: "อ่านพื้นที่ไม่ได้" }; }
}
function checkBackup() {
  try {
    const days = fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!days.length) { last.backup = { st: "down", detail: "ยังไม่มีไฟล์สำรอง" }; return; }
    const latest = days[days.length - 1];
    const files = fs.readdirSync(path.join(BACKUP_DIR, latest));
    const size = files.reduce((n, f) => n + fs.statSync(path.join(BACKUP_DIR, latest, f)).size, 0);
    const ageDays = Math.round((new Date(dayTh()) - new Date(latest)) / 86400000);
    const st = size === 0 ? "down" : ageDays <= BACKUP_MAX_AGE_DAYS ? "ok" : "warn";
    last.backup = { st, detail: `ล่าสุด ${thDate(latest)} · ${files.length} ไฟล์` + (ageDays > BACKUP_MAX_AGE_DAYS ? ` (${ageDays} วันก่อน)` : "") };
  } catch (e) { last.backup = { st: "unknown", detail: "อ่านโฟลเดอร์สำรองไม่ได้" }; }
}

// ── แจ้งเตือนทางอีเมล · เพิ่ม 1 ต.ค. 2569 ───────────────────────────────
// ค่าอีเมลอยู่ใน .env ของโปรแกรมนี้ (EMAIL_ENABLED / EMAIL_SENDER / EMAIL_APP_PASSWORD / EMAIL_TO / ALERT_COOLDOWN_MINUTES) · ถ้าไม่ได้ตั้ง จะใช้ของ checkprogram\.env
// แจ้งทุกส่วน (รวมงานของ checkprogram\monitor.py มาไว้ที่นี่แล้ว 2 ต.ค. 2569 — ตัวเฝ้าเหลือตัวเดียว)
//   กล้อง/ส่วนสแกน/ส่วนบันทึกข้อมูล/Oracle: เมื่อเป็นสีแดง (เกิน DOWN_AFTER_SECONDS) · ดิสก์/สำรองข้อมูล: ตั้งแต่เหลือง
// ทดสอบ: node status_server.js --test-email
const tls = require("tls");
const CHECK_DIR = envStr("CHECKPROGRAM_DIR", path.resolve(__dirname, "..", "checkprogram"));
const SMTP_HOST = envStr("SMTP_HOST", "smtp.gmail.com");
const SMTP_PORT = envNum("SMTP_PORT", 465);
const MAIL_IDS = { camera: "down", scan: "down", api: "down", oracle: "down", disk: "warn", backup: "warn" };   // id → แจ้งเมื่อแย่ถึงระดับนี้ (รวมงานของ checkprogram\\monitor.py มาไว้ที่นี่ 2 ต.ค. 2569)
const RANK = { ok: 0, unknown: 0, warn: 1, down: 2 };
const mailed = {};     // id → ส่งแจ้งเตือนไปแล้ว รอส่ง "กลับมาปกติ"
const lastMail = {};   // id → เวลาส่งล่าสุด (กันสแปมตาม ALERT_COOLDOWN_MINUTES)

function readEnvFile(p) {
  const env = {};
  try {
    for (const line of fs.readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return env;
}
let mailCache = { at: 0, cfg: null };
function mailCfg() {   // อ่าน .env ใหม่ทุก 10 วิ: แก้ได้โดยไม่ต้องปิดโปรแกรม
  if (mailCache.cfg && Date.now() - mailCache.at < 10000) return mailCache.cfg;
  // ค่าอีเมล: ถ้า .env ของ statusprogram มี EMAIL_SENDER ใช้ชุดนั้น ไม่มีก็ใช้ชุดเดิมใน checkprogram\.env
  const own = readEnvFile(OWN_ENV_FILE);
  const e = own.EMAIL_SENDER ? own : readEnvFile(path.join(CHECK_DIR, ".env"));
  if (own.ALERT_COOLDOWN_MINUTES) e.ALERT_COOLDOWN_MINUTES = own.ALERT_COOLDOWN_MINUTES;
  const re = /^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$/;
  const sender = (e.EMAIL_SENDER || "").trim();
  const pass = (e.EMAIL_APP_PASSWORD || "").replace(/\s/g, "");
  const to = (e.EMAIL_TO || "").split(",").map((x) => x.trim()).filter(Boolean);
  const valid = re.test(sender) && to.length > 0 && to.every((x) => re.test(x)) && pass.length === 16;
  mailCache = { at: Date.now(), cfg: { valid, enabled: valid && /^(1|true|yes|on)$/i.test(e.EMAIL_ENABLED || ""), sender, pass, to,
           cooldownMs: (parseFloat(e.ALERT_COOLDOWN_MINUTES) || 60) * 60000 } };
  return mailCache.cfg;
}
const oneLine = (s, n = 200) => String(s).replace(/[\r\n\t\x00-\x1f]/g, " ").slice(0, n);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// SMTP แบบสั้นๆ ผ่าน TLS (SMTP_HOST:SMTP_PORT ค่าเริ่มต้น smtp.gmail.com:465) ไม่ต้องลง nodemailer
function sendMail(cfg, subject, body) {
  return new Promise((resolve, reject) => {
    const msg = [
      `From: ${cfg.sender}`, `To: ${cfg.to.join(", ")}`,
      `Subject: =?UTF-8?B?${b64(oneLine(subject, 120))}?=`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@kohkae-status>`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
      b64(body).replace(/.{76}/g, "$&\r\n"),
    ].join("\r\n");
    // [รหัสตอบกลับที่ต้องได้, คำสั่งถัดไป]
    const steps = [[220, "EHLO kohkae-status"], [250, "AUTH LOGIN"], [334, b64(cfg.sender)], [334, b64(cfg.pass)],
      [235, `MAIL FROM:<${cfg.sender}>`], ...cfg.to.map((t) => [250, `RCPT TO:<${t}>`]),
      [250, "DATA"], [354, msg + "\r\n."], [250, "QUIT"]];
    let i = 0, buf = "", done = false;
    const finish = (err) => { if (done) return; done = true; err ? reject(err) : resolve(); };
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    sock.setTimeout(20000, () => sock.destroy(new Error("SMTP ไม่ตอบภายใน 20 วิ")));
    sock.on("error", (e) => finish(new Error(e.message)));
    sock.on("close", () => finish(new Error("SMTP ปิดการเชื่อมต่อก่อนส่งเสร็จ")));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split("\r\n"); buf = lines.pop();
      for (const line of lines) {
        if (!/^\d{3}( |$)/.test(line)) continue;           // บรรทัด "250-..." = ยังไม่จบคำตอบ
        const code = parseInt(line, 10);
        const [want, next] = steps[i++] || [];
        if (code !== want) {
          sock.destroy();
          return finish(new Error(code === 535 ? "อีเมล/App Password ไม่ถูกต้อง" : `SMTP ตอบ ${code}`));
        }
        sock.write(next + "\r\n");
        if (next === "QUIT") { finish(); sock.end(); return; }   // ส่งเมลสำเร็จแล้ว
      }
    });
  });
}

function scheduledOff() {   // ช่วงปิดตามเวลาของ checkprogram\scheduler.py ไม่แจ้ง (กันแจ้งล่มมั่ว)
  try {
    const st = JSON.parse(fs.readFileSync(path.join(CHECK_DIR, "system_state.json"), "utf8")).state;
    return ["closed", "closing", "opening"].includes(st);
  } catch (_) { return false; }
}
function mailOut(cfg, subject, body) {
  sendMail(cfg, subject, body)
    .then(() => console.log("[STATUS] ส่งอีเมลแล้ว: " + subject))
    .catch((e) => console.error("[STATUS] ส่งอีเมลไม่สำเร็จ: " + e.message));
}
function mailAlerts() {
  const cfg = mailCfg();
  if (!cfg.enabled) return;
  if (scheduledOff()) { for (const k of Object.keys(mailed)) delete mailed[k]; return; }
  const when = `${thDate(dayTh())} ${nowTh()}`;
  for (const [id, level] of Object.entries(MAIL_IDS)) {
    const cur = last[id];
    if (!cur) continue;
    if (RANK[cur.st] >= RANK[level] && !mailed[id]) {
      if (Date.now() - (lastMail[id] || 0) < cfg.cooldownMs) continue;
      mailed[id] = true; lastMail[id] = Date.now();
      mailOut(cfg, `[แจ้งเตือน] ${NAMES[id]} ${cur.st === "down" ? "ล่ม" : "มีปัญหา"}`,
        `${NAMES[id]}: ${cur.detail}\nเวลา: ${when}\nดูสถานะ: http://localhost:${PORT}`);
    } else if (cur.st === "ok" && mailed[id]) {
      delete mailed[id];
      mailOut(cfg, `[กลับมาปกติ] ${NAMES[id]}`, `${NAMES[id]} กลับมาทำงานแล้ว\nเวลา: ${when}`);
    }
  }
}

// ── เครื่องมือผู้ดูแล · เพิ่ม 1 ต.ค. 2569 ─────────────────────────────────
// สั่งได้เฉพาะจากเครื่องที่รันระบบ (127.0.0.1) จนกว่าจะมีหน้าเข้าสู่ระบบ
// เปิดใหม่ = ปิด process ที่ถือพอร์ต แล้วให้ตัวเฝ้าใน start-services.ps1 เปิดกลับให้เอง (~3 วิ)
const SERVICES = {
  scan: { port: SCAN_PORT, name: "ส่วนสแกนป้าย" },
  api: { port: API_PORT, name: "ส่วนบันทึกข้อมูล" },
  web: { port: MAIN_UI_PORT, name: "หน้าเว็บหลัก" },
};
const LOGS = {
  scan: { name: "ส่วนสแกนป้าย", file: LOG_FILE },
  backup: { name: "สำรองข้อมูล", file: path.join(ROOT, "backups", "nightly.log") },
  monitor: { name: "ตัวเฝ้าระบบ (monitor)", file: path.join(CHECK_DIR, "monitor.log") },
};
const RESTART_GAP_MS = envNum("RESTART_GAP_SECONDS", 30) * 1000;
const lastRestart = {};
let backupBusy = false;

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const isLocalReq = (req) => LOCAL_ADDRS.has(req.socket.remoteAddress);
// กันเว็บอื่นในเบราว์เซอร์แอบยิงคำสั่ง: ต้องมีหัว X-KohKae-Admin และ Origin (ถ้ามี) ต้องเป็นหน้านี้เอง
function canAct(req) {
  if (!isLocalReq(req) || req.headers["x-kohkae-admin"] !== "1") return false;
  const o = req.headers.origin;
  return !o || o === `http://${req.headers.host}`;
}
function maskSecrets(text) {
  let t = String(text).replace(/(rtsp|rtsps|https?):\/\/[^\/\s]*@/gi, "$1://***@")   // ถึง @ ตัวสุดท้าย (รหัสอาจมี @);
  const pass = mailCfg().pass;
  if (pass) t = t.split(pass).join("***");
  return t;
}
function pidsOnPort(port) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { windowsHide: true }, (err, out) => {
      if (err) return resolve([]);
      const pids = new Set();
      for (const line of String(out).split(/\r?\n/)) {
        const c = line.trim().split(/\s+/);
        if (c[0] === "TCP" && c[3] === "LISTENING" && c[1].endsWith(":" + port) && /^\d+$/.test(c[4]) && c[4] !== "0") pids.add(c[4]);
      }
      resolve([...pids]);
    });
  });
}
const killPid = (pid) => new Promise((resolve) => execFile("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true }, (err) => resolve(!err)));

async function adminRestart(id) {
  const svc = SERVICES[id];
  if (!svc) return { ok: false, msg: "ไม่รู้จักส่วนนี้" };
  const wait = RESTART_GAP_MS - (Date.now() - (lastRestart[id] || 0));
  if (wait > 0) return { ok: false, msg: `${svc.name} เพิ่งสั่งเปิดใหม่ไป รออีก ${Math.ceil(wait / 1000)} วิ` };
  const pids = await pidsOnPort(svc.port);
  if (!pids.length) return { ok: false, msg: `${svc.name} ไม่ได้เปิดอยู่ (พอร์ต ${svc.port}) · ตัวเฝ้าจะเปิดให้เอง ถ้าระบบเปิดผ่าน run.bat` };
  lastRestart[id] = Date.now();
  for (const pid of pids) await killPid(pid);
  addEvent("admin", `ผู้ดูแลสั่งเปิด${svc.name}ใหม่`);
  broadcast();
  return { ok: true, msg: `ปิด${svc.name}แล้ว · ระบบจะเปิดกลับเองในไม่กี่วินาที` };
}
function adminBackup(who = "ผู้ดูแลสั่ง") {
  if (backupBusy) return { ok: false, msg: "กำลังสำรองข้อมูลอยู่" };
  const script = path.join(DB_DIR, "backup_nightly.js");
  if (!fs.existsSync(script)) return { ok: false, msg: "ไม่พบ backup_nightly.js" };
  backupBusy = true;
  if (who === "ผู้ดูแลสั่ง") addEvent("admin", "ผู้ดูแลสั่งสำรองข้อมูลทันที");
  broadcast();
  const child = spawn(process.execPath, [script], { cwd: DB_DIR, windowsHide: true, stdio: "ignore" });
  const done = (code) => {
    if (!backupBusy) return;
    backupBusy = false;
    checkBackup();
    if (code === 0) addEvent("ok", "สำรองข้อมูลเสร็จ");
    else if (code === 2) addEvent("warn", "สำรองข้อมูลเสร็จ แต่มีเรื่องที่ควรดู (เปิด log สำรองข้อมูล)");
    else addEvent("down", `สำรองข้อมูลไม่สำเร็จ (exit ${code})`);
    broadcast();
  };
  child.on("exit", done);
  child.on("error", () => done(-1));
  return { ok: true, msg: "เริ่มสำรองข้อมูลแล้ว · เสร็จแล้วจะขึ้นในเหตุการณ์ล่าสุด" };
}
async function adminTestEmail() {
  const cfg = mailCfg();
  if (!cfg.valid) return { ok: false, msg: "ตั้งค่าอีเมลใน checkprogram\\.env ไม่ครบ" };
  try {
    await sendMail(cfg, "[ทดสอบ] หน้าสถานะระบบ KohKae", "ผู้ดูแลกดส่งอีเมลทดสอบจากหน้าสถานะ (8090)\nเวลา: " + `${thDate(dayTh())} ${nowTh()}`);
    addEvent("admin", "ผู้ดูแลส่งอีเมลทดสอบถึง " + cfg.to.join(", "));
    broadcast();
    return { ok: true, msg: "ส่งแล้ว → " + cfg.to.join(", ") };
  } catch (e) { return { ok: false, msg: "ส่งไม่สำเร็จ: " + e.message }; }
}
function adminInfo(req) {
  const cfg = mailCfg();
  return { canAct: isLocalReq(req), backupBusy, email: { enabled: cfg.enabled, to: cfg.to },
           services: Object.entries(SERVICES).map(([id, s]) => ({ id, name: s.name, port: s.port })),
           logs: Object.entries(LOGS).map(([id, l]) => ({ id, name: l.name })) };
}
function readTail(file, lines = 300) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, 120000);
    const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf8").split("\n").slice(-lines).join("\n");
  } finally { fs.closeSync(fd); }
}

// ── ซ่อมตัวเอง · เพิ่ม 2 ต.ค. 2569 ───────────────────────────────────────
// ทุกครั้งที่ซ่อม: ลงเหตุการณ์ + ส่งอีเมลบอก · ปัญหารอบเดียวลองได้ HEAL_MAX_TRIES ครั้ง ห่างกัน HEAL_RETRY_MINUTES แล้วหยุดรอคน
// ปิดทีละเรื่องได้ใน .env: HEAL_CAMERA / HEAL_ORACLE / HEAL_BACKUP / HEAL_DISK = false
function healNote(text) {
  addEvent("admin", "ระบบซ่อมเอง: " + text);
  broadcast();
  const cfg = mailCfg();
  if (cfg.enabled) mailOut(cfg, "[ซ่อมเอง] " + text, `${text}\nเวลา: ${thDate(dayTh())} ${nowTh()}\nดูสถานะ: http://localhost:${PORT}`);
}
function healReady(id, afterMs) {
  if (!failSince[id] || Date.now() - failSince[id] < afterMs) return false;
  const h = heal[id] || (heal[id] = { tries: 0, lastAt: 0 });
  return h.tries < HEAL_MAX_TRIES && Date.now() - h.lastAt >= HEAL_RETRY_MS;
}
const healMark = (id) => { heal[id].tries += 1; heal[id].lastAt = Date.now(); return `ครั้งที่ ${heal[id].tries}/${HEAL_MAX_TRIES}`; };
const runTask = (name) => new Promise((resolve) => execFile("schtasks", ["/Run", "/TN", name], { windowsHide: true }, (err) => resolve(!err)));
const HEALABLE_CAMERA = /^(ภาพค้าง|ภาพไม่เข้า|ไม่มีภาพ|ภาพมืดสนิท)/;   // เบลอ/ขาวจ้า/เลนส์ถูกบัง/กล้องหลุดเครือข่าย เปิดใหม่ก็ไม่หาย → แจ้งคนอย่างเดียว

// ย้ายภาพเก่าไปโฟลเดอร์พักบนไดรฟ์อื่น (ไม่ลบ) — คืนจำนวนไฟล์/ขนาดที่ย้าย
async function archiveOldImages() {
  const cutoff = Date.now() - IMAGE_ARCHIVE_DAYS * 86400000;
  let moved = 0, bytes = 0;
  const walk = async (dir) => {
    for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (moved >= 5000) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(full); continue; }
      const st = await fs.promises.stat(full);
      if (st.mtimeMs >= cutoff) continue;
      const dest = path.join(IMAGE_ARCHIVE_DIR, path.relative(SCREENSHOT_DIR, full));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(full, dest);
      if ((await fs.promises.stat(dest)).size !== st.size) throw new Error("คัดลอกไม่ครบ: " + ent.name);
      await fs.promises.unlink(full);
      moved += 1; bytes += st.size;
    }
  };
  await walk(SCREENSHOT_DIR);
  return { moved, bytes };
}

let healBusy = false, backupHealDay = "", diskHealDay = "", oracleTaskNoted = false;
async function runHeals() {
  if (healBusy || scheduledOff()) return;
  healBusy = true;
  try {
    const today = dayTh();
    // 1) กล้อง: ภาพค้าง/ดำ/ไม่เข้า ทั้งที่ส่วนสแกนยังตอบ → เปิดส่วนสแกนใหม่ (ตัวเฝ้าเปิดกลับเอง)
    if (HEAL.camera && last.scan && last.scan.st === "ok" && last.camera && failSince.camera
        && HEALABLE_CAMERA.test(last.camera.detail) && healReady("camera", HEAL_CAMERA_AFTER_MS)) {
      const n = healMark("camera");
      for (const pid of await pidsOnPort(SCAN_PORT)) await killPid(pid);
      lastRestart.scan = Date.now();
      healNote(`เปิดส่วนสแกนป้ายใหม่ เพราะกล้อง${last.camera.detail.split(" · ")[0]} (${n})`);
    }
    // 2) Oracle ไม่ตอบ → สั่งงานที่ติดตั้งไว้ใน Task Scheduler ให้เปิด service ใหม่ (ต้องติดตั้งครั้งเดียวด้วยสิทธิ์ผู้ดูแล)
    if (HEAL.oracle && last.oracle && last.oracle.st !== "ok" && healReady("oracle", HEAL_ORACLE_AFTER_MS)) {
      const n = healMark("oracle");
      if (await runTask(ORACLE_RESTART_TASK)) healNote(`สั่งเปิดฐานข้อมูล Oracle ใหม่ (${n})`);
      else {
        heal.oracle.tries = HEAL_MAX_TRIES; heal.oracle.blocked = true;   // สั่งไม่ได้ = ไม่นับว่าได้ซ่อม และไม่ลองซ้ำในรอบนี้
        if (!oracleTaskNoted) {
          oracleTaskNoted = true;
          addEvent("warn", "ซ่อมฐานข้อมูลเองไม่ได้: ยังไม่ได้ติดตั้งสิทธิ์เปิด Oracle ใหม่ (คลิกขวา install_oracle_restart.bat → Run as administrator หนึ่งครั้ง)");
          broadcast();
        }
      }
    }
    // 3) ไม่มีไฟล์สำรองของเมื่อคืน → สำรองซ้ำตอนเช้า วันละครั้ง
    if (HEAL.backup && last.backup && (last.backup.st === "warn" || last.backup.st === "down") && backupHealDay !== today
        && parseInt(nowTh().slice(0, 2), 10) >= HEAL_BACKUP_HOUR && !backupBusy && process.uptime() > 1200) {   // รอ 20 นาทีหลังเปิด ให้งานกลางคืนของ start-services ได้ลองก่อน
      backupHealDay = today;
      const r = adminBackup("ระบบซ่อมเอง: ");
      if (r.ok) healNote("สำรองข้อมูลซ้ำ เพราะไฟล์สำรองล่าสุดเก่าเกินกำหนด");
    }
    // 4) ดิสก์ใกล้เต็ม → ย้ายภาพเก่าไปโฟลเดอร์พักบนไดรฟ์อื่น วันละครั้ง
    if (HEAL.disk && last.disk && (last.disk.st === "warn" || last.disk.st === "down") && diskHealDay !== today) {
      diskHealDay = today;
      const sameDrive = IMAGE_ARCHIVE_DIR && path.parse(path.resolve(IMAGE_ARCHIVE_DIR)).root.toLowerCase() === path.parse(path.resolve(SCREENSHOT_DIR)).root.toLowerCase();
      if (!IMAGE_ARCHIVE_DIR || sameDrive) {
        addEvent("warn", "ดิสก์ใกล้เต็ม แต่ย้ายภาพเก่าเองไม่ได้: " + (sameDrive ? "โฟลเดอร์พักภาพอยู่ไดรฟ์เดียวกัน ย้ายแล้วไม่ได้ที่คืน" : "ยังไม่ได้ตั้งโฟลเดอร์พักภาพบนไดรฟ์อื่น (IMAGE_ARCHIVE_DIR)"));
        broadcast();
      } else {
        const r = await archiveOldImages();
        healNote(r.moved ? `ย้ายภาพเก่ากว่า ${IMAGE_ARCHIVE_DAYS} วัน ${r.moved} ไฟล์ (${(r.bytes / 1024 ** 2).toFixed(1)} MB) ไปที่ ${IMAGE_ARCHIVE_DIR}` : `ดิสก์ใกล้เต็ม แต่ไม่มีภาพเก่ากว่า ${IMAGE_ARCHIVE_DAYS} วันให้ย้าย`);
        checkDisk();
      }
    }
  } catch (e) { console.error("[STATUS] heal error:", e.message); }
  finally { healBusy = false; }
}

// ── หน้าตั้งค่า (/settings) · เพิ่ม 2 ต.ค. 2569 ─────────────────────────
// แก้ .env ของโปรแกรมนี้ผ่านฟอร์ม (เฉพาะจากเครื่องที่รันระบบ) · รหัสผ่านไม่ส่งกลับไปหน้าเว็บ เว้นว่าง = ไม่เปลี่ยน
const F = (group, key, label, type, def, help) => ({ group, key, label, type, def: String(def), help: help || "" });
const SETTINGS = [
  F("กล้อง", "CAMERA_HOST", "IP ของกล้อง", "text", "", "ใช้ลองต่อกล้องตรงทางเครือข่าย · เว้นว่าง = ไม่เช็ค"),
  F("กล้อง", "CAMERA_PORT", "พอร์ตกล้อง (RTSP)", "number", 554),
  F("อีเมลแจ้งเตือน", "EMAIL_ENABLED", "เปิดการแจ้งทางอีเมล", "bool", true),
  F("อีเมลแจ้งเตือน", "EMAIL_SENDER", "Gmail ที่ใช้ส่ง", "email", ""),
  F("อีเมลแจ้งเตือน", "EMAIL_APP_PASSWORD", "App Password (16 หลัก)", "secret", "", "สร้างที่ myaccount.google.com/apppasswords"),
  F("อีเมลแจ้งเตือน", "EMAIL_TO", "ส่งถึง", "emails", "", "หลายคนคั่นด้วยจุลภาค ,"),
  F("อีเมลแจ้งเตือน", "ALERT_COOLDOWN_MINUTES", "ส่วนเดิมแจ้งซ้ำได้หลังกี่นาที", "number", 60),
  F("เกณฑ์เตือน", "DOWN_AFTER_SECONDS", "มีปัญหานานกี่วินาทีถึงเป็นสีแดง", "number", 60, "ครบแล้วส่งอีเมลด้วย"),
  F("เกณฑ์เตือน", "DISK_WARN_GB", "ดิสก์เหลือน้อยกว่ากี่ GB = เหลือง", "number", 15),
  F("เกณฑ์เตือน", "DISK_DOWN_GB", "ดิสก์เหลือน้อยกว่ากี่ GB = แดง", "number", 5),
  F("เกณฑ์เตือน", "BACKUP_MAX_AGE_DAYS", "ไฟล์สำรองเก่ากว่ากี่วัน = เหลือง", "number", 1),
  F("ตรวจคุณภาพภาพกล้อง", "IMAGE_CHECK_ENABLED", "เปิดการตรวจภาพ", "bool", true),
  F("ตรวจคุณภาพภาพกล้อง", "IMAGE_DARK_MIN", "สว่างต่ำกว่านี้ = ภาพมืดสนิท", "number", 12, "ความสว่างเฉลี่ย 0–255"),
  F("ตรวจคุณภาพภาพกล้อง", "IMAGE_BRIGHT_MAX", "สว่างสูงกว่านี้ = ขาวจ้า", "number", 245),
  F("ตรวจคุณภาพภาพกล้อง", "IMAGE_FLAT_MIN", "ความต่างสีต่ำกว่านี้ = สีเดียวทั้งจอ", "number", 5, "เช่น เลนส์ถูกบัง"),
  F("ตรวจคุณภาพภาพกล้อง", "IMAGE_BLUR_MIN", "ความคมต่ำกว่านี้ = เบลอ", "number", 300, "0 = ไม่เช็ค"),
  F("ตรวจคุณภาพภาพกล้อง", "IMAGE_FROZEN_SECONDS", "ภาพเดิมซ้ำนานกี่วินาที = ภาพค้าง", "number", 60),
  F("ซ่อมตัวเอง", "HEAL_CAMERA", "ภาพค้าง/ดำ/ไม่เข้า → เปิดส่วนสแกนใหม่", "bool", true),
  F("ซ่อมตัวเอง", "HEAL_ORACLE", "ฐานข้อมูลไม่ตอบ → เปิด Oracle ใหม่", "bool", true, "ต้องรัน install_oracle_restart.bat แบบ Run as administrator 1 ครั้งก่อน"),
  F("ซ่อมตัวเอง", "HEAL_BACKUP", "ไฟล์สำรองเก่าเกินกำหนด → สำรองซ้ำตอนเช้า", "bool", true),
  F("ซ่อมตัวเอง", "HEAL_DISK", "ดิสก์ใกล้เต็ม → ย้ายภาพเก่าไปโฟลเดอร์พัก", "bool", true),
  F("ซ่อมตัวเอง", "IMAGE_ARCHIVE_DIR", "โฟลเดอร์พักภาพ (ต้องเป็นไดรฟ์อื่นที่ไม่ใช่ C:)", "text", "", "เว้นว่าง = ไม่ย้าย · ภาพที่ย้ายแล้ว หน้าประวัติของระบบหลักจะเปิดไม่ขึ้น"),
  F("ซ่อมตัวเอง", "HEAL_MAX_TRIES", "ปัญหารอบเดียวลองซ่อมได้กี่ครั้ง", "number", 2),
  F("ซ่อมตัวเอง", "HEAL_RETRY_MINUTES", "ลองซ่อมซ้ำได้หลังกี่นาที", "number", 5),
];
const MAIL_RE = /^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$/;
function settingsInfo() {
  const own = readEnvFile(OWN_ENV_FILE);
  return { fields: SETTINGS.map((f) => f.type === "secret" ? { ...f, value: "", isSet: !!own[f.key] } : { ...f, value: own[f.key] !== undefined ? own[f.key] : "" }),
           image: image && image.ok ? { brightness: image.brightness, contrast: image.contrast, sharpness: image.sharpness } : null };
}
function settingsSave(values) {
  if (!values || typeof values !== "object") return { ok: false, msg: "ข้อมูลไม่ถูกต้อง" };
  const errors = {}, updates = {};
  for (const f of SETTINGS) {
    if (!(f.key in values)) continue;
    const v = String(values[f.key] == null ? "" : values[f.key]).replace(/[\r\n\x00-\x1f]/g, " ").trim();
    if (f.type === "secret") { if (v === "") continue; if (v.replace(/\s/g, "").length !== 16) errors[f.key] = "ต้องมี 16 หลัก"; else updates[f.key] = v.replace(/\s/g, ""); continue; }
    if (f.type === "bool") { updates[f.key] = /^(1|true|yes|on)$/i.test(v) ? "true" : "false"; continue; }
    if (f.type === "number") { if (v !== "" && !(Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0)) errors[f.key] = "ต้องเป็นตัวเลข 0 ขึ้นไป"; else updates[f.key] = v === "" ? "" : String(parseFloat(v)); continue; }
    if (f.type === "email" && v !== "" && !MAIL_RE.test(v)) { errors[f.key] = "รูปแบบอีเมลไม่ถูก"; continue; }
    if (f.type === "emails" && v !== "" && !v.split(",").map((x) => x.trim()).filter(Boolean).every((x) => MAIL_RE.test(x))) { errors[f.key] = "มีอีเมลที่รูปแบบไม่ถูก"; continue; }
    if (v.includes("#")) { errors[f.key] = "ห้ามมีเครื่องหมาย #"; continue; }
    updates[f.key] = v;
  }
  if (Object.keys(errors).length) return { ok: false, msg: "มีช่องที่กรอกไม่ถูก", errors };
  let text = "";
  try { text = fs.readFileSync(OWN_ENV_FILE, "utf8").replace(/^﻿/, ""); } catch (_) {}
  const lines = text.split(/\r?\n/);
  const changed = [];
  for (const [key, val] of Object.entries(updates)) {
    const live = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    const idx = live >= 0 ? live : lines.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
    const next = `${key}=${val}`;
    if (idx >= 0) { if (lines[idx] !== next) { lines[idx] = next; changed.push(key); } }
    else { lines.push(next); changed.push(key); }
  }
  if (!changed.length) return { ok: true, msg: "ไม่มีอะไรเปลี่ยน", changed };
  fs.writeFileSync(OWN_ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"), "utf8");
  mailCache = { at: 0, cfg: null };
  const labels = changed.map((k) => (SETTINGS.find((f) => f.key === k) || {}).label || k);
  addEvent("admin", "ผู้ดูแลแก้ค่าตั้ง: " + labels.join(", "));
  broadcast();
  return { ok: true, msg: `บันทึกแล้ว ${changed.length} ค่า · ส่วนอีเมลมีผลทันที ส่วนอื่นมีผลหลังเปิดหน้าสถานะใหม่`, changed, needRestart: changed.some((k) => !/^EMAIL_|^ALERT_/.test(k)) };
}
async function adminTestCamera(body) {
  const host = String((body && body.host) || CAMERA_HOST || "").trim(), port = parseInt((body && body.port) || CAMERA_PORT, 10);
  if (!/^[A-Za-z0-9.\-]+$/.test(host) || !(port > 0 && port < 65536)) return { ok: false, msg: "ใส่ IP และพอร์ตของกล้องก่อน" };
  return (await tcpOk(host, port)) ? { ok: true, msg: `ต่อกล้อง ${host}:${port} ได้` } : { ok: false, msg: `ต่อกล้อง ${host}:${port} ไม่ได้` };
}
function adminRestartSelf() {
  addEvent("admin", "ผู้ดูแลสั่งเปิดหน้าสถานะใหม่");
  setTimeout(() => process.exit(0), 400);   // ตัวเฝ้าใน start-services.ps1 เปิดกลับใน ~3 วิ
  return { ok: true, msg: "กำลังเปิดหน้าสถานะใหม่…" };
}
function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on("end", () => { try { resolve(size && size <= limit ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

let lastRun = null;
// หลังเช็คแต่ละส่วนเสร็จ: บันทึกเหตุการณ์ที่เปลี่ยน → แจ้งอีเมล → ส่งเข้าหน้าเว็บทันที
function commit() {
  lastRun = new Date();
  for (const id of Object.keys(NAMES)) {
    const s = last[id] && last[id].st;
    if (s === undefined) continue;
    if (prevSt[id] === undefined ? (s === "warn" || s === "down") : s !== prevSt[id]) {   // รอบแรกหลังเปิด: มีปัญหาอยู่แล้วก็จดด้วย
      const text = s === "ok" ? `${NAMES[id]} กลับมาปกติ`
        : s === "warn" ? `${NAMES[id]}: ${last[id].detail}`
        : s === "down" ? `${NAMES[id]} ล่ม — ${last[id].detail}`
        : `${NAMES[id]}: ${last[id].detail}`;
      addEvent(s, text);
    }
    prevSt[id] = s;
  }
  try { mailAlerts(); } catch (e) { console.error("[STATUS] mail error:", e.message); }
  runHeals();
  broadcast();
}
// วนเช็คแยกกัน: ส่วนที่ช้า (Oracle) ไม่หน่วงส่วนที่เร็ว · รอบก่อนยังไม่เสร็จ = ข้ามรอบนี้ (ไม่ซ้อน)
function loop(fn, ms) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error("[STATUS] check error:", e.message); }
    finally { busy = false; }
    commit();
  };
  tick();
  setInterval(tick, ms);
}
function startChecks() {
  startImageCheck();
  loop(checkScanAndCamera, FAST_MS);
  loop(checkApi, API_MS);
  loop(checkOracle, ORACLE_MS);
  loop(async () => { checkDisk(); checkBackup(); }, SLOW_MS);
}

function snapshot() {
  const items = Object.keys(NAMES).map((id) => ({ id, name: NAMES[id], sub: SUBS[id], ...(last[id] || { st: "unknown", detail: "กำลังเช็ค…" }) }));
  const bad = items.filter((i) => i.st === "down"), warn = items.filter((i) => i.st === "warn");
  const overall = bad.length ? { st: "down", text: bad.length === 1 ? `${bad[0].name} ล่ม` : `${bad.length} ส่วนล่ม` }
    : warn.length ? { st: "warn", text: warn.length === 1 ? `${warn[0].name} มีปัญหา` : `${warn.length} ส่วนมีปัญหา` }
    : { st: "ok", text: "ทุกส่วนทำงานปกติ" };
  return { updated: lastRun ? lastRun.toISOString() : null, updatedTh: lastRun ? lastRun.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour12: false }) : null,
           overall, items, events: events.slice(0, 30), mainUiPort: MAIN_UI_PORT };
}

// ── หน้าเว็บ ───────────────────────────────────────────────────────────
const PAGE = fs.readFileSync(path.join(__dirname, "status_page.html"), "utf8");
// ส่งสถานะเข้าหน้าเว็บสดๆ (Server-Sent Events) ไม่ต้องรอหน้าเว็บมาถามทุก 5 วิ
const clients = new Set();
let lastPush = { json: "", at: 0 };
function broadcast() {
  if (!clients.size) return;
  const snap = snapshot();
  const json = JSON.stringify(snap);
  const key = JSON.stringify([snap.overall, snap.items, snap.events[0] && snap.events[0].at]);
  if (key === lastPush.json && Date.now() - lastPush.at < 1000) return;   // ไม่เปลี่ยน = ส่งแค่วิละครั้ง (นาฬิกา)
  lastPush = { json: key, at: Date.now() };
  for (const c of clients) c.write(`data: ${json}\n\n`);
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://localhost");
  const url = u.pathname;
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (req.method === "POST" && url.startsWith("/api/admin/")) {
    if (!canAct(req)) return json(403, { ok: false, msg: "สั่งงานได้เฉพาะจากเครื่องที่รันระบบ" });
    const parts = url.split("/");   // ["", "api", "admin", action, id]
    readBody(req).then((body) => parts[3] === "restart" ? adminRestart(parts[4])
      : parts[3] === "backup" ? adminBackup("ผู้ดูแลสั่ง")
      : parts[3] === "test-email" ? adminTestEmail()
      : parts[3] === "test-camera" ? adminTestCamera(body)
      : parts[3] === "settings" ? settingsSave(body.values)
      : parts[3] === "restart-self" ? adminRestartSelf()
      : { ok: false, msg: "ไม่รู้จักคำสั่งนี้" })
      .then((r) => json(r.ok ? 200 : 409, r)).catch((e) => json(500, { ok: false, msg: e.message }));
    return;
  }
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  if (url === "/api/admin") return json(200, adminInfo(req));
  if (url === "/api/admin/settings") return isLocalReq(req) ? json(200, settingsInfo()) : json(403, { ok: false, msg: "ตั้งค่าได้เฉพาะจากเครื่องที่รันระบบ" });
  if (url === "/settings") {
    let page = "";
    try { page = fs.readFileSync(path.join(__dirname, "status_settings.html"), "utf8"); } catch (_) { page = "ไม่พบ status_settings.html"; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(page);
  }
  if (url === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`retry: 2000\n\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(snapshot()));
  }
  if (url === "/log") {
    const which = LOGS[u.searchParams.get("f")] ? u.searchParams.get("f") : "scan";
    const lg = LOGS[which];
    let text = "";
    try { text = maskSecrets(readTail(lg.file)); } catch (e) { text = "เปิดไฟล์ log ไม่ได้: " + e.message; }
    const tabs = Object.entries(LOGS).map(([id, l]) => id === which ? `<b>${esc(l.name)}</b>` : `<a style="color:#9CC7FF" href="/log?f=${id}">${esc(l.name)}</a>`).join(" · ");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>log ${esc(lg.name)}</title><body style="margin:0;background:#14161A;color:#E8E6E1;font:13px/1.5 Consolas,monospace"><div style="padding:16px 20px;font-family:'Leelawadee UI',Tahoma,sans-serif;font-size:15px;display:flex;flex-wrap:wrap;gap:12px">${tabs} <span style="color:#A3A9B0">· ${esc(path.basename(lg.file))} 300 บรรทัดล่าสุด ·</span> <a style="color:#9CC7FF" href="/">กลับหน้าสถานะ</a></div><pre style="margin:0;padding:0 20px 20px;white-space:pre-wrap">${esc(text)}</pre><script>scrollTo(0,document.body.scrollHeight)</script></body>`);
  }
  if (url === "/status_page.css") {
    let css = "";
    try { css = fs.readFileSync(path.join(__dirname, "status_page.css"), "utf8"); } catch (_) {}
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(css);
  }
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(PAGE);
  }
  res.writeHead(404); res.end("not found");
});

if (process.argv.includes("--test-email")) {
  const cfg = mailCfg();
  if (!cfg.valid) { console.error("[STATUS] ตั้งค่า EMAIL_* ใน " + path.join(CHECK_DIR, ".env") + " ไม่ครบ/ไม่ถูกต้อง"); process.exit(1); }
  sendMail(cfg, "[ทดสอบ] หน้าสถานะระบบ KohKae", "ถ้าได้รับเมลนี้ แปลว่าหน้าสถานะ (8090) ส่งแจ้งเตือนทางอีเมลได้แล้ว")
    .then(() => { console.log("ส่งแล้ว → " + cfg.to.join(", ")); process.exit(0); })
    .catch((e) => { console.error("ส่งไม่สำเร็จ: " + e.message); process.exit(1); });
} else {
  server.on("error", (e) => { console.error("[STATUS] เปิดพอร์ต " + PORT + " ไม่ได้: " + e.message); process.exit(1); });
  server.listen(PORT, HOST, async () => {
    console.log(`[STATUS] หน้าสถานะพร้อม http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    addEvent("ok", "เริ่มตัวเช็คสถานะ");
    startChecks();
  });
}

const stop = async () => { try { await quiet(db.closePool)(); } catch (_) {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
