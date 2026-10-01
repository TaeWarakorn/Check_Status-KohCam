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
const INTERVAL_MS = 5000;
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
    const h = await getJson("http://127.0.0.1:8000/api/health");
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
    const j = await getJson("http://127.0.0.1:5000/api/plates?limit=1");
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

let lastRun = null;
async function runChecks() {
  await Promise.all([checkScanAndCamera(), checkApi(), checkOracle()]);
  checkDisk(); checkBackup();
  lastRun = new Date();
  for (const id of Object.keys(NAMES)) {
    const s = last[id] && last[id].st;
    if (prevSt[id] !== undefined && s !== prevSt[id]) {
      const text = s === "ok" ? `${NAMES[id]} กลับมาปกติ`
        : s === "warn" ? `${NAMES[id]}: ${last[id].detail}`
        : s === "down" ? `${NAMES[id]} ล่ม — ${last[id].detail}`
        : `${NAMES[id]}: ${last[id].detail}`;
      addEvent(s, text);
    }
    prevSt[id] = s;
  }
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
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  if (url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(snapshot()));
  }
  if (url === "/log") {
    let text = "";
    try {
      const fd = fs.openSync(LOG_FILE, "r"); const size = fs.fstatSync(fd).size; const n = Math.min(size, 120000);
      const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
      text = buf.toString("utf8").split("\n").slice(-300).join("\n");
    } catch (e) { text = "เปิดไฟล์ log ไม่ได้: " + e.message; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>log ส่วนสแกน</title><body style="margin:0;background:#14161A;color:#E8E6E1;font:13px/1.5 Consolas,monospace"><div style="padding:16px 20px;font-family:'Leelawadee UI',Tahoma,sans-serif;font-size:15px">detection.log · 300 บรรทัดล่าสุด · <a style="color:#9CC7FF" href="/">กลับหน้าสถานะ</a></div><pre style="margin:0;padding:0 20px 20px;white-space:pre-wrap">${esc(text)}</pre><script>scrollTo(0,document.body.scrollHeight)</script></body>`);
  }
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(PAGE);
  }
  res.writeHead(404); res.end("not found");
});

server.on("error", (e) => { console.error("[STATUS] เปิดพอร์ต " + PORT + " ไม่ได้: " + e.message); process.exit(1); });
server.listen(PORT, HOST, async () => {
  console.log(`[STATUS] หน้าสถานะพร้อม http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  addEvent("ok", "เริ่มตัวเช็คสถานะ");
  await runChecks();
  setInterval(() => runChecks().catch((e) => console.error("[STATUS] check error:", e.message)), INTERVAL_MS);
});
const stop = async () => { try { await quiet(db.closePool)(); } catch (_) {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
