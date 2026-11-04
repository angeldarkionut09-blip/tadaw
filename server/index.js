import "dotenv/config";
import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import PDFDocument from "pdfkit";
import { db, getSetting, saveSetting, id, nowIso, toCents, fromCents, recordAudit } from "./db.js";
import { dashboard, rowsForPeriod, utcBoundsForBucharestDates } from "./finance.js";
import { archiveDocument, readArchiveSettings, saveArchiveSettings, testArchiveConnection } from "./archive.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const appRoot = resolve(here, "..");
const uploadDir = resolve(process.env.NICUBANK_DATA_DIR || resolve(here, "data"), "uploads");
mkdirSync(uploadDir, { recursive: true });
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const safeName = (value, max = 180) => String(value ?? "").trim().slice(0, max);
const expenseCategories = ["piese", "consumabile", "utilități", "chirie", "salarii", "combustibil", "scule și echipamente", "transport", "alte cheltuieli"];
const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const today = () => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
};
function validUploadedFile(file) {
  const fd = openSync(file.path, "r");
  const bytes = Buffer.alloc(12);
  let length;
  try { length = readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
  const head = bytes.subarray(0, length);
  if (file.mimetype === "image/jpeg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (file.mimetype === "image/png") return head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (file.mimetype === "image/webp") return head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP";
  if (file.mimetype === "application/pdf") return head.toString("ascii", 0, 4) === "%PDF";
  return false;
}
const hash = (token) => createHash("sha256").update(token).digest("hex");
const tokenMatches = (input, expected) => timingSafeEqual(
  createHash("sha256").update(String(input ?? "")).digest(),
  createHash("sha256").update(String(expected ?? "")).digest(),
);
const passwordHash = (password, salt = randomBytes(16).toString("hex")) => `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const passwordMatches = (input, stored) => {
  try { const [salt, expected] = stored.split(":"); const actual = scryptSync(input, salt, 64); return timingSafeEqual(actual, Buffer.from(expected, "hex")); }
  catch { return false; }
};
function setSessionCookie(res, token, maxAge = 60 * 60 * 24 * 14) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `nicubank_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}
function getUser(req) {
  const token = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith("nicubank_session="))?.slice("nicubank_session=".length);
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.name,u.email,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token), nowIso());
  return row ? { id: row.id, name: row.name, email: row.email, sessionId: row.session_id } : null;
}
function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Sesiunea a expirat. Autentifică-te din nou." });
  req.user = user;
  next();
}
function audit(req, type, entityId, action, oldValue, newValue) {
  recordAudit(req.user, type, entityId, action, oldValue, newValue);
}
const ownsDocument = (userId, documentId) => !documentId || Boolean(db.prepare("SELECT 1 FROM documents WHERE id=? AND user_id=?").get(documentId, userId));
const ownsEmployee = (userId, employeeId) => !employeeId || Boolean(db.prepare("SELECT 1 FROM employees WHERE id=? AND user_id=?").get(employeeId, userId));
function rowMoney(row, fields) {
  if (!row) return row;
  const result = { ...row };
  for (const field of fields) { result[field] = fromCents(result[`${field}_cents`]); delete result[`${field}_cents`]; }
  if (result.active !== undefined) result.active = Boolean(result.active);
  if (result.items_json) { try { result.items = JSON.parse(result.items_json); } catch { result.items = []; } delete result.items_json; }
  return result;
}
function list(req, table, orderBy, fields = []) {
  const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY ${orderBy} DESC LIMIT 500`).all(req.user.id);
  return rows.map((row) => rowMoney(row, fields));
}
function insertDocument(req, file, category) {
  const now = nowIso();
  const documentId = id();
  db.prepare(`INSERT INTO documents (id,user_id,category,original_name,stored_name,mime_type,size_bytes,local_path,uploaded_at,archive_status)
    VALUES (?,?,?,?,?,?,?,?,?,'local_only')`).run(documentId, req.user.id, category, basename(file.originalname).slice(0, 240), file.filename, file.mimetype, file.size, file.path, now);
  audit(req, "document", documentId, "uploaded", null, { name: file.originalname, category, size: file.size });
  return db.prepare("SELECT * FROM documents WHERE id=?").get(documentId);
}
async function maybeArchive(document) {
  const settings = getSetting(document.user_id, "ftpEncrypted");
  if (!settings) return;
  try {
    const safe = readArchiveSettings(document.user_id);
    if (safe.autoUpload) await archiveDocument(document.id, document.user_id);
  } catch (error) {
    db.prepare("UPDATE documents SET archive_status='failed',archive_error=? WHERE id=?").run(String(error.message || error).slice(0, 500), document.id);
  }
}
const storage = multer.diskStorage({ destination: uploadDir, filename: (_req, file, done) => done(null, `${id()}${extname(file.originalname).toLowerCase().slice(0, 10)}`) });
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_req, file, done) => {
  const ok = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype);
  done(ok ? null : new Error("Încarcă o fotografie JPG/PNG/WEBP sau un PDF."), ok);
} });

// Public account bootstrap and session routes.
app.get("/api/session", (req, res) => {
  const user = getUser(req);
  res.json({ authenticated: Boolean(user), needsSetup: db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0,
    user: user ? { id: user.id, name: user.name, email: user.email } : null });
});
app.post("/api/auth/setup", (req, res) => {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n) return res.status(409).json({ error: "Contul principal este deja configurat." });
  const setupToken = process.env.SETUP_TOKEN || "";
  if (process.env.NODE_ENV === "production" && !setupToken) return res.status(503).json({ error: "Configurarea contului online este blocată până când administratorul setează SETUP_TOKEN." });
  if (setupToken && !tokenMatches(req.body?.setupToken, setupToken)) return res.status(403).json({ error: "Codul inițial de configurare nu este corect." });
  const name = safeName(req.body?.name, 80);
  const email = safeName(req.body?.email, 160).toLowerCase();
  const password = String(req.body?.password || "");
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) return res.status(400).json({ error: "Introdu numele, o adresă de e-mail validă și o parolă de cel puțin 12 caractere." });
  const userId = id();
  db.prepare("INSERT INTO users (id,name,email,password_hash,created_at) VALUES (?,?,?,?,?)").run(userId, name, email, passwordHash(password), nowIso());
  const user = { id: userId, name, email };
  for (const [key, value] of Object.entries({ sarcasmLevel: "NEMILOS", notifications: true, sounds: false, animation: "discrete", includeJobRevenue: true, customRoasts: [], eligibleExpenseCategories: ["piese", "consumabile", "utilități", "chirie", "combustibil", "scule și echipamente", "transport", "alte cheltuieli"] })) saveSetting(userId, key, value);
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)").run(id(), userId, hash(token), nowIso(), new Date(Date.now() + 14 * 86400000).toISOString());
  setSessionCookie(res, token);
  res.status(201).json({ authenticated: true, user });
});
const authFailures = new Map();
app.post("/api/auth/login", (req, res) => {
  const email = safeName(req.body?.email, 160).toLowerCase();
  const password = String(req.body?.password || "");
  const key = String(req.socket.remoteAddress || "local") + ":" + email;
  const recent = authFailures.get(key);
  if (recent?.blockedUntil > Date.now()) return res.status(429).json({ error: "Prea multe încercări. Așteaptă câteva minute și încearcă din nou." });
  const userRow = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!userRow || !passwordMatches(password, userRow.password_hash)) {
    const state = recent || { count: 0, blockedUntil: 0 };
    state.count += 1;
    if (state.count >= 8) { state.count = 0; state.blockedUntil = Date.now() + 10 * 60 * 1000; }
    authFailures.set(key, state);
    return res.status(401).json({ error: "E-mailul sau parola nu se potrivește. Verifică și încearcă din nou." });
  }
  authFailures.delete(key);
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)").run(id(), userRow.id, hash(token), nowIso(), new Date(Date.now() + 14 * 86400000).toISOString());
  setSessionCookie(res, token);
  res.json({ authenticated: true, user: { id: userRow.id, name: userRow.name, email: userRow.email } });
});
app.post("/api/auth/logout", (req, res) => {
  const user = getUser(req);
  if (user) db.prepare("DELETE FROM sessions WHERE id=?").run(user.sessionId);
  setSessionCookie(res, "", 0);
  res.status(204).end();
});

app.use("/api", requireAuth);
app.get("/api/summary", (req, res) => {
  if (req.query.range === "custom" && (!isDate(req.query.from) || !isDate(req.query.to) || req.query.from > req.query.to)) return res.status(400).json({ error: "Perioada personalizată nu conține date valide." });
  res.json(dashboard(req.user.id, req.query));
});
app.get("/api/integrations", (_req, res) => res.json({ aiAvailable: Boolean(process.env.OPENAI_API_KEY), aiModel: process.env.OPENAI_MODEL || "gpt-6-luna", localOcrAvailable: true }));
app.post("/api/bot/ask", async (req, res) => {
  const question = safeName(req.body?.question, 600);
  if (!question) return res.status(400).json({ error: "Scrie o întrebare pentru NICU BOT." });
  const range = /azi|astăzi/i.test(question) ? "today" : /săptămână|saptamana/i.test(question) ? "week" : "month";
  const facts = dashboard(req.user.id, { range });
  const localAnswer = () => {
    const q = question.toLocaleLowerCase("ro");
    if (q.includes("încas") || q.includes("incas")) return "În perioada selectată ai încasat efectiv " + facts.receipts.value.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei. Asta înseamnă plăți înregistrate, nu doar lucrări trecute în caiet.";
    if (q.includes("profit")) return "Profitul estimat pentru perioada aceasta este " + facts.profit.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei. Calculul folosește lucrările eligibile, cheltuielile selectate și obligațiile salariale.";
    if (q.includes("salari")) return "Obligațiile salariale estimate sunt " + facts.salaries.due.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei, cu " + facts.salaries.outstanding.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei rămași de plată înregistrată.";
    if (q.includes("factur")) return "Ai adăugat " + facts.invoices.count + " facturi în perioada aceasta, în valoare totală de " + facts.invoices.total.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei cu TVA.";
    if (q.includes("restan") || q.includes("neachit")) return "Restanțele lucrărilor din această perioadă sunt " + facts.receivables.value.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei, din " + facts.receivables.count + " lucrări neplătite integral.";
    if (q.includes("lucr") || q.includes("caiet")) return "În caiet sunt " + facts.service.count + " lucrări în valoare de " + facts.service.value.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei. Încasările efective se calculează separat.";
    if (q.includes("chelt")) return "Cheltuielile înregistrate sunt " + facts.expenses.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei. Din acestea, " + facts.eligibleExpenses.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei intră în formula profitului.";
    return "Pentru perioada selectată: " + facts.service.count + " lucrări, " + facts.receipts.value.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei încasați și " + facts.profit.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) + " lei profit estimat. Pune o întrebare despre facturi, salarii, cheltuieli, încasări sau restanțe.";
  };
  if (!process.env.OPENAI_API_KEY) return res.json({ answer: localAnswer(), mode: "local" });
  try {
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-6-luna",
        instructions: "Ești NICU BOT, contabilul virtual al unui service auto. Răspunde în română, scurt, prietenos și sarcastic despre situația financiară a lui Nicu. Folosește numai cifrele din context. Nu inventa valori și spune când nu există date. Profitul este estimat, nu cash. Lucrările nu sunt automat încasări. Facturile sunt costuri, nu venituri. Nu folosi insulte discriminatorii sau amenințări.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Date financiare reale: " + JSON.stringify(facts) + "\nÎntrebarea: " + question }] }], max_output_tokens: 220 }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "Serviciul AI a refuzat cererea.");
    return res.json({ answer: result.output_text || localAnswer(), mode: "ai" });
  } catch {
    return res.json({ answer: localAnswer() + " Serviciul AI nu a răspuns acum, așa că ți-am dat rezumatul calculat local.", mode: "local" });
  }
});
app.post("/api/ocr/ai", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Alege o fotografie pentru extragere." });
  if (!process.env.OPENAI_API_KEY) { try { unlinkSync(req.file.path); } catch {} return res.status(503).json({ error: "Extragerea AI cere OPENAI_API_KEY în fișierul .env. OCR-ul local rămâne disponibil." }); }
  if (req.file.size > 6 * 1024 * 1024) { try { unlinkSync(req.file.path); } catch {} return res.status(413).json({ error: "Pentru extragerea AI, fotografia trebuie să aibă cel mult 6 MB." }); }
  if (!req.file.mimetype.startsWith("image/")) { try { unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: "Extragerea AI acceptă fotografii. Pentru PDF folosește OCR-ul local." }); }
  if (!validUploadedFile(req.file)) { try { unlinkSync(req.file.path); } catch {} return res.status(400).json({ error: "Fotografia nu are un format valid." }); }
  try {
    const base64 = readFileSync(req.file.path).toString("base64");
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-6-luna", instructions: "Citește fotografia unei facturi din România. Extrage doar ce se vede și întoarce strict un obiect JSON cu cheile supplier,companyName,cui,invoiceNumber,series,issueDate,net,vat,total,items. Datele monetare sunt numere RON sau null; datele sunt YYYY-MM-DD sau șir gol. Nu inventa informații. Dacă nu ești sigur, lasă câmpul gol sau null.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Extrage câmpurile facturii. Utilizatorul va verifica și confirma înainte de salvare." }, { type: "input_image", image_url: "data:" + req.file.mimetype + ";base64," + base64 }] }], max_output_tokens: 900 }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "Serviciul AI nu a putut citi imaginea.");
    let output = result.output_text || "";
    const fence = String.fromCharCode(96).repeat(3);
    output = output.split(fence).join("").replace(/^\s*json/i, "").trim();
    let parsed;
    try { parsed = JSON.parse(output); } catch { throw new Error("Răspunsul AI nu a fost un JSON valid. Încearcă OCR-ul local sau completează manual."); }
    return res.json({ ...parsed, extractionMode: "ai", needsConfirmation: true });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error).slice(0, 280) });
  } finally { try { unlinkSync(req.file.path); } catch {} }
});

app.get("/api/invoices", (req, res) => {
  const q = `%${safeName(req.query.q, 100)}%`;
  const rows = db.prepare("SELECT i.*,e.category AS expense_category FROM invoices i LEFT JOIN expenses e ON e.invoice_id=i.id WHERE i.user_id=? AND (i.supplier LIKE ? OR i.invoice_number LIKE ? OR i.cui LIKE ?) ORDER BY i.added_at DESC LIMIT 500").all(req.user.id, q, q, q);
  res.json(rows.map((row) => rowMoney(row, ["net", "vat", "total"])));
});
app.post("/api/invoices", (req, res) => {
  const body = req.body || {};
  const supplier = safeName(body.supplier, 160);
  const invoiceNumber = safeName(body.invoiceNumber, 80);
  const expenseCategory = safeName(body.expenseCategory || "piese", 60);
  if (!supplier || !invoiceNumber) return res.status(400).json({ error: "Furnizorul și numărul facturii sunt obligatorii." });
  if (!expenseCategories.includes(expenseCategory)) return res.status(400).json({ error: "Alege o categorie validă pentru cheltuiala facturii." });
  if (body.issueDate && !isDate(body.issueDate)) return res.status(400).json({ error: "Data emiterii nu este validă." });
  if (!ownsDocument(req.user.id, body.documentId)) return res.status(400).json({ error: "Documentul atașat nu este accesibil acestui cont." });
  let net, vat, total;
  try { net = toCents(body.net); vat = toCents(body.vat); total = toCents(body.total); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (Math.abs(net + vat - total) > 1) return res.status(400).json({ error: "Totalul nu corespunde sumei fără TVA plus TVA." });
  const duplicate = db.prepare("SELECT id FROM invoices WHERE user_id=? AND lower(supplier)=lower(?) AND lower(invoice_number)=lower(?)").get(req.user.id, supplier, invoiceNumber);
  if (duplicate) return res.status(409).json({ error: "Factura pare duplicată: există deja acest furnizor și număr de factură.", duplicateId: duplicate.id });
  const now = nowIso(); const invoiceId = id(); const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO invoices (id,user_id,supplier,company_name,cui,invoice_number,series,issue_date,photographed_at,added_at,confirmed_at,net_cents,vat_cents,total_cents,document_id,items_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(invoiceId, req.user.id, supplier, safeName(body.companyName, 160), safeName(body.cui, 30), invoiceNumber,
      safeName(body.series, 30), body.issueDate || null, body.photographedAt || null, now, now, net, vat, total, body.documentId || null, JSON.stringify(items), now, now);
    const expenseId = id();
    db.prepare(`INSERT INTO expenses (id,user_id,category,title,expense_date,amount_cents,invoice_id,document_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(expenseId, req.user.id, expenseCategory, `Factura ${invoiceNumber} · ${supplier}`, today(), total, invoiceId, body.documentId || null, now, now);
    audit(req, "factură", invoiceId, "adăugată și confirmată", null, { supplier, invoiceNumber, total: fromCents(total) });
  });
  tx();
  res.status(201).json(rowMoney(db.prepare("SELECT * FROM invoices WHERE id=?").get(invoiceId), ["net", "vat", "total"]));
});
app.put("/api/invoices/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Factura nu a fost găsită." });
  const body = req.body || {}; const supplier = safeName(body.supplier, 160); const invoiceNumber = safeName(body.invoiceNumber, 80);
  const expenseCategory = safeName(body.expenseCategory || "piese", 60);
  let net, vat, total; try { net = toCents(body.net); vat = toCents(body.vat); total = toCents(body.total); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!supplier || !invoiceNumber || !expenseCategories.includes(expenseCategory) || Math.abs(net + vat - total) > 1) return res.status(400).json({ error: "Verifică furnizorul, numărul, categoria și totalurile TVA." });
  if (body.issueDate && !isDate(body.issueDate)) return res.status(400).json({ error: "Data emiterii nu este validă." });
  const duplicate = db.prepare("SELECT id FROM invoices WHERE user_id=? AND lower(supplier)=lower(?) AND lower(invoice_number)=lower(?) AND id<>?").get(req.user.id, supplier, invoiceNumber, old.id);
  if (duplicate) return res.status(409).json({ error: "Există deja o factură cu acest furnizor și număr." });
  const now = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE invoices SET supplier=?,company_name=?,cui=?,invoice_number=?,series=?,issue_date=?,net_cents=?,vat_cents=?,total_cents=?,items_json=?,updated_at=? WHERE id=?`)
      .run(supplier, safeName(body.companyName, 160), safeName(body.cui, 30), invoiceNumber, safeName(body.series, 30), body.issueDate || null, net, vat, total, JSON.stringify(Array.isArray(body.items) ? body.items.slice(0, 200) : []), now, old.id);
    db.prepare("UPDATE expenses SET category=?,title=?,amount_cents=?,updated_at=? WHERE invoice_id=?").run(expenseCategory, `Factura ${invoiceNumber} · ${supplier}`, total, now, old.id);
    audit(req, "factură", old.id, "modificată", rowMoney(old, ["net", "vat", "total"]), { supplier, invoiceNumber, total: fromCents(total) });
  })();
  res.json(rowMoney(db.prepare("SELECT * FROM invoices WHERE id=?").get(old.id), ["net", "vat", "total"]));
});
app.delete("/api/invoices/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Factura nu a fost găsită." });
  db.transaction(() => { db.prepare("DELETE FROM expenses WHERE invoice_id=?").run(old.id); db.prepare("DELETE FROM invoices WHERE id=?").run(old.id); audit(req, "factură", old.id, "ștearsă", rowMoney(old, ["net", "vat", "total"]), null); })();
  res.status(204).end();
});

app.get("/api/jobs", (req, res) => {
  const q = `%${safeName(req.query.q, 100)}%`;
  const rows = db.prepare("SELECT j.*,COALESCE(r.paid,0) AS paid_cents FROM jobs j LEFT JOIN (SELECT job_id,SUM(amount_cents) paid FROM receipts WHERE user_id=? AND job_id IS NOT NULL GROUP BY job_id) r ON r.job_id=j.id WHERE j.user_id=? AND (j.client LIKE ? OR j.plate LIKE ? OR j.description LIKE ?) ORDER BY j.work_date DESC LIMIT 500").all(req.user.id, req.user.id, q, q, q);
  res.json(rows.map((row) => rowMoney(row, ["labor", "amount", "paid"])));
});
app.post("/api/jobs/batch", (req, res) => {
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
  if (!jobs.length || jobs.length > 30) return res.status(400).json({ error: "Adaugă între una și 30 de lucrări de pe pagină." });
  if (!ownsDocument(req.user.id, req.body?.documentId)) return res.status(400).json({ error: "Documentul atașat nu aparține acestui cont." });
  const normalized = [];
  try {
    for (const b of jobs) {
      const workDate = b.workDate || today();
      const client = safeName(b.client, 140);
      const description = safeName(b.description, 700);
      const plate = safeName(b.plate, 20).toUpperCase();
      const amount = toCents(b.amount);
      const labor = toCents(b.labor || 0);
      if (!isDate(workDate) || !client || !description || !amount) throw new Error("Fiecare lucrare are nevoie de dată, client, descriere și sumă pozitivă.");
      if (!ownsEmployee(req.user.id, b.employeeId)) throw new Error("Mecanicul selectat nu aparține acestui cont.");
      normalized.push({ workDate, client, description, plate, amount, labor, vehicle: safeName(b.vehicle, 120), employeeId: b.employeeId || null });
    }
  } catch (error) { return res.status(400).json({ error: error.message }); }
  for (let i = 0; i < normalized.length; i += 1) {
    const current = normalized[i];
    if (current.plate) {
      const duplicate = db.prepare("SELECT id FROM jobs WHERE user_id=? AND work_date=? AND upper(plate)=? AND amount_cents=?").get(req.user.id, current.workDate, current.plate, current.amount);
      if (duplicate || normalized.slice(0, i).some((item) => item.plate === current.plate && item.workDate === current.workDate && item.amount === current.amount)) return res.status(409).json({ error: "Există deja o lucrare duplicată pentru acest număr, dată și sumă." });
    }
  }
  const now = nowIso();
  const created = db.transaction(() => normalized.map((job) => {
    const jobId = id();
    db.prepare("INSERT INTO jobs (id,user_id,work_date,client,vehicle,plate,description,labor_cents,amount_cents,payment_method,status,employee_id,document_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(jobId, req.user.id, job.workDate, job.client, job.vehicle, job.plate, job.description, job.labor, job.amount, "", "unpaid", job.employeeId, req.body.documentId || null, now, now);
    audit(req, "lucrare", jobId, "adăugată", null, { client: job.client, plate: job.plate, amount: fromCents(job.amount) });
    return rowMoney(db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId), ["labor", "amount"]);
  }))();
  res.status(201).json(created);
});
app.post("/api/jobs", (req, res) => {
  const b = req.body || {}; const workDate = b.workDate || today();
  if (!isDate(workDate) || !safeName(b.client, 140) || !safeName(b.description, 700)) return res.status(400).json({ error: "Data, clientul și descrierea lucrării sunt obligatorii." });
  let labor, amount; try { labor = toCents(b.labor || 0); amount = toCents(b.amount); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!amount) return res.status(400).json({ error: "Valoarea lucrării trebuie să fie mai mare decât zero." });
  if (!ownsEmployee(req.user.id, b.employeeId) || !ownsDocument(req.user.id, b.documentId)) return res.status(400).json({ error: "Mecanicul sau documentul atașat nu aparține acestui cont." });
  const plate = safeName(b.plate, 20).toUpperCase();
  const duplicate = plate && db.prepare("SELECT id FROM jobs WHERE user_id=? AND work_date=? AND upper(plate)=? AND amount_cents=?").get(req.user.id, workDate, plate, amount);
  if (duplicate) return res.status(409).json({ error: "Există deja o lucrare pentru acest număr, dată și sumă.", duplicateId: duplicate.id });
  const now = nowIso(); const jobId = id();
  db.prepare(`INSERT INTO jobs (id,user_id,work_date,client,vehicle,plate,description,labor_cents,amount_cents,payment_method,status,employee_id,document_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, req.user.id, workDate, safeName(b.client, 140), safeName(b.vehicle, 120), plate, safeName(b.description, 700), labor, amount, safeName(b.paymentMethod, 40), "unpaid", b.employeeId || null, b.documentId || null, now, now);
  audit(req, "lucrare", jobId, "adăugată", null, { client: safeName(b.client, 140), plate, amount: fromCents(amount) });
  res.status(201).json(rowMoney(db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId), ["labor", "amount"]));
});
app.put("/api/jobs/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Lucrarea nu a fost găsită." });
  const b = req.body || {}; let amount, labor; try { amount = toCents(b.amount); labor = toCents(b.labor || 0); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!isDate(b.workDate) || !safeName(b.client, 140) || !safeName(b.description, 700) || !amount) return res.status(400).json({ error: "Completează data, clientul, descrierea și o valoare validă." });
  if (!ownsEmployee(req.user.id, b.employeeId)) return res.status(400).json({ error: "Mecanicul nu aparține acestui cont." });
  const paid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS value FROM receipts WHERE job_id=?").get(old.id).value;
  if (paid > amount) return res.status(400).json({ error: "Valoarea nouă este mai mică decât plățile deja înregistrate." });
  const status = paid >= amount ? "paid" : paid > 0 ? "partial" : "unpaid";
  db.prepare("UPDATE jobs SET work_date=?,client=?,vehicle=?,plate=?,description=?,labor_cents=?,amount_cents=?,employee_id=?,status=?,updated_at=? WHERE id=?")
    .run(b.workDate, safeName(b.client, 140), safeName(b.vehicle, 120), safeName(b.plate, 20).toUpperCase(), safeName(b.description, 700), labor, amount, b.employeeId || null, status, nowIso(), old.id);
  audit(req, "lucrare", old.id, "modificată", rowMoney(old, ["labor", "amount"]), b);
  res.json(rowMoney(db.prepare("SELECT * FROM jobs WHERE id=?").get(old.id), ["labor", "amount"]));
});
app.delete("/api/jobs/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Lucrarea nu a fost găsită." });
  db.prepare("DELETE FROM jobs WHERE id=?").run(old.id);
  audit(req, "lucrare", old.id, "ștearsă", rowMoney(old, ["labor", "amount"]), null);
  res.status(204).end();
});

