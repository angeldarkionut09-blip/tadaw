import { db, fromCents, getSetting } from "./db.js";

const dateKey = (date) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
};
function localMidnightUtc(date) {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const representedUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const difference = target - representedUtc;
    if (!difference) break;
    candidate += difference;
  }
  return new Date(candidate).toISOString();
}
export function utcBoundsForBucharestDates(start, end) {
  const nextDay = new Date(`${end}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return [localMidnightUtc(start), localMidnightUtc(nextDay.toISOString().slice(0, 10))];
}
const isDateKey = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
function bounds(range, from, to) {
  const now = new Date();
  const today = dateKey(now);
  if (range === "today") return [today, today];
  if (range === "week") {
    const d = new Date(`${today}T00:00:00Z`);
    const mondayOffset = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - mondayOffset);
    return [dateKey(d), today];
  }
  if (range === "custom" && isDateKey(from) && isDateKey(to) && from <= to) return [from, to];
  return [`${today.slice(0, 7)}-01`, today];
}

function monthlyFraction(from, to) {
  let cursor = new Date(from + "T00:00:00Z");
  const last = new Date(to + "T00:00:00Z");
  let fraction = 0;
  while (cursor <= last) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));
    const segmentStart = cursor > monthStart ? cursor : monthStart;
    const segmentEnd = last < monthEnd ? last : monthEnd;
    fraction += (Math.floor((segmentEnd - segmentStart) / 86400000) + 1) / monthEnd.getUTCDate();
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return fraction;
}

export function dashboard(userId, options = {}) {
  const [start, end] = bounds(options.range || "month", options.from, options.to);
  const [invoiceStart, invoiceEnd] = utcBoundsForBucharestDates(start, end);
  const invoices = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(net_cents),0) AS net,
    COALESCE(SUM(vat_cents),0) AS vat, COALESCE(SUM(total_cents),0) AS total
    FROM invoices WHERE user_id=? AND added_at>=? AND added_at<?`).get(userId, invoiceStart, invoiceEnd);
  const service = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS value
    FROM jobs WHERE user_id=? AND work_date BETWEEN ? AND ?`).get(userId, start, end);
  const expenses = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS value FROM expenses
    WHERE user_id=? AND expense_date BETWEEN ? AND ?`).get(userId, start, end);
  const receipts = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS value, COUNT(*) AS count FROM receipts
    WHERE user_id=? AND receipt_date BETWEEN ? AND ?`).get(userId, start, end);
  const eligibleCategories = getSetting(userId, "eligibleExpenseCategories", ["piese", "consumabile", "utilități", "chirie", "combustibil", "scule și echipamente", "transport", "alte cheltuieli"]);
  const eligibleExpenses = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS value FROM expenses
    WHERE user_id=? AND expense_date BETWEEN ? AND ? AND category IN (${eligibleCategories.length ? eligibleCategories.map(() => "?").join(",") : "NULL"})`)
    .get(userId, start, end, ...eligibleCategories);
  const staff = db.prepare("SELECT id,fixed_salary_cents,percentage FROM employees WHERE user_id=? AND active=1").all(userId);
  const includeJobRevenue = getSetting(userId, "includeJobRevenue", true);
  const serviceForProfit = includeJobRevenue ? service.value : 0;
  const salaryPaid = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS value FROM salary_entries
    WHERE user_id=? AND entry_date BETWEEN ? AND ?`).get(userId, start, end);
  const daysFraction = monthlyFraction(start, end);
  const salaryDue = staff.reduce((sum, employee) => {
    const assigned = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS value FROM jobs
      WHERE user_id=? AND employee_id=? AND work_date BETWEEN ? AND ?`).get(userId, employee.id, start, end).value;
    const allocatedExpenses = service.value > 0 ? Math.round(eligibleExpenses.value * assigned / service.value) : 0;
    const eligibleBase = Math.max(0, (includeJobRevenue ? assigned : 0) - allocatedExpenses);
    return sum + Math.round(Number(employee.fixed_salary_cents || 0) * daysFraction) + Math.round(eligibleBase * Number(employee.percentage || 0) / 100);
  }, 0);
  const unpaid = db.prepare(`SELECT COALESCE(SUM(j.amount_cents-COALESCE(p.paid,0)),0) AS value, COUNT(*) AS count
    FROM jobs j LEFT JOIN (SELECT job_id,SUM(amount_cents) paid FROM receipts WHERE user_id=? AND job_id IS NOT NULL GROUP BY job_id) p
    ON p.job_id=j.id WHERE j.user_id=? AND j.work_date BETWEEN ? AND ? AND j.amount_cents>COALESCE(p.paid,0)`)
    .get(userId, userId, start, end);
  const trendRows = db.prepare(`SELECT work_date AS date, SUM(amount_cents) AS amount FROM jobs
    WHERE user_id=? AND work_date BETWEEN ? AND ? GROUP BY work_date`).all(userId, start, end);
  const cashRows = db.prepare(`SELECT receipt_date AS date, SUM(amount_cents) AS amount FROM receipts
    WHERE user_id=? AND receipt_date BETWEEN ? AND ? GROUP BY receipt_date`).all(userId, start, end);
  const expenseRows = db.prepare(`SELECT expense_date AS date, SUM(amount_cents) AS amount FROM expenses
    WHERE user_id=? AND expense_date BETWEEN ? AND ? GROUP BY expense_date`).all(userId, start, end);
  const trendMap = new Map();
  for (const row of trendRows) trendMap.set(row.date, { ...(trendMap.get(row.date) || {}), work: row.amount });
  for (const row of cashRows) trendMap.set(row.date, { ...(trendMap.get(row.date) || {}), cash: row.amount });
  for (const row of expenseRows) trendMap.set(row.date, { ...(trendMap.get(row.date) || {}), expenses: row.amount });
  const recent = db.prepare(`SELECT entity_type AS type,entity_id AS entityId,action,actor_name AS actor,created_at AS date
    FROM audit_log WHERE user_id=? ORDER BY created_at DESC LIMIT 8`).all(userId);
  const toMoney = (n) => fromCents(n);
  return {
    period: { start, end },
    invoices: { count: invoices.count, net: toMoney(invoices.net), vat: toMoney(invoices.vat), total: toMoney(invoices.total) },
    service: { count: service.count, value: toMoney(service.value) },
    expenses: toMoney(expenses.value), receipts: { count: receipts.count, value: toMoney(receipts.value) },
    salaries: { due: toMoney(salaryDue), paid: toMoney(salaryPaid.value), outstanding: toMoney(Math.max(0, salaryDue - salaryPaid.value)) },
    eligibleRevenue: toMoney(serviceForProfit),
    profit: toMoney(serviceForProfit - eligibleExpenses.value - salaryDue),
    eligibleExpenses: toMoney(eligibleExpenses.value),
    receivables: { count: unpaid.count, value: toMoney(unpaid.value) },
    trends: [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({
      date, work: toMoney(values.work), cash: toMoney(values.cash), expenses: toMoney(values.expenses),
    })),
    latest: recent,
  };
}

export function rowsForPeriod(userId, range = {}) {
  const summary = dashboard(userId, range);
  const [start, end] = [summary.period.start, summary.period.end];
  const [invoiceStart, invoiceEnd] = utcBoundsForBucharestDates(start, end);
  return {
    ...summary,
    invoiceRows: db.prepare("SELECT * FROM invoices WHERE user_id=? AND added_at>=? AND added_at<? ORDER BY added_at DESC").all(userId, invoiceStart, invoiceEnd),
    jobRows: db.prepare("SELECT * FROM jobs WHERE user_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date DESC").all(userId, start, end),
    expenseRows: db.prepare("SELECT * FROM expenses WHERE user_id=? AND expense_date BETWEEN ? AND ? ORDER BY expense_date DESC").all(userId, start, end),
    receiptRows: db.prepare("SELECT * FROM receipts WHERE user_id=? AND receipt_date BETWEEN ? AND ? ORDER BY receipt_date DESC").all(userId, start, end),
  };
}
