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
const path = require("path");

// โปรแกรมนี้อยู่นอกโปรเจกต์ (Desktop\statusprogram) ชี้ไปที่ Myproject ที่อยู่ข้างกัน — เปลี่ยนได้ด้วย MYPROJECT_DIR
const ROOT = process.env.MYPROJECT_DIR || path.resolve(__dirname, "..", "Myproject");
const DB_DIR = path.join(ROOT, "database");
for (const p of [path.join(DB_DIR, ".env"), path.join(ROOT, "backend", ".env")])
  require(path.join(DB_DIR, "node_modules", "dotenv")).config({ path: p, quiet: true });
process.env.ORACLE_POOL_MIN = "0";
process.env.ORACLE_POOL_MAX = "2";
const db = require(path.join(DB_DIR, "db"));

const PORT = parseInt(process.env.STATUS_PORT || "8090", 10);
const HOST = process.env.STATUS_HOST || "127.0.0.1";
// รอบเช็ค (เร็วขึ้น 1 ต.ค. 2569 — เดิมทุก 5 วิ กว่าจะเห็นว่าล่ม ระบบก็กลับมาแล้ว)
const FAST_MS = 1000;     // ส่วนสแกน + กล้อง (8000/api/health)
const API_MS = 2000;      // ส่วนบันทึกข้อมูล (5000)
const ORACLE_MS = 5000;   // Oracle (query จริง)
const SLOW_MS = 30000;    // ดิสก์ + สำรองข้อมูล (เปลี่ยนช้า)
const GRACE_MS = 60000;
const BACKUP_DIR = path.join(ROOT, "backups", "db");
const LOG_FILE = path.join(ROOT, "backend", "mainprogram", "detection.log");
const EVENTS_FILE = path.join(__dirname, "events.json");
const MAIN_UI_PORT = 5173;

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
const SUBS = { camera: "กล้อง RTSP", scan: "พอร์ต 8000", api: "พอร์ต 5000", oracle: "พอร์ต 1521", disk: "ไดรฟ์ระบบ", backup: "ทุกคืน" };
const failSince = {};
const last = {};       // id → { st, detail }
const prevSt = {};

// ล้มเหลว: < 60 วิ = warn (ระบบเปิดใหม่ให้เอง), ≥ 60 วิ = down
function failed(id, why) {
  failSince[id] = failSince[id] || Date.now();
  const secs = Math.round((Date.now() - failSince[id]) / 1000);
  return secs < GRACE_MS / 1000
    ? { st: "warn", detail: `ไม่ตอบ ${secs} วิ · รอระบบเปิดใหม่ให้เอง` }
    : { st: "down", detail: `ไม่ตอบมา ${Math.floor(secs / 60)} นาที ${secs % 60} วิ (${why})` };
}
const okay = (id, detail) => { delete failSince[id]; return { st: "ok", detail }; };

async function checkScanAndCamera() {
  try {
    const h = await getJson("http://127.0.0.1:8000/api/health", 2000);
    last.scan = okay("scan", h.fps ? `${Math.round(h.fps)} เฟรม/วินาที` : "ตอบปกติ");
    const age = Number(h.last_frame_age_seconds);
    if (h.camera_ok && isFinite(age) && age < 5) last.camera = okay("camera", `ภาพล่าสุด ${age.toFixed(1)} วินาทีที่แล้ว`);
    else if (h.is_reconnecting) last.camera = { st: "warn", detail: "กล้องหลุด · กำลังต่อใหม่" };
    else last.camera = failed("camera", isFinite(age) ? `ภาพค้าง ${Math.round(age)} วิ` : "ไม่มีภาพ");
  } catch (e) {
    last.scan = failed("scan", e.message);
    last.camera = { st: "unknown", detail: "ไม่ทราบ (ส่วนสแกนไม่ตอบ)" };
  }
}
async function checkApi() {
  try {
    const j = await getJson("http://127.0.0.1:5000/api/plates?limit=1", 3000);
    const total = j && j.pagination ? j.pagination.total : null;
    last.api = okay("api", total != null ? `ทั้งหมด ${total} รายการ` : "ตอบปกติ");
  } catch (e) { last.api = failed("api", e.message); }
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
  } catch (e) { last.oracle = failed("oracle", String(e.message).split("\n")[0].slice(0, 60)); }
});
function checkDisk() {
  try {
    const s = fs.statfsSync(path.parse(ROOT).root);
    const free = s.bavail * s.bsize;
    const st = free < 5 * 1024 ** 3 ? "down" : free < 15 * 1024 ** 3 ? "warn" : "ok";
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
    const st = size === 0 ? "down" : ageDays <= 1 ? "ok" : "warn";
    last.backup = { st, detail: `ล่าสุด ${thDate(latest)} · ${files.length} ไฟล์` + (ageDays > 1 ? ` (${ageDays} วันก่อน)` : "") };
  } catch (e) { last.backup = { st: "unknown", detail: "อ่านโฟลเดอร์สำรองไม่ได้" }; }
}