app.get("/api/expenses", (req, res) => res.json(list(req, "expenses", "expense_date", ["amount"])));
app.post("/api/expenses", (req, res) => {
  const b = req.body || {}; const category = safeName(b.category, 60); const title = safeName(b.title, 180); const date = b.date || today();
  if (!category || !title || !isDate(date)) return res.status(400).json({ error: "Categoria, descrierea și data sunt obligatorii." });
  let amount; try { amount = toCents(b.amount); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!amount) return res.status(400).json({ error: "Cheltuiala trebuie să fie mai mare decât zero." });
  if (!ownsDocument(req.user.id, b.documentId)) return res.status(400).json({ error: "Documentul atașat nu aparține acestui cont." });
  const duplicate = db.prepare("SELECT id FROM expenses WHERE user_id=? AND lower(title)=lower(?) AND expense_date=? AND amount_cents=?").get(req.user.id, title, date, amount);
  if (duplicate) return res.status(409).json({ error: "O cheltuială identică există deja în aceeași zi.", duplicateId: duplicate.id });
  const expenseId = id(); const now = nowIso();
  db.prepare("INSERT INTO expenses (id,user_id,category,title,expense_date,amount_cents,document_id,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(expenseId, req.user.id, category, title, date, amount, b.documentId || null, safeName(b.notes, 500), now, now);
  audit(req, "cheltuială", expenseId, "adăugată", null, { category, title, amount: fromCents(amount) });
  res.status(201).json(rowMoney(db.prepare("SELECT * FROM expenses WHERE id=?").get(expenseId), ["amount"]));
});
app.put("/api/expenses/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM expenses WHERE id=? AND user_id=? AND invoice_id IS NULL").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Cheltuiala nu a fost găsită sau este legată de o factură." });
  const b = req.body || {};
  const category = safeName(b.category, 60);
  const title = safeName(b.title, 180);
  const date = b.date || today();
  let amount;
  try { amount = toCents(b.amount); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!category || !title || !isDate(date) || !amount) return res.status(400).json({ error: "Verifică data, categoria, descrierea și suma cheltuielii." });
  db.prepare("UPDATE expenses SET category=?,title=?,expense_date=?,amount_cents=?,notes=?,updated_at=? WHERE id=?")
    .run(category, title, date, amount, safeName(b.notes, 500), nowIso(), old.id);
  audit(req, "cheltuială", old.id, "modificată", rowMoney(old, ["amount"]), { category, title, amount: fromCents(amount) });
  res.json(rowMoney(db.prepare("SELECT * FROM expenses WHERE id=?").get(old.id), ["amount"]));
});
app.delete("/api/expenses/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM expenses WHERE id=? AND user_id=? AND invoice_id IS NULL").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Cheltuiala nu a fost găsită sau este legată de o factură." });
  db.prepare("DELETE FROM expenses WHERE id=?").run(old.id); audit(req, "cheltuială", old.id, "ștearsă", rowMoney(old, ["amount"]), null); res.status(204).end();
});

