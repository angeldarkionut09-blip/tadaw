import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { randomBytes, randomUUID, scryptSync, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

test("HTTP API: auth, CRUD, tenant isolation, exports, archive and frontend assets", { timeout: 120_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "nicubank-api-"));
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { ...process.env, NICUBANK_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production", OPENAI_API_KEY: "", SETUP_TOKEN: "smoke-test-setup-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => log.push(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => log.push(chunk));
  let cookie = "";
  let checks = 0;
  const expectStatus = (response, status, label) => {
    assert.equal(response.status, status, `${label}: expected HTTP ${status}, got ${response.status}; body=${JSON.stringify(response.data)}`);
    checks += 1;
    return response;
  };
  const check = (condition, label) => {
    assert.ok(condition, label);
    checks += 1;
  };
  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const requestOptions = { method: options.method || "GET", headers };
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.form) requestOptions.body = options.form;
    else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestOptions.body = JSON.stringify(options.body);
    }
    const response = await fetch(base + path, requestOptions);
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json() : type.startsWith("text/") || type.includes("javascript") ? await response.text() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, data };
  }
  const upload = async (cookieValue, name, bytes, mime = "image/png", category = "documente") => {
    const form = new FormData();
    form.append("category", category);
    form.append("file", new Blob([bytes], { type: mime }), name);
    return request("/api/documents", { method: "POST", cookie: cookieValue, form });
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode}): ${log.join("")}`);
      try {
        const response = await fetch(base + "/api/session");
        if (response.ok) { ready = true; break; }
      } catch {}
      await wait(250);
    }
    assert.ok(ready, `Server did not become ready: ${log.join("")}`);

    await t.test("public auth, session and frontend assets", async () => {
      let r = await request("/api/session");
      expectStatus(r, 200, "initial session"); check(r.data.needsSetup && !r.data.authenticated, "new database asks for setup");
      r = await request("/api/summary"); expectStatus(r, 401, "private route without session");
      r = await request("/api/summary", { cookie: "nicubank_session=%" }); expectStatus(r, 401, "malformed cookie is rejected safely");
      r = await request("/api/auth/setup", { method: "POST", body: { name: "Nicu", email: "nicu@example.test", password: "Correct-Horse-2026!" } }); expectStatus(r, 403, "online setup requires the setup token");
      r = await request("/api/auth/setup", { method: "POST", body: { setupToken: "wrong-token", name: "Nicu", email: "nicu@example.test", password: "Correct-Horse-2026!" } }); expectStatus(r, 403, "wrong setup token is denied");
      r = await request("/api/auth/setup", { method: "POST", body: { setupToken: "smoke-test-setup-token", name: "Nicu", email: "bad", password: "short" } }); expectStatus(r, 400, "invalid setup input with correct token");
      r = await request("/api/auth/setup", { method: "POST", body: { setupToken: "smoke-test-setup-token", name: "Nicu Test", email: "nicu@example.test", password: "Correct-Horse-2026!" } }); expectStatus(r, 201, "first account setup");
      cookie = r.headers.get("set-cookie")?.split(";")[0] || "";
      check(Boolean(cookie), "setup returns a session cookie");
      check(/HttpOnly/i.test(r.headers.get("set-cookie")) && /SameSite=Strict/i.test(r.headers.get("set-cookie")), "session cookie is HttpOnly and SameSite Strict");
      r = await request("/api/auth/setup", { method: "POST", body: { name: "Other", email: "other@example.test", password: "Correct-Horse-2026!" } }); expectStatus(r, 409, "second public setup is refused");
      r = await request("/api/session", { cookie }); expectStatus(r, 200, "authenticated session"); check(r.data.authenticated && r.data.user.email === "nicu@example.test", "session is bound to the configured user");
      r = await request("/api/auth/login", { method: "POST", body: { email: "nicu@example.test", password: "incorrect" } }); expectStatus(r, 401, "wrong password");
      r = await request("/api/auth/login", { method: "POST", body: { email: "nicu@example.test", password: "Correct-Horse-2026!" } }); expectStatus(r, 200, "valid login");
      cookie = r.headers.get("set-cookie")?.split(";")[0] || cookie;
      r = await request("/"); expectStatus(r, 200, "production frontend shell"); check(String(r.data).includes("NicuBank"), "frontend shell contains the app title");
      const scriptPath = String(r.data).match(/src="([^"]+\.js)"/)?.[1];
      check(Boolean(scriptPath), "production shell references its compiled frontend bundle");
      r = await request(scriptPath); expectStatus(r, 200, "compiled production frontend bundle"); check(String(r.data).includes("/api/summary"), "production frontend bundle contains its backend calls");
      const frontendSource = readFileSync(join(root, "src/App.jsx"), "utf8");
      const backendSource = readFileSync(join(root, "server/index.js"), "utf8");
      for (const route of ["/api/session", "/api/auth/setup", "/api/auth/login", "/api/auth/logout", "/api/summary", "/api/integrations", "/api/bot/ask", "/api/ocr/ai", "/api/invoices", "/api/jobs", "/api/jobs/batch", "/api/expenses", "/api/receipts", "/api/employees", "/api/salaries", "/api/documents", "/api/archive/settings", "/api/archive/test", "/api/settings", "/api/activity", "/api/calendar"]) {
        check(frontendSource.includes(route) && backendSource.includes(route), `frontend and backend both define ${route}`);
      }
      check(frontendSource.includes("if (!response.ok) throw new Error(payload.error"), "frontend converts API error responses into user-visible messages");
      check(backendSource.includes('res.status(error.status || 400).json({ error:'), "backend returns JSON error responses");
      r = await request("/assets/nicubank-mark.jpg"); expectStatus(r, 200, "official logo asset"); check(r.headers.get("content-type")?.includes("image/jpeg"), "logo is served as JPEG");
    });

    const todayResult = await request("/api/calendar", { cookie });
    expectStatus(todayResult, 200, "calendar current day");
    const today = todayResult.data.date;
    const todayDate = new Date(`${today}T00:00:00.000Z`);
    todayDate.setUTCDate(todayDate.getUTCDate() - 10);
    const olderDate = todayDate.toISOString().slice(0, 10);

    await t.test("list endpoints and local assistant", async () => {
      for (const path of ["/api/summary?range=month", "/api/integrations", "/api/invoices", "/api/jobs", "/api/expenses", "/api/receipts", "/api/employees", "/api/salaries", "/api/documents", "/api/archive/settings", "/api/settings", "/api/activity", `/api/calendar?date=${today}`, "/api/reports/export?format=xlsx&range=month"]) {
        const r = await request(path, { cookie });
        expectStatus(r, 200, `GET ${path}`);
      }
      let r = await request("/api/bot/ask", { method: "POST", cookie, body: { question: "" } }); expectStatus(r, 400, "empty assistant question");
      r = await request("/api/bot/ask", { method: "POST", cookie, body: { question: "Cât am încasat azi?" } }); expectStatus(r, 200, "local assistant response"); check(r.data.mode === "local" && typeof r.data.answer === "string", "assistant uses local calculated data without an API key");
      r = await request("/api/summary?range=custom&from=2026-02-30&to=2026-03-01", { cookie }); expectStatus(r, 400, "invalid custom summary dates");
      r = await request("/api/reports/export?format=pdf&range=custom&from=2026-11-10&to=2026-11-01", { cookie }); expectStatus(r, 400, "reversed custom export dates");
      r = await request("/api/not-a-route", { cookie }); expectStatus(r, 404, "unknown API route"); check(r.data.error === "Endpoint API negăsit.", "unknown API route returns a JSON error");
    });

    let employeeId;
    await t.test("employee and salary endpoints", async () => {
      let r = await request("/api/employees", { method: "POST", cookie, body: { name: "Mecanic Test", role: "Mecanic", fixedSalary: 900, percentage: 10 } }); expectStatus(r, 201, "create employee");
      employeeId = r.data.id; check(r.data.fixed_salary === 900 && r.data.percentage === 10, "employee salary and percentage are returned");
      r = await request("/api/employees", { method: "POST", cookie, body: { name: "Invalid", percentage: 101 } }); expectStatus(r, 400, "invalid employee percentage");
      r = await request(`/api/employees/${employeeId}`, { method: "PUT", cookie, body: { name: "Mecanic Test", role: "Mecanic", fixedSalary: 900, percentage: 10 } }); expectStatus(r, 200, "update employee");
      r = await request(`/api/employees/${employeeId}`, { method: "PATCH", cookie, body: { active: false } }); expectStatus(r, 200, "deactivate employee"); check(r.data.active === false, "deactivation is persisted");
      r = await request(`/api/employees/${employeeId}`, { method: "PATCH", cookie, body: { active: true } }); expectStatus(r, 200, "reactivate employee");
    });

    let invoiceId;
    await t.test("invoice CRUD and linked expense", async () => {
      const invoice = { supplier: "Test Piese SRL", companyName: "Test Piese", cui: "RO123456", invoiceNumber: "T-100", issueDate: today, net: 100, vat: 21, total: 121, expenseCategory: "piese", items: [{ description: "Filtru", quantity: 1, unitPrice: 100, total: 100 }] };
      let r = await request("/api/invoices", { method: "POST", cookie, body: invoice }); expectStatus(r, 201, "create invoice"); invoiceId = r.data.id;
      r = await request("/api/invoices", { method: "POST", cookie, body: invoice }); expectStatus(r, 409, "duplicate invoice");
      r = await request("/api/invoices", { method: "POST", cookie, body: { ...invoice, supplier: "Bad Date SRL", invoiceNumber: "BAD-1", issueDate: "2026-02-30" } }); expectStatus(r, 400, "invalid invoice date");
      r = await request("/api/invoices", { method: "POST", cookie, body: { ...invoice, supplier: "Bad Sum SRL", invoiceNumber: "BAD-2", total: 122 } }); expectStatus(r, 400, "invoice VAT sum mismatch");
      r = await request(`/api/invoices/${invoiceId}`, { method: "PUT", cookie, body: { ...invoice, net: 110, vat: 23, total: 133 } }); expectStatus(r, 200, "update invoice"); check(r.data.total === 133, "invoice update returns updated totals");
      r = await request("/api/invoices", { cookie }); expectStatus(r, 200, "list invoices"); check(r.data.some((row) => row.id === invoiceId && row.expense_category === "piese"), "invoice list includes linked expense category");
    });

    let jobId;
    let batchIds = [];
    await t.test("service jobs and receipts", async () => {
      const job = { workDate: today, client: "Client Test", vehicle: "Dacia", plate: "TEST-001", description: "Revizie API", labor: 200, amount: 500, paymentMethod: "numerar", employeeId };
      let r = await request("/api/jobs", { method: "POST", cookie, body: job }); expectStatus(r, 201, "create job"); jobId = r.data.id;
      r = await request("/api/jobs", { method: "POST", cookie, body: job }); expectStatus(r, 409, "duplicate job");
      r = await request("/api/jobs", { method: "POST", cookie, body: { ...job, plate: "TEST-ERR", description: "", amount: -2 } }); expectStatus(r, 400, "invalid job data");
      r = await request(`/api/jobs/${jobId}`, { method: "PUT", cookie, body: { ...job, description: "Revizie API actualizată" } }); expectStatus(r, 200, "update job");
      r = await request("/api/jobs/batch", { method: "POST", cookie, body: { jobs: [{ workDate: olderDate, client: "Batch A", description: "Lucrare A", amount: 100 }, { workDate: olderDate, client: "Batch B", description: "Lucrare B", amount: 75 }] } }); expectStatus(r, 201, "batch job import"); batchIds = r.data.map((row) => row.id); check(batchIds.length === 2, "batch import returns both jobs");
      r = await request("/api/jobs/batch", { method: "POST", cookie, body: { jobs: [{ workDate: olderDate, client: "Duplicate A", plate: "BATCH-1", description: "Duplicat", amount: 80 }, { workDate: olderDate, client: "Duplicate B", plate: "BATCH-1", description: "Duplicat", amount: 80 }] } }); expectStatus(r, 409, "duplicate batch jobs");
      r = await request("/api/jobs", { cookie }); expectStatus(r, 200, "list jobs"); check(r.data.some((row) => row.id === jobId), "job appears in list");
      r = await request("/api/receipts", { method: "POST", cookie, body: { date: today, jobId, method: "numerar", amount: 200, note: "Plată parțială" } }); expectStatus(r, 201, "create partial receipt");
      r = await request("/api/receipts", { method: "POST", cookie, body: { date: today, jobId, method: "card", amount: 301 } }); expectStatus(r, 400, "receipt cannot exceed remaining balance");
      r = await request("/api/receipts", { method: "POST", cookie, body: { date: today, method: "card", client: "Client fără lucrare", amount: 15 } }); expectStatus(r, 201, "create standalone receipt");
      r = await request("/api/jobs", { cookie }); expectStatus(r, 200, "job list after receipt"); check(r.data.find((row) => row.id === jobId)?.status === "partial", "partial receipt updates job status");
      r = await request("/api/receipts", { cookie }); expectStatus(r, 200, "list receipts"); check(r.data.length === 2, "both receipts are listed");
    });

    let expenseId;
    await t.test("expenses, financial calculations and salary payment", async () => {
      let r = await request("/api/expenses", { method: "POST", cookie, body: { category: "alte cheltuieli", title: "Consumabil test", date: today, amount: 55 } }); expectStatus(r, 201, "create expense"); expenseId = r.data.id;
      r = await request("/api/expenses", { method: "POST", cookie, body: { category: "alte cheltuieli", title: "Consumabil test", date: today, amount: 55 } }); expectStatus(r, 409, "duplicate expense");
      r = await request("/api/expenses", { method: "POST", cookie, body: { category: "alte cheltuieli", title: "Invalid", date: today, amount: -10 } }); expectStatus(r, 400, "negative expense rejected");
      r = await request(`/api/expenses/${expenseId}`, { method: "PUT", cookie, body: { category: "alte cheltuieli", title: "Consumabil test actualizat", date: today, amount: 60 } }); expectStatus(r, 200, "update expense");
      r = await request("/api/expenses", { cookie }); expectStatus(r, 200, "list expenses"); check(r.data.some((row) => row.id === expenseId && row.amount === 60), "updated expense appears in list");
      r = await request("/api/salaries", { method: "POST", cookie, body: { employeeId, type: "payment", date: today, amount: 50, note: "Plată test" } }); expectStatus(r, 201, "record salary payment");
      r = await request("/api/salaries", { cookie }); expectStatus(r, 200, "list monthly salaries"); check(r.data.entries.some((entry) => entry.amount === 50 && entry.employee_id === employeeId), "salary payment is persisted");
      const summary = await request("/api/summary?range=month", { cookie }); expectStatus(summary, 200, "month summary with test data");
      check(summary.data.invoices.count === 1 && summary.data.invoices.total === 133, "invoice totals reflect the edited invoice");
      check(summary.data.service.value === 500 && summary.data.receipts.value === 215, "service revenue is separate from actual receipts");
      check(summary.data.expenses === 193 && summary.data.eligibleExpenses === 193, "invoice and manual costs are counted once");
      const day = new Date(`${today}T00:00:00.000Z`).getUTCDate();
      const monthDays = new Date(Date.UTC(new Date(today).getUTCFullYear(), new Date(today).getUTCMonth() + 1, 0)).getUTCDate();
      const fixedCents = Math.round(90000 * day / monthDays);
      const percentageCents = Math.round((50000 - 19300) * 10 / 100);
      const dueCents = fixedCents + percentageCents;
      check(Math.round(summary.data.salaries.due * 100) === dueCents, "fixed salary is prorated and percentage salary uses revenue after allocated costs");
      check(Math.round(summary.data.salaries.paid * 100) === 5000, "salary payments reduce outstanding obligations");
      check(Math.round(summary.data.profit * 100) === 50000 - 19300 - dueCents, "profit calculation reconciles to eligible revenue, costs and salary");
      const dayLog = await request(`/api/calendar?date=${today}`, { cookie }); expectStatus(dayLog, 200, "calendar day with transactions");
      check(dayLog.data.entries.some((entry) => entry.type === "Factură") && dayLog.data.entries.some((entry) => entry.type === "Încasare"), "calendar includes invoice and receipt events");
      const activity = await request("/api/activity", { cookie }); expectStatus(activity, 200, "activity audit log");
      check(activity.data.some((entry) => entry.entityId === invoiceId && entry.oldValue && entry.newValue), "audit log stores old and new invoice values");
    });

    let docId;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XuoAAAAASUVORK5CYII=", "base64");
    await t.test("uploads, OCR, protected files and archive errors", async () => {
      let r = await upload(cookie, "document-test.png", png, "image/png", "documente"); expectStatus(r, 201, "upload valid PNG"); docId = r.data.id;
      r = await upload(cookie, "bad.png", Buffer.from("not a png"), "image/png"); expectStatus(r, 400, "reject invalid file signature");
      r = await request("/api/documents", { cookie }); expectStatus(r, 200, "list documents"); check(r.data.some((doc) => doc.id === docId && doc.archiveStatus === "local_only"), "document is retained locally without FTP credentials");
      r = await request(`/api/documents/${docId}`, { cookie }); expectStatus(r, 200, "download owned document"); check(r.headers.get("content-type") === "image/png" && r.data.length === png.length, "download serves the original file bytes");
      r = await request("/api/documents/does-not-exist", { cookie }); expectStatus(r, 404, "missing document");
      r = await request("/api/ocr/ai", { method: "POST", cookie, form: (() => { const f = new FormData(); f.append("file", new Blob([png], { type: "image/png" }), "invoice.png"); return f; })() }); expectStatus(r, 503, "AI OCR reports missing API key");
      r = await request("/api/archive/settings", { method: "PUT", cookie, body: { protocol: "sftp", host: "", port: 22, username: "", password: "", rootDirectory: "/NICUBANK", autoUpload: false } }); expectStatus(r, 200, "save empty archive settings");
      check(!("password" in r.data) && !r.data.hasPassword, "archive password is not returned to the frontend");
      r = await request("/api/archive/settings", { cookie }); expectStatus(r, 200, "read archive settings"); check(!("password" in r.data), "archive settings never expose the password");
      r = await request("/api/archive/test", { method: "POST", cookie, body: {} }); expectStatus(r, 400, "archive connection gives actionable error without credentials");
      r = await request("/api/archive/missing-document/retry", { method: "POST", cookie, body: {} }); expectStatus(r, 400, "archive retry for missing document");
    });

    let secondCookie;
    let secondInvoiceId;
    let secondEmployeeId;
    let secondJobId;
    let secondDocId;
    await t.test("settings, reports, backup and tenant authorization", async () => {
      let r = await request("/api/settings", { cookie }); expectStatus(r, 200, "read settings");
      r = await request("/api/settings", { method: "PUT", cookie, body: { sarcasmLevel: "NORMAL", notifications: false, sounds: true, animation: "none", includeJobRevenue: true, customRoasts: ["Test personalizat"], eligibleExpenseCategories: ["piese", "alte cheltuieli"] } }); expectStatus(r, 200, "update preferences");
      r = await request("/api/settings", { cookie }); expectStatus(r, 200, "read updated settings"); check(r.data.preferences.notifications === false && r.data.preferences.customRoasts[0] === "Test personalizat", "user settings persist");
      r = await request("/api/reports/export?format=pdf&range=month", { cookie }); expectStatus(r, 200, "PDF report export"); check(r.headers.get("content-type")?.includes("application/pdf") && r.data.length > 200, "PDF export contains a document");
      r = await request("/api/reports/export?format=xlsx&range=month", { cookie }); expectStatus(r, 200, "XLSX report export"); check(r.headers.get("content-type")?.includes("spreadsheetml") && r.data.subarray(0, 2).toString() === "PK", "XLSX export is a ZIP workbook");
      r = await request("/api/backup", { cookie }); expectStatus(r, 200, "SQLite backup download"); check(r.data.subarray(0, 15).toString() === "SQLite format 3", "backup is a SQLite database");

      const Database = (await import("better-sqlite3")).default;
      const db = new Database(join(dataDir, "nicubank.sqlite"));
      const userId = randomUUID(); const token = randomBytes(32).toString("base64url"); const salt = randomBytes(16).toString("hex");
      const passwordHash = `${salt}:${scryptSync("Second-User-Test-2026!", salt, 64).toString("hex")}`;
      const now = new Date().toISOString();
      db.prepare("INSERT INTO users (id,name,email,password_hash,created_at) VALUES (?,?,?,?,?)").run(userId, "Tenant B", "tenant-b@example.test", passwordHash, now);
      db.prepare("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)").run(randomUUID(), userId, createHash("sha256").update(token).digest("hex"), now, new Date(Date.now() + 86400000).toISOString());
      db.close();
      secondCookie = `nicubank_session=${token}`;

      const secondInvoice = await request("/api/invoices", { method: "POST", cookie: secondCookie, body: { supplier: "Tenant B SRL", invoiceNumber: "B-1", net: 10, vat: 0, total: 10, expenseCategory: "piese" } }); expectStatus(secondInvoice, 201, "second tenant can create own invoice"); secondInvoiceId = secondInvoice.data.id;
      r = await request("/api/invoices", { cookie }); expectStatus(r, 200, "tenant A invoice list"); check(!r.data.some((row) => row.id === secondInvoiceId), "invoice data is isolated by user");
      r = await request(`/api/invoices/${secondInvoiceId}`, { method: "PUT", cookie, body: { supplier: "Cross Tenant", invoiceNumber: "X", net: 1, vat: 0, total: 1, expenseCategory: "piese" } }); expectStatus(r, 404, "cross-tenant invoice update denied");
      const secondEmployee = await request("/api/employees", { method: "POST", cookie: secondCookie, body: { name: "Tenant B Mechanic", percentage: 0 } }); expectStatus(secondEmployee, 201, "second tenant employee"); secondEmployeeId = secondEmployee.data.id;
      const secondJob = await request("/api/jobs", { method: "POST", cookie: secondCookie, body: { workDate: today, client: "Tenant B Client", description: "Tenant B Job", amount: 80, employeeId: secondEmployeeId } }); expectStatus(secondJob, 201, "second tenant job"); secondJobId = secondJob.data.id;
      r = await request("/api/jobs", { cookie }); expectStatus(r, 200, "tenant A job list"); check(!r.data.some((row) => row.id === secondJobId), "job data is isolated by user");
      r = await request("/api/jobs", { method: "POST", cookie, body: { workDate: today, client: "Cross", description: "Cross employee", amount: 20, employeeId: secondEmployeeId } }); expectStatus(r, 400, "cross-tenant employee assignment denied");
      r = await request("/api/receipts", { method: "POST", cookie, body: { date: today, jobId: secondJobId, method: "card", amount: 10 } }); expectStatus(r, 400, "cross-tenant receipt-to-job denied");
      r = await upload(secondCookie, "tenant-b.png", png, "image/png"); expectStatus(r, 201, "second tenant document"); secondDocId = r.data.id;
      r = await request(`/api/documents/${secondDocId}`, { cookie }); expectStatus(r, 404, "cross-tenant document download denied");
      r = await request("/api/documents", { cookie }); expectStatus(r, 200, "tenant A document list"); check(!r.data.some((doc) => doc.id === secondDocId), "document lists are isolated by user");
      r = await request("/api/expenses", { method: "POST", cookie, body: { category: "piese", title: "Cross document", date: today, amount: 1, documentId: secondDocId } }); expectStatus(r, 400, "cross-tenant document attachment denied");
      r = await request(`/api/employees/${secondEmployeeId}`, { method: "PATCH", cookie, body: { active: false } }); expectStatus(r, 404, "cross-tenant employee update denied");
      r = await request("/api/settings", { cookie: secondCookie }); expectStatus(r, 200, "tenant B settings"); check(r.data.profile.email === "tenant-b@example.test", "settings are scoped to the session user");
    });

    await t.test("delete routes, lockout and logout", async () => {
      let r = await request(`/api/receipts`, { cookie }); expectStatus(r, 200, "receipt list before deletes");
      const linkedReceipt = r.data.find((row) => row.job_id === jobId);
      const standaloneReceipt = r.data.find((row) => !row.job_id);
      r = await request(`/api/receipts/${standaloneReceipt.id}`, { method: "DELETE", cookie }); expectStatus(r, 204, "delete standalone receipt");
      r = await request(`/api/receipts/${linkedReceipt.id}`, { method: "DELETE", cookie }); expectStatus(r, 204, "delete linked receipt");
      r = await request("/api/jobs", { cookie }); expectStatus(r, 200, "job status after receipt delete"); check(r.data.find((row) => row.id === jobId)?.status === "unpaid", "deleting receipt restores job to unpaid");
      r = await request(`/api/expenses/${expenseId}`, { method: "DELETE", cookie }); expectStatus(r, 204, "delete manual expense");
      r = await request(`/api/invoices/${invoiceId}`, { method: "DELETE", cookie }); expectStatus(r, 204, "delete invoice and its linked expense");
      r = await request(`/api/jobs/${jobId}`, { method: "DELETE", cookie }); expectStatus(r, 204, "delete job");
      for (const id of batchIds) { r = await request(`/api/jobs/${id}`, { method: "DELETE", cookie }); expectStatus(r, 204, "delete imported job"); }
      r = await request(`/api/invoices/${secondInvoiceId}`, { method: "DELETE", cookie }); expectStatus(r, 404, "cross-tenant invoice delete denied");
      for (let attempt = 0; attempt < 8; attempt += 1) { r = await request("/api/auth/login", { method: "POST", body: { email: "lockout@example.test", password: "wrong" } }); expectStatus(r, 401, "failed login attempt is rejected"); }
      r = await request("/api/auth/login", { method: "POST", body: { email: "lockout@example.test", password: "wrong" } }); expectStatus(r, 429, "login rate limit blocks repeated failures");
      r = await request("/api/auth/logout", { method: "POST", cookie }); expectStatus(r, 204, "logout");
      r = await request("/api/summary", { cookie }); expectStatus(r, 401, "logout invalidates server session");
      r = await request("/api/session"); expectStatus(r, 200, "unauthenticated session after logout"); check(!r.data.authenticated && !r.data.needsSetup, "logout preserves account setup state");
    });

    check(!log.join("").includes("UnhandledPromiseRejection") && !log.join("").includes("uncaughtException"), "server log has no unhandled errors");
    t.diagnostic(`Passed ${checks} HTTP and data assertions. Server log: ${log.join("").trim() || "(empty)"}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), wait(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