// ── แจ้งเตือนทางอีเมล · เพิ่ม 1 ต.ค. 2569 ───────────────────────────────
// ใช้ Gmail + App Password ชุดเดียวกับ checkprogram\.env (EMAIL_ENABLED / EMAIL_SENDER / EMAIL_APP_PASSWORD / EMAIL_TO / ALERT_COOLDOWN_MINUTES)
// แจ้งเฉพาะสิ่งที่ checkprogram\monitor.py ไม่เห็น (monitor เช็คแค่พอร์ต 8000/5000/1521 + กล้องต่อ TCP ได้)
//   กล้อง: ภาพค้าง/ไม่มีภาพ ≥ 60 วิ · Oracle: query ไม่ผ่าน ≥ 60 วิ · ดิสก์/สำรองข้อมูล: ตั้งแต่เหลือง
// ทดสอบ: node status_server.js --test-email
const tls = require("tls");
const CHECK_DIR = process.env.CHECKPROGRAM_DIR || path.resolve(__dirname, "..", "checkprogram");
const MAIL_IDS = { camera: "down", oracle: "down", disk: "warn", backup: "warn" };   // id → แจ้งเมื่อแย่ถึงระดับนี้
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
  const e = readEnvFile(path.join(CHECK_DIR, ".env"));
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

// SMTP แบบสั้นๆ ผ่าน TLS (smtp.gmail.com:465) ไม่ต้องลง nodemailer
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
    const sock = tls.connect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com" });
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
const { execFile, spawn } = require("child_process");
const SERVICES = {
  scan: { port: 8000, name: "ส่วนสแกนป้าย" },
  api: { port: 5000, name: "ส่วนบันทึกข้อมูล" },
  web: { port: 5173, name: "หน้าเว็บหลัก" },
};
const LOGS = {
  scan: { name: "ส่วนสแกนป้าย", file: LOG_FILE },
  backup: { name: "สำรองข้อมูล", file: path.join(ROOT, "backups", "nightly.log") },
  monitor: { name: "ตัวเฝ้าระบบ (monitor)", file: path.join(CHECK_DIR, "monitor.log") },
};
const RESTART_GAP_MS = 30000;
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
function adminBackup() {
  if (backupBusy) return { ok: false, msg: "กำลังสำรองข้อมูลอยู่" };
  const script = path.join(DB_DIR, "backup_nightly.js");
  if (!fs.existsSync(script)) return { ok: false, msg: "ไม่พบ backup_nightly.js" };
  backupBusy = true;
  addEvent("admin", "ผู้ดูแลสั่งสำรองข้อมูลทันที");
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

let lastRun = null;
// หลังเช็คแต่ละส่วนเสร็จ: บันทึกเหตุการณ์ที่เปลี่ยน → แจ้งอีเมล → ส่งเข้าหน้าเว็บทันที
function commit() {
  lastRun = new Date();
  for (const id of Object.keys(NAMES)) {
    const s = last[id] && last[id].st;
    if (s === undefined) continue;
    if (prevSt[id] !== undefined && s !== prevSt[id]) {
      const text = s === "ok" ? `${NAMES[id]} กลับมาปกติ`
        : s === "warn" ? `${NAMES[id]}: ${last[id].detail}`
        : s === "down" ? `${NAMES[id]} ล่ม — ${last[id].detail}`
        : `${NAMES[id]}: ${last[id].detail}`;
      addEvent(s, text);
    }
    prevSt[id] = s;
  }
  try { mailAlerts(); } catch (e) { console.error("[STATUS] mail error:", e.message); }
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
  loop(checkScanAndCamera, FAST_MS);
  loop(checkApi, API_MS);
  loop(checkOracle, ORACLE_MS);
  loop(async () => { checkDisk(); checkBackup(); }, SLOW_MS);
}

function snapshot() {
  const items = Object.keys(NAMES).map((id) => ({ id, name: NAMES[id], sub: SUBS[id], ...(last[id] || { st: "unknown", detail: "กำลังเช็ค…" }) }));
  const bad = items.filter((i) => i.st === "down"), warn = items.filter((i) => i.st === "warn");
  const overall = bad.length ? { st: "down", text: bad.length === 1 ? `${bad[0].name}ล่ม` : `${bad.length} ส่วนล่ม` }
    : warn.length ? { st: "warn", text: warn.length === 1 ? `${warn[0].name}มีปัญหา` : `${warn.length} ส่วนมีปัญหา` }
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
    const run = parts[3] === "restart" ? adminRestart(parts[4])
      : parts[3] === "backup" ? adminBackup()
      : parts[3] === "test-email" ? adminTestEmail()
      : { ok: false, msg: "ไม่รู้จักคำสั่งนี้" };
    Promise.resolve(run).then((r) => json(r.ok ? 200 : 409, r)).catch((e) => json(500, { ok: false, msg: e.message }));
    return;
  }
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  if (url === "/api/admin") return json(200, adminInfo(req));
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