app.get("/api/receipts", (req, res) => res.json(list(req, "receipts", "receipt_date", ["amount"])));
app.post("/api/receipts", (req, res) => {
  const b = req.body || {}; const date = b.date || today();
  if (!isDate(date) || !["numerar", "card", "transfer", "altul"].includes(b.method)) return res.status(400).json({ error: "Alege data și o metodă de plată validă." });
  let amount; try { amount = toCents(b.amount); } catch (error) { return res.status(400).json({ error: error.message }); }
  if (!amount) return res.status(400).json({ error: "Încasarea trebuie să fie mai mare decât zero." });
  const job = b.jobId ? db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(b.jobId, req.user.id) : null;
  if (b.jobId && !job) return res.status(400).json({ error: "Lucrarea asociată nu a fost găsită." });
  if (job) {
    const paid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS value FROM receipts WHERE job_id=?").get(job.id).value;
    if (paid + amount > job.amount_cents) return res.status(400).json({ error: "Încasarea depășește soldul rămas al lucrării." });
  }
  const receiptId = id(); const now = nowIso();
  db.prepare("INSERT INTO receipts (id,user_id,job_id,client,amount_cents,method,receipt_type,receipt_date,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(receiptId, req.user.id, job?.id || null, safeName(b.client || job?.client, 140), amount, b.method, b.type === "advance" ? "advance" : "payment", date, safeName(b.note, 400), now);
  if (job) {
    const paid = db.prepare("SELECT SUM(amount_cents) AS value FROM receipts WHERE job_id=?").get(job.id).value || 0;
    db.prepare("UPDATE jobs SET status=?,payment_method=?,updated_at=? WHERE id=?").run(paid >= job.amount_cents ? "paid" : "partial", b.method, now, job.id);
  }
  audit(req, "încasare", receiptId, "înregistrată", null, { client: safeName(b.client || job?.client, 140), amount: fromCents(amount), method: b.method });
  res.status(201).json(rowMoney(db.prepare("SELECT * FROM receipts WHERE id=?").get(receiptId), ["amount"]));
});
app.delete("/api/receipts/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM receipts WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Încasarea nu a fost găsită." });
  db.transaction(() => {
    db.prepare("DELETE FROM receipts WHERE id=?").run(old.id);
    if (old.job_id) {
      const job = db.prepare("SELECT amount_cents FROM jobs WHERE id=?").get(old.job_id);
      if (job) { const paid = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS n FROM receipts WHERE job_id=?").get(old.job_id).n; db.prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=?").run(paid >= job.amount_cents ? "paid" : paid ? "partial" : "unpaid", nowIso(), old.job_id); }
    }
    audit(req, "încasare", old.id, "ștearsă", rowMoney(old, ["amount"]), null);
  })(); res.status(204).end();
});

