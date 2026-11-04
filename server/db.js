import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const file = resolve(process.env.NICUBANK_DATA_DIR || "server/data", "nicubank.sqlite");
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, local_path TEXT NOT NULL,
    uploaded_at TEXT NOT NULL, remote_path TEXT, archive_status TEXT NOT NULL DEFAULT 'local_only',
    archive_error TEXT
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    supplier TEXT NOT NULL, company_name TEXT NOT NULL DEFAULT '', cui TEXT NOT NULL DEFAULT '',
    invoice_number TEXT NOT NULL, series TEXT NOT NULL DEFAULT '', issue_date TEXT,
    photographed_at TEXT, added_at TEXT NOT NULL, confirmed_at TEXT NOT NULL,
    net_cents INTEGER NOT NULL DEFAULT 0, vat_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0, document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS invoices_by_added ON invoices(user_id, added_at);
  CREATE INDEX IF NOT EXISTS invoices_by_supplier ON invoices(user_id, supplier, invoice_number);
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', fixed_salary_cents INTEGER NOT NULL DEFAULT 0,
    percentage REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    work_date TEXT NOT NULL, client TEXT NOT NULL, vehicle TEXT NOT NULL DEFAULT '', plate TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL, labor_cents INTEGER NOT NULL DEFAULT 0, amount_cents INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'unpaid', employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_by_date ON jobs(user_id, work_date);
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL, title TEXT NOT NULL, expense_date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    invoice_id TEXT UNIQUE REFERENCES invoices(id) ON DELETE SET NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL, notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS expenses_by_date ON expenses(user_id, expense_date);
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, client TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL, method TEXT NOT NULL, receipt_type TEXT NOT NULL DEFAULT 'payment',
    receipt_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS receipts_by_date ON receipts(user_id, receipt_date);
  CREATE TABLE IF NOT EXISTS salary_entries (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('advance','payment')),
    amount_cents INTEGER NOT NULL, entry_date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    setting_key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, setting_key)
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
    old_value_json TEXT, new_value_json TEXT, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_by_date ON audit_log(user_id, created_at);
`);

export const nowIso = () => new Date().toISOString();
export const toCents = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) throw new Error("Suma trebuie să fie un număr pozitiv valid.");
  return Math.round(number * 100);
};
export const fromCents = (value) => Number(value || 0) / 100;
export const id = () => randomUUID();

export function recordAudit(user, entityType, entityId, action, oldValue = null, newValue = null) {
  db.prepare(`INSERT INTO audit_log (id,user_id,entity_type,entity_id,action,old_value_json,new_value_json,actor_name,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id(), user.id, entityType, entityId, action,
    oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null, user.name, nowIso());
}

export function getSetting(userId, key, fallback = null) {
  const row = db.prepare("SELECT value_json FROM settings WHERE user_id=? AND setting_key=?").get(userId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

export function saveSetting(userId, key, value) {
  db.prepare(`INSERT INTO settings (user_id,setting_key,value_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id,setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(userId, key, JSON.stringify(value), nowIso());
}