app.get("/api/employees", (req, res) => res.json(list(req, "employees", "created_at", ["fixed_salary"])));
app.post("/api/employees", (req, res) => {
  const b = req.body || {}; const name = safeName(b.name, 120);
  let fixed; try { fixed = toCents(b.fixedSalary || 0); } catch (error) { return res.status(400).json({ error: error.message }); }
  const percentage = Number(b.percentage || 0);
  if (name.length < 2 || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return res.status(400).json({ error: "Numele și un procent între 0 și 100 sunt necesare." });
  const employeeId = id(); const now = nowIso();
  db.prepare("INSERT INTO employees (id,user_id,name,role,fixed_salary_cents,percentage,active,created_at) VALUES (?,?,?,?,?,?,1,?)").run(employeeId, req.user.id, name, safeName(b.role, 100), fixed, percentage, now);
  audit(req, "angajat", employeeId, "adăugat", null, { name, fixedSalary: fromCents(fixed), percentage });
  res.status(201).json(rowMoney(db.prepare("SELECT * FROM employees WHERE id=?").get(employeeId), ["fixed_salary"]));
});
app.put("/api/employees/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM employees WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Angajatul nu a fost găsit." });
  const b = req.body || {};
  const name = safeName(b.name, 120);
  let fixed;
  try { fixed = toCents(b.fixedSalary || 0); } catch (error) { return res.status(400).json({ error: error.message }); }
  const percentage = Number(b.percentage || 0);
  if (name.length < 2 || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return res.status(400).json({ error: "Numele și un procent între 0 și 100 sunt necesare." });
  db.prepare("UPDATE employees SET name=?,role=?,fixed_salary_cents=?,percentage=?,active=? WHERE id=?")
    .run(name, safeName(b.role, 100), fixed, percentage, b.active === false ? 0 : 1, old.id);
  audit(req, "angajat", old.id, "date modificate", rowMoney(old, ["fixed_salary"]), { name, fixedSalary: fromCents(fixed), percentage });
  res.json(rowMoney(db.prepare("SELECT * FROM employees WHERE id=?").get(old.id), ["fixed_salary"]));
});
app.patch("/api/employees/:id", (req, res) => {
  const old = db.prepare("SELECT * FROM employees WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: "Angajatul nu a fost găsit." });
  const active = Boolean(req.body?.active);
  db.prepare("UPDATE employees SET active=? WHERE id=?").run(active ? 1 : 0, old.id);
  audit(req, "angajat", old.id, active ? "reactivat" : "dezactivat", { active: Boolean(old.active) }, { active });
  res.json({ id: old.id, active });
});
app.get("/api/salaries", (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : today().slice(0, 7);
  const entries = db.prepare(`SELECT s.*,e.name AS employee_name FROM salary_entries s JOIN employees e ON e.id=s.employee_id
    WHERE s.user_id=? AND substr(s.entry_date,1,7)=? ORDER BY s.entry_date DESC`).all(req.user.id, month).map((r) => rowMoney(r, ["amount"]));
  const staff = db.prepare("SELECT * FROM employees WHERE user_id=? ORDER BY name").all(req.user.id).map((e) => ({ ...rowMoney(e, ["fixed_salary"]), active: Boolean(e.active) }));
  res.json({ entries, employees: staff });
});
app.post("/api/salaries", (req, res) => {
  const b = req.body || {}; const employee = db.prepare("SELECT id FROM employees WHERE id=? AND user_id=?").get(b.employeeId, req.user.id);
  let amount; try { amount = toCents(b.amount); } catch (error) { return res.status(400).json({ error: error.message }); }
  const date = b.date || today();
  if (!employee || !["advance", "payment"].includes(b.type) || !isDate(date) || !amount) return res.status(400).json({ error: "Angajatul, tipul, data și suma sunt obligatorii." });
  const entryId = id(); const now = nowIso();
  db.prepare("INSERT INTO salary_entries (id,user_id,employee_id,entry_type,amount_cents,entry_date,note,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(entryId, req.user.id, employee.id, b.type, amount, date, safeName(b.note, 350), now);
  audit(req, "salariu", entryId, b.type === "advance" ? "avans înregistrat" : "plată înregistrată", null, { amount: fromCents(amount) });
  res.status(201).json(rowMoney(db.prepare("SELECT * FROM salary_entries WHERE id=?").get(entryId), ["amount"]));
});

app.post("/api/documents", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Alege un fișier înainte de încărcare." });
  if (!validUploadedFile(req.file)) { unlinkSync(req.file.path); return res.status(400).json({ error: "Conținutul fișierului nu corespunde unei fotografii sau unui PDF valid." }); }
  const category = ["facturi", "caiet", "documente", "rapoarte"].includes(req.body?.category) ? req.body.category : "documente";
  const doc = insertDocument(req, req.file, category);
  await maybeArchive(doc);
  const updated = db.prepare("SELECT * FROM documents WHERE id=?").get(doc.id);
  res.status(201).json({ id: updated.id, name: updated.original_name, category: updated.category, type: updated.mime_type,
    size: updated.size_bytes, uploadedAt: updated.uploaded_at, archiveStatus: updated.archive_status, url: `/api/documents/${updated.id}` });
});
app.get("/api/documents", (req, res) => {
  const rows = db.prepare("SELECT id,category,original_name,mime_type,size_bytes,uploaded_at,remote_path,archive_status,archive_error FROM documents WHERE user_id=? ORDER BY uploaded_at DESC LIMIT 500").all(req.user.id);
  res.json(rows.map((r) => ({ id: r.id, category: r.category, name: r.original_name, type: r.mime_type, size: r.size_bytes, uploadedAt: r.uploaded_at, remotePath: r.remote_path, archiveStatus: r.archive_status, archiveError: r.archive_error, url: `/api/documents/${r.id}` })));
});
app.get("/api/documents/:id", (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!doc || !existsSync(doc.local_path)) return res.status(404).json({ error: "Documentul nu există." });
  res.setHeader("Content-Type", doc.mime_type); res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`); res.sendFile(doc.local_path);
});
app.get("/api/archive/settings", (req, res) => res.json(readArchiveSettings(req.user.id)));
app.put("/api/archive/settings", (req, res) => {
  try {
    const before = readArchiveSettings(req.user.id);
    const after = saveArchiveSettings(req.user.id, req.body || {});
    audit(req, "arhivare FTP/SFTP", "settings", "configurație modificată", before, after);
    res.json(after);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post("/api/archive/test", async (req, res) => {
  try { res.json(await testArchiveConnection(req.user.id)); } catch (error) { res.status(400).json({ error: `Conexiunea nu a reușit: ${String(error.message || error).slice(0, 240)}` }); }
});
app.post("/api/archive/:id/retry", async (req, res) => {
  try { res.json(await archiveDocument(req.params.id, req.user.id)); } catch (error) { res.status(400).json({ error: String(error.message || error).slice(0, 300) }); }
});

const defaultSettings = { sarcasmLevel: "NEMILOS", notifications: true, sounds: false, animation: "discrete", customRoasts: [],
  includeJobRevenue: true, eligibleExpenseCategories: ["piese", "consumabile", "utilități", "chirie", "combustibil", "scule și echipamente", "transport", "alte cheltuieli"] };
app.get("/api/settings", (req, res) => {
  const settings = { ...defaultSettings };
  for (const key of Object.keys(defaultSettings)) settings[key] = getSetting(req.user.id, key, defaultSettings[key]);
  res.json({ profile: { name: req.user.name, email: req.user.email }, preferences: settings, archive: readArchiveSettings(req.user.id) });
});
app.put("/api/settings", (req, res) => {
  const b = req.body || {};
  const before = Object.fromEntries(Object.keys(defaultSettings).map((key) => [key, getSetting(req.user.id, key, defaultSettings[key])]));
  const level = ["NORMAL", "OBRAZNIC", "NEMILOS"].includes(b.sarcasmLevel) ? b.sarcasmLevel : "NEMILOS";
  saveSetting(req.user.id, "sarcasmLevel", level);
  saveSetting(req.user.id, "notifications", Boolean(b.notifications));
  saveSetting(req.user.id, "sounds", Boolean(b.sounds));
  saveSetting(req.user.id, "animation", ["none", "discrete", "full"].includes(b.animation) ? b.animation : "discrete");
  saveSetting(req.user.id, "includeJobRevenue", b.includeJobRevenue !== false);
  saveSetting(req.user.id, "customRoasts", Array.isArray(b.customRoasts) ? b.customRoasts.map((x) => safeName(x, 240)).filter(Boolean).slice(0, 300) : []);
  const categories = Array.isArray(b.eligibleExpenseCategories) ? b.eligibleExpenseCategories.map((x) => safeName(x, 60)).filter(Boolean).slice(0, 30) : defaultSettings.eligibleExpenseCategories;
  saveSetting(req.user.id, "eligibleExpenseCategories", categories);
  const after = Object.fromEntries(Object.keys(defaultSettings).map((key) => [key, getSetting(req.user.id, key, defaultSettings[key])]));
  audit(req, "setări", "preferences", "preferințe actualizate", before, after);
  res.json({ success: true });
});

app.get("/api/activity", (req, res) => {
  const rows = db.prepare("SELECT * FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT 250").all(req.user.id);
  res.json(rows.map((row) => ({ id: row.id, type: row.entity_type, entityId: row.entity_id, action: row.action, actor: row.actor_name, date: row.created_at,
    oldValue: row.old_value_json ? JSON.parse(row.old_value_json) : null, newValue: row.new_value_json ? JSON.parse(row.new_value_json) : null })));
});
app.get("/api/calendar", (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  const [invoiceStart, invoiceEnd] = utcBoundsForBucharestDates(date, date);
  const invoices = db.prepare("SELECT id,supplier AS title,total_cents,added_at AS date FROM invoices WHERE user_id=? AND added_at>=? AND added_at<?").all(req.user.id, invoiceStart, invoiceEnd).map((r) => ({ ...r, type: "Factură", amount: fromCents(r.total_cents) }));
  const jobs = db.prepare("SELECT id,client AS title,amount_cents,work_date AS date FROM jobs WHERE user_id=? AND work_date=?").all(req.user.id, date).map((r) => ({ ...r, type: "Lucrare", amount: fromCents(r.amount_cents) }));
  const receipts = db.prepare("SELECT id,client AS title,amount_cents,receipt_date AS date FROM receipts WHERE user_id=? AND receipt_date=?").all(req.user.id, date).map((r) => ({ ...r, type: "Încasare", amount: fromCents(r.amount_cents) }));
  const expenses = db.prepare("SELECT id,title,amount_cents,expense_date AS date FROM expenses WHERE user_id=? AND expense_date=?").all(req.user.id, date).map((r) => ({ ...r, type: "Cheltuială", amount: fromCents(r.amount_cents) }));
  const activity = db.prepare("SELECT id,entity_type AS type,action AS title,created_at AS date FROM audit_log WHERE user_id=? AND created_at>=? AND created_at<? ORDER BY created_at DESC").all(req.user.id, invoiceStart, invoiceEnd);
  res.json({ date, entries: [...invoices, ...jobs, ...receipts, ...expenses, ...activity].sort((a, b) => String(a.date).localeCompare(String(b.date))) });
});

app.get("/api/reports/export", (req, res) => {
  if (req.query.range === "custom" && (!isDate(req.query.from) || !isDate(req.query.to) || req.query.from > req.query.to)) return res.status(400).json({ error: "Perioada personalizată nu conține date valide." });
  const data = rowsForPeriod(req.user.id, req.query);
  const format = req.query.format === "pdf" ? "pdf" : "xlsx";
  const period = `${data.period.start}_${data.period.end}`;
  if (format === "xlsx") {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Indicator", "Valoare RON"], ["Facturi adăugate", data.invoices.count], ["Facturi fără TVA", data.invoices.net], ["TVA", data.invoices.vat], ["Total facturi cu TVA", data.invoices.total], ["Valoare lucrări", data.service.value], ["Încasări reale", data.receipts.value], ["Cheltuieli", data.expenses], ["Obligații salariale", data.salaries.due], ["Profit estimat", data.profit], ["Restanțe lucrări", data.receivables.value]]), "Rezumat");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.invoiceRows.map((r) => ({ furnizor: r.supplier, numar: r.invoice_number, dataAdaugarii: r.added_at, faraTVA: fromCents(r.net_cents), TVA: fromCents(r.vat_cents), total: fromCents(r.total_cents) }))), "Facturi");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.jobRows.map((r) => ({ data: r.work_date, client: r.client, numarAuto: r.plate, descriere: r.description, suma: fromCents(r.amount_cents), status: r.status }))), "Caietul");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.expenseRows.map((r) => ({ data: r.expense_date, categorie: r.category, descriere: r.title, suma: fromCents(r.amount_cents) }))), "Cheltuieli");
    res.setHeader("Content-Disposition", `attachment; filename="nicubank_${period}.xlsx"`);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
    return;
  }
  const pdf = new PDFDocument({ size: "A4", margin: 46 });
  res.setHeader("Content-Disposition", `attachment; filename="nicubank_${period}.pdf"`); res.setHeader("Content-Type", "application/pdf");
  pdf.pipe(res); pdf.fontSize(20).text("NICUBANK · Raport financiar", { continued: false }); pdf.moveDown(0.5).fontSize(10).text(`Perioada: ${data.period.start} — ${data.period.end}`); pdf.moveDown();
  for (const [label, value] of [["Facturi adăugate", data.invoices.count], ["Valoare facturi fără TVA", data.invoices.net], ["TVA", data.invoices.vat], ["Total facturi cu TVA", data.invoices.total], ["Valoare lucrări", data.service.value], ["Încasări efective", data.receipts.value], ["Cheltuieli", data.expenses], ["Obligații salariale", data.salaries.due], ["Profit estimat", data.profit], ["Restanțe", data.receivables.value]]) pdf.fontSize(11).text(`${label}: ${typeof value === "number" && !Number.isInteger(value) ? value.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) : value}${label.includes("adăugate") ? "" : " lei"}`);
  pdf.end();
});
app.get("/api/backup", (req, res) => {
  const folder = resolve(process.env.NICUBANK_DATA_DIR || resolve(here, "data"), "backups"); mkdirSync(folder, { recursive: true });
  const target = resolve(folder, `nicubank-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  res.download(target, basename(target));
});
app.use("/api", (error, _req, res, _next) => res.status(error.status || 400).json({ error: error.message || "Cererea nu a putut fi procesată." }));
app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint API negăsit." }));

const server = createServer(app);
const production = process.env.NODE_ENV === "production";
if (production) {
  app.use(express.static(resolve(appRoot, "dist/client")));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(appRoot, "dist/client/index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => console.log(`NICUBANK este disponibil local la http://${host}:${port}`));
