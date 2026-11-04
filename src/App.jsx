import { useCallback, useEffect, useMemo, useState } from "react";
import {
  House, Receipt, Notebook, Wallet, ShoppingCart, UsersThree, ChartLineUp, CloudArrowUp,
  CalendarDots, GearSix, Bell, MagnifyingGlass, ArrowUpRight, Camera, FloppyDisk, Plus, X,
  Trash, PencilSimple, CheckCircle, WarningCircle, Robot, CaretDown, TrendUp, Coins,
  CreditCard, ArrowClockwise, DownloadSimple, CircleNotch, ShieldCheck, CalendarBlank,
  ClockCounterClockwise, SignOut, SlidersHorizontal, Paperclip, Briefcase, CaretRight,
  ChartBar, LockKey, SignIn, Sparkle, Info, FilePdf, FileXls, Eye, EyeSlash, DotsNine
} from "@phosphor-icons/react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getRoast, ROAST_COUNT } from "./roasts.js";

const ICONS = {
  dashboard: House, invoices: Receipt, jobs: Notebook, receipts: Wallet, expenses: ShoppingCart,
  salaries: CreditCard, employees: UsersThree, reports: ChartLineUp, archive: CloudArrowUp,
  calendar: CalendarDots, activity: ClockCounterClockwise, settings: GearSix
};
const NAV = [
  ["dashboard", "Dashboard"], ["invoices", "Facturi"], ["jobs", "Caietul"], ["receipts", "Încasări"],
  ["expenses", "Cheltuieli"], ["salaries", "Salarii"], ["employees", "Angajați"],
  ["reports", "Rapoarte"], ["archive", "Arhivă"], ["calendar", "Calendar"], ["activity", "Istoric"], ["settings", "Setări"]
];
const TITLES = {
  dashboard: "Dashboard", invoices: "Facturi", jobs: "Caietul", receipts: "Încasări",
  expenses: "Cheltuieli", salaries: "Salarii", employees: "Angajați", reports: "Rapoarte",
  archive: "Arhivă documente", calendar: "Calendar financiar", activity: "Istoric operațiuni", settings: "Setări"
};
const MONEY = new Intl.NumberFormat("ro-RO", { style: "currency", currency: "RON", minimumFractionDigits: 2 });
const formatMoney = (value) => MONEY.format(Number(value || 0));
const today = () => {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
};
const formatDate = (value) => value ? new Intl.DateTimeFormat("ro-RO", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value.length === 10 ? value + "T12:00:00" : value)) : "—";
const formatDateTime = (value) => value ? new Intl.DateTimeFormat("ro-RO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";

async function api(path, options = {}) {
  const headers = { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) };
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Cererea nu a putut fi salvată.");
  return payload;
}

const FIELDS = {
  invoice: [
    { key: "supplier", label: "Furnizor", required: true }, { key: "companyName", label: "Denumire firmă" },
    { key: "cui", label: "CUI" }, { key: "invoiceNumber", label: "Număr factură", required: true },
    { key: "series", label: "Serie" }, { key: "issueDate", label: "Data emiterii", type: "date" },
    { key: "expenseCategory", label: "Categorie cheltuială", type: "category" },
    { key: "net", label: "Valoare fără TVA", type: "number", required: true },
    { key: "vat", label: "TVA", type: "number", required: true }, { key: "total", label: "Total cu TVA", type: "number", required: true }
  ],
  job: [
    { key: "workDate", label: "Data lucrării", type: "date", required: true }, { key: "client", label: "Client", required: true },
    { key: "vehicle", label: "Marcă și model" }, { key: "plate", label: "Număr de înmatriculare" },
    { key: "description", label: "Descriere lucrare", type: "textarea", required: true },
    { key: "labor", label: "Manoperă", type: "number" }, { key: "amount", label: "Valoare lucrare", type: "number", required: true },
    { key: "employeeId", label: "Mecanic alocat", type: "employee" }
  ],
  expense: [
    { key: "date", label: "Data cheltuielii", type: "date", required: true }, { key: "category", label: "Categorie", type: "category", required: true },
    { key: "title", label: "Descriere", required: true }, { key: "amount", label: "Sumă", type: "number", required: true },
    { key: "notes", label: "Note", type: "textarea" }
  ],
  receipt: [
    { key: "date", label: "Data încasării", type: "date", required: true }, { key: "client", label: "Client" },
    { key: "jobId", label: "Asociază cu lucrarea", type: "job" },
    { key: "type", label: "Tip încasare", type: "options", options: [["payment", "Plată"], ["advance", "Avans"]] },
    { key: "method", label: "Metodă", type: "options", options: [["numerar", "Numerar"], ["card", "Card"], ["transfer", "Transfer bancar"], ["altul", "Altul"]], required: true },
    { key: "amount", label: "Sumă încasată", type: "number", required: true }, { key: "note", label: "Notă", type: "textarea" }
  ],
  employee: [
    { key: "name", label: "Nume angajat", required: true }, { key: "role", label: "Funcție" },
    { key: "fixedSalary", label: "Salariu fix lunar", type: "number" }, { key: "percentage", label: "Procent din activitatea alocată", type: "number" }
  ],
  salary: [
    { key: "employeeId", label: "Angajat", type: "employee", required: true },
    { key: "type", label: "Tip plată", type: "options", options: [["payment", "Plată salariu"], ["advance", "Avans"]] },
    { key: "date", label: "Data", type: "date", required: true }, { key: "amount", label: "Sumă plătită", type: "number", required: true },
    { key: "note", label: "Notă", type: "textarea" }
  ]
};
const FORM_TITLES = { invoice: "Adaugă factură de achiziție", job: "Înregistrează lucrare în caiet", expense: "Adaugă cheltuială", receipt: "Înregistrează încasare", employee: "Adaugă angajat", salary: "Înregistrează plată salarială" };
const FIELDS_DEFAULT = {
  invoice: { supplier: "", companyName: "", cui: "", invoiceNumber: "", series: "", issueDate: today(), expenseCategory: "piese", net: "0", vat: "0", total: "0" },
  job: { workDate: today(), client: "", vehicle: "", plate: "", description: "", labor: "0", amount: "0", employeeId: "" },
  expense: { date: today(), category: "piese", title: "", amount: "0", notes: "" },
  receipt: { date: today(), client: "", jobId: "", type: "payment", method: "numerar", amount: "0", note: "" },
  employee: { name: "", role: "", fixedSalary: "0", percentage: "0" },
  salary: { employeeId: "", type: "payment", date: today(), amount: "0", note: "" }
};
const CATEGORY_OPTIONS = ["piese", "consumabile", "utilități", "chirie", "salarii", "combustibil", "scule și echipamente", "transport", "alte cheltuieli"];

function Brand({ compact = false }) {
  return <div className={"brand" + (compact ? " brand-compact" : "")}>
    <div className="brand-art"><img src="/assets/nicubank-mark.jpg" alt="Logo NicuBank" /></div>
    {!compact && <div className="brand-word"><strong>NicuBank</strong><small>BANCA SERVICE-ULUI LUI NICU</small></div>}
  </div>;
}

function AuthScreen({ needsSetup, onSuccess }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", setupToken: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api(needsSetup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify(form) });
      onSuccess(result.user);
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }
  return <main className="auth-shell">
    <div className="auth-glow" />
    <section className="auth-card">
      <Brand />
      <span className="eyebrow"><ShieldCheck size={15} weight="fill" /> CONTABILITATEA SERVICE-ULUI TĂU</span>
      <h1>{needsSetup ? "Pornim cu cifre reale." : "Bine ai revenit."}</h1>
      <p>{needsSetup ? "Creează contul principal. Nu există date demonstrative; începi cu baza ta goală." : "Autentifică-te pentru a vedea datele service-ului."}</p>
      <form onSubmit={submit} className="auth-form">
        {needsSetup && <label>Nume afișat<input required minLength="2" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Numele tău" /></label>}
        {needsSetup && <label>Cod inițial de configurare<input required type="password" autoComplete="off" value={form.setupToken} onChange={(e) => setForm({ ...form, setupToken: e.target.value })} placeholder="Codul oferit de administratorul serverului" /></label>}
        <label>E-mail<input required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="nume@service.ro" /></label>
        <label>Parolă<div className="password-field"><input required minLength={needsSetup ? 12 : 1} type={show ? "text" : "password"} autoComplete={needsSetup ? "new-password" : "current-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={needsSetup ? "Cel puțin 12 caractere" : "Parola contului"} /><button type="button" aria-label="Arată parola" onClick={() => setShow(!show)}>{show ? <EyeSlash size={18} /> : <Eye size={18} />}</button></div></label>
        {error && <div className="form-error"><WarningCircle size={17} />{error}</div>}
        <button className="primary-button full-button" disabled={busy}>{busy ? <CircleNotch className="spin" size={18} /> : needsSetup ? <ShieldCheck size={18} /> : <SignIn size={18} />}{needsSetup ? "Creează cont securizat" : "Intră în NicuBank"}</button>
      </form>
      <div className="auth-security"><LockKey size={16} />Parola este hash-uită. Sesiunea este HTTP-only.</div>
    </section>
  </main>;
}

function MetricCard({ icon: Icon, title, value, detail, tone, onClick }) {
  return <button className={"metric-card tone-" + tone} onClick={onClick}>
    <div className="metric-head"><span className="metric-icon"><Icon size={22} weight="duotone" /></span><span className="metric-title">{title}</span><ArrowUpRight className="metric-go" size={16} /></div>
    <strong className="metric-value">{value}</strong><span className="metric-detail">{detail}</span>
  </button>;
}

function FormDialog({ type, record, jobs, employees, aiAvailable, onClose, onSubmit, toast }) {
  const [values, setValues] = useState(() => record ? { ...FIELDS_DEFAULT[type], ...record } : { ...FIELDS_DEFAULT[type] });
  const [file, setFile] = useState(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [extraJobs, setExtraJobs] = useState([]);
  const [rawOcr, setRawOcr] = useState("");
  const [invoiceItems, setInvoiceItems] = useState(() => Array.isArray(record?.items) ? record.items : []);
  const fields = FIELDS[type] || [];
  function update(key, value) {
    setValues((old) => {
      const next = { ...old, [key]: value };
      if (type === "invoice" && (key === "net" || key === "vat")) next.total = (Number(next.net || 0) + Number(next.vat || 0)).toFixed(2);
      return next;
    });
  }
  async function runOcr(mode) {
    if (!file) return toast("Alege mai întâi o imagine sau un PDF.", "error");
    setOcrBusy(true); setProgress(0);
    try {
      if (mode === "ai") {
        const body = new FormData(); body.append("file", file);
        const result = await api("/api/ocr/ai", { method: "POST", body });
        setValues((old) => ({ ...old, ...Object.fromEntries(fields.map((field) => [field.key, result[field.key] ?? old[field.key]])) }));
        if (Array.isArray(result.items)) setInvoiceItems(result.items);
        setRawOcr("Extragere AI gata. Verifică fiecare câmp înainte să salvezi factura.");
        toast("Am extras datele. Verifică-le și confirmă manual.", "success");
      } else {
        const { extractInvoiceFields, extractJobHints, recognizeDocument } = await import("./ocr.js");
        const text = await recognizeDocument(file, setProgress);
        setRawOcr(text);
        if (type === "invoice") {
          const extracted = extractInvoiceFields(text);
          setValues((old) => ({ ...old, ...Object.fromEntries(fields.map((field) => [field.key, extracted[field.key] ?? old[field.key]])) }));
          setInvoiceItems(extracted.items);
        } else if (type === "job") {
          const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
          setValues((old) => ({ ...old, description: extractJobHints(blocks.shift() || text) }));
          if (blocks.length) setExtraJobs(blocks.map((block) => ({ ...FIELDS_DEFAULT.job, description: extractJobHints(block) })));
        }
        toast("OCR local finalizat. Rezultatele incerte rămân la verificarea ta.", "success");
      }
    } catch (error) { toast(error.message, "error"); } finally { setOcrBusy(false); }
  }
  const fileInput = <div className="upload-block">
    <label className="file-picker"><Camera size={18} />{file ? file.name : type === "invoice" ? "Fotografiază sau alege factura" : "Fotografiază pagina din caiet"}
      <input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} />
    </label>
    {file && <div className="ocr-actions"><button type="button" className="soft-button" disabled={ocrBusy} onClick={() => runOcr("local")}><Sparkle size={15} /> OCR local</button>{type === "invoice" && aiAvailable && <button type="button" className="soft-button" disabled={ocrBusy} onClick={() => runOcr("ai")}><Robot size={15} /> Extragere AI</button>}</div>}
    {ocrBusy && <div className="progress-line"><span style={{ width: Math.max(8, progress) + "%" }} /></div>}
    {rawOcr && <details className="ocr-result"><summary>Text citit · verifică înainte de salvare</summary><pre>{rawOcr}</pre></details>}
    <small>Documentul original se păstrează după confirmare. Scrisul de mână poate necesita corecturi.</small>
  </div>;
  const fieldInput = (field, target = values, setTarget = update) => {
    const key = field.key; const value = target[key] ?? "";
    if (field.type === "textarea") return <textarea required={field.required} value={value} rows="2" onChange={(e) => setTarget(key, e.target.value)} placeholder={field.label} />;
    if (field.type === "options") return <select required={field.required} value={value} onChange={(e) => setTarget(key, e.target.value)}>{field.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>;
    if (field.type === "category") return <select value={value} onChange={(e) => setTarget(key, e.target.value)}>{CATEGORY_OPTIONS.map((x) => <option key={x}>{x}</option>)}</select>;
    if (field.type === "employee") return <select value={value} onChange={(e) => setTarget(key, e.target.value)}><option value="">Fără alocare</option>{employees.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>;
    if (field.type === "job") return <select value={value} onChange={(e) => setTarget(key, e.target.value)}><option value="">Avans fără lucrare asociată</option>{jobs.filter((x) => x.status !== "paid").map((x) => <option key={x.id} value={x.id}>{x.client} · {x.plate || x.description.slice(0, 36)} · {formatMoney(x.amount - x.paid)}</option>)}</select>;
    return <input required={field.required} type={field.type || "text"} min={field.type === "number" ? 0 : undefined} step={field.type === "number" ? "0.01" : undefined} value={value} onChange={(e) => setTarget(key, e.target.value)} placeholder={field.type === "number" ? "0,00" : field.label} />;
  };
  async function submit(event) {
    event.preventDefault();
    const batch = type === "job" ? [values, ...extraJobs] : type === "invoice" ? { ...values, items: invoiceItems, photographedAt: file ? new Date().toISOString() : values.photographed_at } : values;
    await onSubmit(type, batch, record, file);
  }
  function setExtra(index, key, value) { setExtraJobs((old) => old.map((item, i) => i === index ? { ...item, [key]: value } : item)); }
  return <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header className="modal-head"><div><span className="eyebrow">NICUBANK · DATE CONFIRMATE MANUAL</span><h2 id="modal-title">{record ? "Editează înregistrarea" : FORM_TITLES[type]}</h2></div><button className="icon-button" type="button" aria-label="Închide" onClick={onClose}><X size={20} /></button></header>
      {(type === "invoice" || type === "job") && !record && fileInput}
      <form onSubmit={submit}>
        <div className="form-grid">{fields.map((field) => <label key={field.key} className={(field.type === "textarea" ? "field-wide " : "") + "form-field"}>{field.label}{fieldInput(field)}</label>)}</div>
        {type === "invoice" && <p className="form-hint"><Info size={16} />Raportarea folosește data confirmării în aplicație. Totalul facturii devine cheltuială o singură dată.</p>}
        {type === "invoice" && <div className="invoice-items"><div className="batch-head"><strong>Produse și poziții de pe factură</strong><button type="button" className="soft-button tiny-button" onClick={() => setInvoiceItems((old) => [...old, { description: "", quantity: "", unitPrice: "", total: "" }])}><Plus size={14} /> Rând</button></div>{invoiceItems.map((item, index) => <div className="invoice-item-row" key={index}><input aria-label="Denumire produs" placeholder="Produs / lucrare" value={item.description || item.name || ""} onChange={(e) => setInvoiceItems((old) => old.map((x, i) => i === index ? { ...x, description: e.target.value } : x))} /><input aria-label="Cantitate" type="number" min="0" step="0.01" placeholder="Cant." value={item.quantity ?? ""} onChange={(e) => setInvoiceItems((old) => old.map((x, i) => i === index ? { ...x, quantity: e.target.value } : x))} /><input aria-label="Preț unitar" type="number" min="0" step="0.01" placeholder="Preț unitar" value={item.unitPrice ?? ""} onChange={(e) => setInvoiceItems((old) => old.map((x, i) => i === index ? { ...x, unitPrice: e.target.value } : x))} /><input aria-label="Total poziție" type="number" min="0" step="0.01" placeholder="Total" value={item.total ?? ""} onChange={(e) => setInvoiceItems((old) => old.map((x, i) => i === index ? { ...x, total: e.target.value } : x))} /><button type="button" className="icon-button danger-hover" aria-label="Șterge poziția" onClick={() => setInvoiceItems((old) => old.filter((_, i) => i !== index))}><Trash size={15} /></button></div>)}</div>}
        {type === "job" && !record && <div className="batch-jobs">
          {extraJobs.map((job, index) => <div className="batch-job-card" key={index}><div className="batch-head"><strong>Lucrarea {index + 2} de pe pagină</strong><button type="button" className="icon-button danger-hover" onClick={() => setExtraJobs((old) => old.filter((_, i) => i !== index))}><X size={16} /></button></div>
            <div className="form-grid">{FIELDS.job.map((field) => <label key={field.key} className={(field.type === "textarea" ? "field-wide " : "") + "form-field"}>{field.label}{fieldInput(field, job, (key, value) => setExtra(index, key, value))}</label>)}</div>
          </div>)}
          <button type="button" className="soft-button" onClick={() => setExtraJobs((old) => [...old, { ...FIELDS_DEFAULT.job }])}><Plus size={16} /> Adaugă altă lucrare de pe această pagină</button>
        </div>}
        <footer className="modal-actions"><button type="button" className="soft-button" onClick={onClose}>Anulează</button><button className="primary-button"><FloppyDisk size={17} />{record ? "Salvează modificarea" : "Confirmă și salvează"}</button></footer>
      </form>
    </section>
  </div>;
}

function EmptyState({ icon: Icon = Notebook, title, detail }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={25} weight="duotone" /></span><strong>{title}</strong><p>{detail}</p></div>;
}

function TablePage({ view, records, query, setQuery, onAdd, onEdit, onDelete }) {
  const configurations = {
    invoices: { add: "Adaugă factură", icon: Receipt, rows: records.invoices, columns: [["Furnizor", (r) => r.supplier], ["Număr", (r) => (r.series ? r.series + " " : "") + r.invoice_number], ["Adăugată", (r) => formatDate(r.added_at)], ["Fără TVA", (r) => formatMoney(r.net)], ["TVA", (r) => formatMoney(r.vat)], ["Cu TVA", (r) => formatMoney(r.total)]] },
    jobs: { add: "Adaugă lucrare", icon: Notebook, rows: records.jobs, columns: [["Data lucrării", (r) => formatDate(r.work_date)], ["Client", (r) => r.client], ["Auto", (r) => [r.vehicle, r.plate].filter(Boolean).join(" · ") || "—"], ["Lucrare", (r) => r.description], ["Valoare", (r) => formatMoney(r.amount)], ["Încasat", (r) => formatMoney(r.paid)], ["Status", (r) => r.paid >= r.amount ? "Achitată" : r.paid > 0 ? "Parțial" : "Neachitată"]] },
    expenses: { add: "Adaugă cheltuială", icon: ShoppingCart, rows: records.expenses, columns: [["Data", (r) => formatDate(r.expense_date)], ["Categorie", (r) => r.category], ["Descriere", (r) => r.title], ["Sumă", (r) => formatMoney(r.amount)], ["Sursă", (r) => r.invoice_id ? "Factură legată" : "Manual"]] },
    receipts: { add: "Adaugă încasare", icon: Wallet, rows: records.receipts, columns: [["Data", (r) => formatDate(r.receipt_date)], ["Client", (r) => r.client || "—"], ["Tip", (r) => r.receipt_type === "advance" ? "Avans" : "Plată"], ["Metodă", (r) => r.method], ["Sumă", (r) => formatMoney(r.amount)]] },
    employees: { add: "Adaugă angajat", icon: UsersThree, rows: records.employees, columns: [["Angajat", (r) => r.name], ["Funcție", (r) => r.role || "—"], ["Salariu fix", (r) => formatMoney(r.fixed_salary)], ["Procent", (r) => Number(r.percentage || 0) + "%"], ["Status", (r) => r.active ? "Activ" : "Dezactivat"]] }
  };
  const config = configurations[view];
  const filtered = config.rows.filter((row) => JSON.stringify(row).toLocaleLowerCase("ro").includes(query.toLocaleLowerCase("ro")));
  const Icon = config.icon;
  return <section className="surface table-surface">
    <div className="table-toolbar"><div><span className="eyebrow">{filtered.length} ÎNREGISTRĂRI</span><h2>{TITLES[view]}</h2></div><div className="table-actions"><label className="search-box"><MagnifyingGlass size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Caută în listă" /></label><button className="primary-button" onClick={onAdd}><Plus size={17} />{config.add}</button></div></div>
    {filtered.length === 0 ? <EmptyState icon={Icon} title={query ? "Nu am găsit potriviri." : "Încă nu există înregistrări."} detail={query ? "Schimbă termenul de căutare." : "Adaugă prima înregistrare. Lista va folosi numai datele confirmate de tine."} /> :
      <div className="table-scroll"><table><thead><tr>{config.columns.map(([name]) => <th key={name}>{name}</th>)}<th className="action-col">Acțiuni</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id}>{config.columns.map(([name, get]) => <td key={name}>{name === "Status" ? <span className={"status-pill " + (row.paid >= row.amount ? "status-good" : row.paid > 0 ? "status-warn" : "status-muted")}>{get(row)}</span> : get(row)}</td>)}<td className="row-actions">{(view === "invoices" || view === "jobs" || view === "expenses" || view === "employees") && <button className="icon-button" title="Editează" onClick={() => onEdit(row)}><PencilSimple size={17} /></button>}{view !== "employees" && <button className="icon-button danger-hover" title="Șterge" onClick={() => onDelete(row)}><Trash size={17} /></button>}{view === "employees" && <button className="soft-button tiny-button" onClick={() => onDelete(row)}>{row.active ? "Dezactivează" : "Reactivează"}</button>}</td></tr>)}</tbody></table></div>}
  </section>;
}

function App() {
  const [session, setSession] = useState(null);
  const [view, setView] = useState("dashboard");
  const [range, setRange] = useState("month");
  const [custom, setCustom] = useState({ from: today().slice(0, 8) + "01", to: today() });
  const [summary, setSummary] = useState(null);
  const [todaySummary, setTodaySummary] = useState(null);
  const [records, setRecords] = useState({ invoices: [], jobs: [], receipts: [], expenses: [], employees: [], salaries: [], documents: [], activity: [] });
  const [settings, setSettings] = useState(null);
  const [integrations, setIntegrations] = useState({ aiAvailable: false, aiModel: "gpt-6-luna" });
  const [modal, setModal] = useState(null);
  const [query, setQuery] = useState("");
  const [calendarDate, setCalendarDate] = useState(today());
  const [calendar, setCalendar] = useState({ entries: [] });
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [botQuestion, setBotQuestion] = useState("");
  const [botMessages, setBotMessages] = useState([]);
  const [archiveSettings, setArchiveSettings] = useState(null);
  const [archivePassword, setArchivePassword] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [dashboardRoast, setDashboardRoast] = useState(() => getRoast("general"));
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const notify = useCallback((message, kind = "success") => { setToast({ message, kind }); window.clearTimeout(window.__nicubankToast); window.__nicubankToast = window.setTimeout(() => setToast(null), 4200); }, []);
  const summaryQuery = useMemo(() => range === "custom" ? "&range=custom&from=" + custom.from + "&to=" + custom.to : "&range=" + range, [range, custom]);
  const loadAll = useCallback(async () => {
    if (!session?.user?.id) return;
    try {
      const [main, daily, invoices, jobs, expenses, receipts, employees, salaryData, docs, activity, prefs, integration] = await Promise.all([
        api("/api/summary?" + summaryQuery.slice(1)), api("/api/summary?range=today"), api("/api/invoices"), api("/api/jobs"),
        api("/api/expenses"), api("/api/receipts"), api("/api/employees"), api("/api/salaries"),
        api("/api/documents"), api("/api/activity"), api("/api/settings"), api("/api/integrations")
      ]);
      setSummary(main); setTodaySummary(daily); setRecords({ invoices, jobs, expenses, receipts, employees, salaries: salaryData.entries, documents: docs, activity }); setSettings(prefs); setArchiveSettings(prefs.archive); setIntegrations(integration);
    } catch (error) { if (/sesiunea/i.test(error.message)) setSession(null); else notify(error.message, "error"); }
  }, [session, summaryQuery, notify]);
  useEffect(() => { api("/api/session").then(setSession).catch(() => setSession({ authenticated: false, needsSetup: true, user: null })); }, []);
  useEffect(() => { if (session?.authenticated) loadAll(); }, [session, loadAll]);
  useEffect(() => { if (session?.authenticated && view === "calendar") api("/api/calendar?date=" + calendarDate).then(setCalendar).catch((e) => notify(e.message, "error")); }, [session, view, calendarDate, notify]);
  useEffect(() => { if (summary) setDashboardRoast(getRoast(summary.profit < 0 ? "profitDown" : summary.profit > 0 ? "profitUp" : "general", settings?.preferences?.customRoasts)); }, [summary?.profit]);
  useEffect(() => { if (settings?.preferences?.animation) document.documentElement.dataset.motion = settings.preferences.animation; }, [settings?.preferences?.animation]);

  async function signOut() { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); setSession({ authenticated: false, needsSetup: false, user: null }); setSummary(null); }
  function openAdd(type) { setModal({ type, record: null }); }
  function openEdit(type, row) {
    const record = type === "invoice" ? { ...row, invoiceNumber: row.invoice_number, net: row.net, vat: row.vat, total: row.total, issueDate: row.issue_date || today(), expenseCategory: row.expense_category || "piese" }
      : type === "job" ? { ...row, workDate: row.work_date, amount: row.amount, labor: row.labor, employeeId: row.employee_id || "" }
      : type === "expense" ? { ...row, date: row.expense_date, amount: row.amount }
      : type === "employee" ? { ...row, fixedSalary: row.fixed_salary, percentage: row.percentage } : row;
    setModal({ type, record });
  }
  async function submitForm(type, payload, record, file) {
    setBusy(true);
    try {
      let documentId = record?.document_id;
      if (file && !record) {
        const body = new FormData(); body.append("file", file); body.append("category", type === "invoice" ? "facturi" : "caiet");
        const document = await api("/api/documents", { method: "POST", body }); documentId = document.id;
      }
      if (type === "job" && Array.isArray(payload)) {
        if (record) await api("/api/jobs/" + record.id, { method: "PUT", body: JSON.stringify({ ...payload[0], documentId }) });
        else await api("/api/jobs/batch", { method: "POST", body: JSON.stringify({ jobs: payload, documentId }) });
      } else {
        const route = { invoice: "/api/invoices", expense: "/api/expenses", receipt: "/api/receipts", employee: "/api/employees", salary: "/api/salaries" }[type];
        const body = { ...payload, ...(documentId ? { documentId } : {}) };
        if (record) await api(route + "/" + record.id, { method: "PUT", body: JSON.stringify(body) });
        else await api(route, { method: "POST", body: JSON.stringify(body) });
      }
      setModal(null); await loadAll(); notify(record ? "Modificarea a fost salvată în baza de date." : "Înregistrarea a fost salvată în baza de date.", "success");
      if (!record) {
        const category = { invoice: "invoice", job: "job", receipt: "receipt", expense: "expense", employee: "general", salary: "salary" }[type];
        const base = Array.isArray(payload) ? payload[0] : payload;
        const amount = type === "job" ? payload.reduce((sum, item) => sum + Number(item.amount || 0), 0) : Number(base.total ?? base.amount ?? base.fixedSalary);
        if (settings?.preferences?.notifications !== false) setBotMessages((old) => [...old, { from: "bot", text: getRoast(category, settings?.preferences?.customRoasts, Number.isFinite(amount) ? amount : undefined) }].slice(-12));
        if (settings?.preferences?.sounds) {
          try {
            const Audio = window.AudioContext || window.webkitAudioContext;
            const context = new Audio(); const oscillator = context.createOscillator(); const gain = context.createGain();
            oscillator.type = "sine"; oscillator.frequency.value = 660; gain.gain.value = 0.025;
            oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.07);
            oscillator.onended = () => context.close();
          } catch {}
        }
      }
    } catch (error) { notify(error.message, "error"); } finally { setBusy(false); }
  }
  async function deleteRecord(viewName, row) {
    if (viewName === "employees") {
      const action = row.active ? "dezactivezi" : "reactivezi";
      if (!window.confirm("Vrei să " + action + " angajatul " + row.name + "?")) return;
      try { await api("/api/employees/" + row.id, { method: "PATCH", body: JSON.stringify({ active: !row.active }) }); await loadAll(); notify("Statutul angajatului a fost actualizat."); } catch (error) { notify(error.message, "error"); }
      return;
    }
    const label = viewName === "invoices" ? "factura" : viewName === "jobs" ? "lucrarea" : "cheltuiala";
    if (!window.confirm("Ștergi " + label + "? Operațiunea va rămâne în istoricul activității.")) return;
    try { await api("/api/" + viewName + "/" + row.id, { method: "DELETE" }); await loadAll(); notify("Înregistrarea a fost ștearsă și jurnalizată."); } catch (error) { notify(error.message, "error"); }
  }
  async function askBot(question = botQuestion) {
    const clean = question.trim(); if (!clean) return;
    setBotQuestion(""); setBotMessages((old) => [...old, { from: "user", text: clean }].slice(-12));
    try { const response = await api("/api/bot/ask", { method: "POST", body: JSON.stringify({ question: clean }) }); setBotMessages((old) => [...old, { from: "bot", text: response.answer }].slice(-12)); }
    catch (error) { setBotMessages((old) => [...old, { from: "bot", text: error.message }].slice(-12)); }
  }
  async function saveArchive() {
    setArchiveBusy(true);
    try { const result = await api("/api/archive/settings", { method: "PUT", body: JSON.stringify({ ...archiveSettings, password: archivePassword }) }); setArchiveSettings(result); setArchivePassword(""); notify("Configurația de arhivare a fost salvată criptat."); await loadAll(); }
    catch (error) { notify(error.message, "error"); } finally { setArchiveBusy(false); }
  }
  async function testArchive() {
    setArchiveBusy(true);
    try { const result = await api("/api/archive/test", { method: "POST", body: "{}" }); notify("Conexiune reușită în " + result.elapsedMs + " ms."); }
    catch (error) { notify(error.message, "error"); } finally { setArchiveBusy(false); }
  }
  async function retryDocument(id) {
    try { await api("/api/archive/" + id + "/retry", { method: "POST", body: "{}" }); notify("Documentul a fost arhivat."); await loadAll(); }
    catch (error) { notify(error.message, "error"); }
  }
  async function savePreferences() {
    try { await api("/api/settings", { method: "PUT", body: JSON.stringify(settings.preferences) }); notify("Preferințele au fost salvate."); await loadAll(); }
    catch (error) { notify(error.message, "error"); }
  }
  function changePref(key, value) { setSettings((old) => ({ ...old, preferences: { ...old.preferences, [key]: value } })); }

  if (!session) return <main className="loading-shell"><Brand /><CircleNotch className="spin" size={26} /><span>Verific sesiunea sigură…</span></main>;
  if (!session.authenticated) return <AuthScreen needsSetup={session.needsSetup} onSuccess={(user) => setSession({ authenticated: true, user })} />;
  const user = session.user;
  const nav = (name) => { setView(name); setQuery(""); };
  const currentSummary = summary || { invoices: { count: 0, net: 0, vat: 0, total: 0 }, service: { count: 0, value: 0 }, expenses: 0, receipts: { value: 0 }, salaries: { due: 0, paid: 0, outstanding: 0 }, profit: 0, receivables: { count: 0, value: 0 }, trends: [], latest: [] };
  const currentTitle = TITLES[view] || "Dashboard";
  const updateArchiveField = (key, value) => setArchiveSettings((old) => ({ ...old, [key]: value }));

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="side-brand"><Brand /></div>
      <div className="workshop-tag"><span className="live-dot" /> CONTABILITATE SERVICE</div>
      <nav className="side-nav">{NAV.map(([key, label]) => { const Icon = ICONS[key]; return <button key={key} className={"nav-link" + (view === key ? " active" : "")} onClick={() => nav(key)}><Icon size={19} weight={view === key ? "fill" : "regular"} /><span>{label}</span>{key === "invoices" && records.invoices.length > 0 && <small className="nav-count">{records.invoices.length}</small>}</button>; })}</nav>
      <div className="sidebar-footer"><div className="sidebar-tip"><Sparkle size={16} /><span>„Banii intră, banii ies. Noi măcar știm pe unde!”</span></div><button className="user-menu" onClick={signOut}><span className="user-avatar">{user.name.slice(0, 1).toLocaleUpperCase("ro")}</span><span className="user-copy"><strong>{user.name}</strong><small>Administrator</small></span><SignOut size={17} /></button></div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="mobile-brand"><Brand compact /><strong>NicuBank</strong></div>
        <div className="crumbs"><span>Service</span><CaretRight size={14} /><strong>{currentTitle}</strong></div>
        <div className="top-actions"><span className="database-chip"><span className="live-dot" /> Bază locală activă</span><button className="icon-button notification-button" title="Istoric și notificări" onClick={() => nav("activity")}><Bell size={19} /><span /></button><div className="top-profile"><span className="user-avatar small-avatar">{user.name.slice(0, 1).toLocaleUpperCase("ro")}</span><span>{user.name}</span><CaretDown size={14} /></div></div>
      </header>

      <div className="main-content">
        {view === "dashboard" && <>
          <div className="welcome-row"><div><span className="eyebrow">CONTABILITATEA SERVICE-ULUI · {formatDate(today())}</span><h1>Salut, {user.name.split(" ")[0]}!</h1><p>Hai să vedem ce au făcut banii azi. Eu am pregătit sprânceana.</p></div><div className="range-control"><div className="segmented">{[["today", "Azi"], ["week", "Săptămâna"], ["month", "Luna"], ["custom", "Perioadă"]].map(([key, label]) => <button key={key} className={range === key ? "selected" : ""} onClick={() => setRange(key)}>{label}</button>)}</div>{range === "custom" && <div className="custom-date"><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /><span>—</span><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></div>}</div></div>
          <section className="metrics-grid">
            <MetricCard icon={Receipt} title="Total facturi" value={String(currentSummary.invoices.count)} detail="facturi adăugate în perioadă" tone="blue" onClick={() => nav("invoices")} />
            <MetricCard icon={Coins} title="Valoare facturi" value={formatMoney(currentSummary.invoices.total)} detail={"Fără TVA " + formatMoney(currentSummary.invoices.net) + " · TVA " + formatMoney(currentSummary.invoices.vat)} tone="cyan" onClick={() => nav("invoices")} />
            <MetricCard icon={Notebook} title="Caietul" value={String(currentSummary.service.count) + " lucrări"} detail={formatMoney(currentSummary.service.value) + " valoare lucrări"} tone="amber" onClick={() => nav("jobs")} />
            <MetricCard icon={Briefcase} title="Total bani service" value={formatMoney(currentSummary.service.value)} detail="lucrări înregistrate, nu încasări" tone="green" onClick={() => nav("jobs")} />
            <MetricCard icon={UsersThree} title="Salarii" value={formatMoney(currentSummary.salaries.due)} detail={formatMoney(currentSummary.salaries.outstanding) + " rămas de plată"} tone="purple" onClick={() => nav("salaries")} />
            <MetricCard icon={ShoppingCart} title="Cheltuieli" value={formatMoney(currentSummary.expenses)} detail="facturi incluse o singură dată" tone="rose" onClick={() => nav("expenses")} />
            <MetricCard icon={TrendUp} title="Profit estimat" value={formatMoney(currentSummary.profit)} detail="Caietul − cheltuieli eligibile − salarii" tone={currentSummary.profit >= 0 ? "green" : "rose"} onClick={() => nav("reports")} />
            <MetricCard icon={Wallet} title="Încasări reale" value={formatMoney(currentSummary.receipts.value)} detail="bani primiți și înregistrați" tone="cyan" onClick={() => nav("receipts")} />
          </section>
          <section className="quick-actions">{[
            ["invoice", Camera, "Scanează factură", "OCR și verificare"], ["job", Notebook, "Scanează caietul", "Importă lucrări"], ["receipt", Wallet, "Încasare", "Adaugă o plată"], ["expense", ShoppingCart, "Cheltuială", "Înregistrează cost"], ["salary", UsersThree, "Avans / salariu", "Gestionează plățile"]
          ].map(([type, Icon, title, sub]) => <button key={type} className={"quick-action quick-" + type} onClick={() => openAdd(type)}><span><Icon size={21} weight="duotone" /></span><strong>{title}</strong><small>{sub}</small></button>)}</section>
          <div className="dashboard-grid">
            <section className="surface chart-card"><div className="surface-heading"><div><span className="eyebrow">ACTIVITATE FINANCIARĂ</span><h2>Lucrări & încasări</h2></div><span className="period-chip">{summary?.period.start === summary?.period.end ? formatDate(summary?.period.start) : (formatDate(summary?.period.start) + " — " + formatDate(summary?.period.end))}</span></div>
              {currentSummary.trends.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={currentSummary.trends} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><defs><linearGradient id="workFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#37d8ff" stopOpacity={0.26} /><stop offset="95%" stopColor="#37d8ff" stopOpacity={0} /></linearGradient><linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#47e99a" stopOpacity={0.2} /><stop offset="95%" stopColor="#47e99a" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="4 7" stroke="#ffffff11" vertical={false} /><XAxis dataKey="date" tickFormatter={(x) => x.slice(8, 10) + " " + new Intl.DateTimeFormat("ro-RO", { month: "short" }).format(new Date(x + "T12:00:00"))} stroke="#748398" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis stroke="#748398" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(x) => x >= 1000 ? (x / 1000).toFixed(0) + "k" : x} /><Tooltip contentStyle={{ background: "#0c1726", border: "1px solid #254056", borderRadius: 12, color: "#edf6ff" }} formatter={(v, name) => [formatMoney(v), name === "work" ? "Lucrări" : "Încasări"]} labelFormatter={(x) => formatDate(x)} /><Area type="monotone" dataKey="work" stroke="#37d8ff" strokeWidth={2.2} fill="url(#workFill)" /><Area type="monotone" dataKey="cash" stroke="#47e99a" strokeWidth={2.2} fill="url(#cashFill)" /></AreaChart></ResponsiveContainer></div> : <div className="chart-empty"><ChartBar size={28} /><span>Graficul așteaptă primele date confirmate.</span></div>}
              <div className="chart-legend"><span><i className="legend-blue" /> Valoare lucrări</span><span><i className="legend-green" /> Încasări efective</span><small>Valorile sunt calculate din baza locală.</small></div>
            </section>
            <section className="surface day-card"><div className="surface-heading"><div><span className="eyebrow">REZUMAT REAL</span><h2>Situația de azi</h2></div><span className="day-icon"><CalendarBlank size={20} /></span></div>
              <div className="day-stat"><span><CheckCircle size={16} weight="fill" /> Lucrări în caiet</span><strong>{formatMoney(todaySummary?.service.value)}</strong></div>
              <div className="day-stat"><span><CheckCircle size={16} weight="fill" /> Încasări efective</span><strong>{formatMoney(todaySummary?.receipts.value)}</strong></div>
              <div className="day-stat"><span><CheckCircle size={16} weight="fill" /> Facturi adăugate</span><strong>{todaySummary?.invoices.count || 0} · {formatMoney(todaySummary?.invoices.total)}</strong></div>
              <div className="day-stat"><span><CheckCircle size={16} weight="fill" /> Cheltuieli</span><strong>{formatMoney(todaySummary?.expenses)}</strong></div>
              <div className="day-stat"><span><WarningCircle size={16} weight="fill" /> Restanțe lucrări</span><strong>{formatMoney(todaySummary?.receivables.value)}</strong></div>
              <button className="profit-strip" onClick={() => nav("reports")}><span><TrendUp size={18} /> Profit estimat în perioadă</span><strong>{formatMoney(currentSummary.profit)}</strong></button>
            </section>
            <section className="surface operations-card"><div className="surface-heading"><div><span className="eyebrow">JURNAL AUDIT</span><h2>Ultimele operațiuni</h2></div><button className="text-button" onClick={() => nav("archive")}>Vezi arhiva <ArrowUpRight size={14} /></button></div>
              {currentSummary.latest?.length ? <div className="operation-list">{currentSummary.latest.map((item) => <div className="operation-row" key={item.entityId + item.date}><span className="operation-icon"><ClockCounterClockwise size={17} /></span><span className="operation-text"><strong>{item.type} · {item.action}</strong><small>{formatDateTime(item.date)} · {item.actor}</small></span><CaretRight size={15} /></div>)}</div> : <EmptyState icon={ClockCounterClockwise} title="Nicio operațiune încă." detail="Înregistrările confirmate vor apărea aici." />}
            </section>
            <section className="surface bot-card"><div className="bot-identity"><div className="bot-logo"><img src="/assets/nicubank-mark.jpg" alt="NicuBot" /></div><div><span className="eyebrow">ASISTENT FINANCIAR</span><h2>NicuBot <span className="bot-live" /></h2><small>{integrations.aiAvailable ? "AI conectat · date din baza ta" : "Mod local · datele rămân în aplicație"}</small></div></div>
              <div className="bot-chat">{botMessages.length === 0 ? <div className="bot-bubble"><strong>{user.name.split(" ")[0]}, nu inventez cifre.</strong><p>{dashboardRoast}</p><small>Răspunsurile contabile se bazează pe datele salvate.</small></div> : botMessages.slice(-4).map((message, index) => <div className={"bot-message " + message.from} key={index}>{message.text}</div>)}</div>
              <form className="bot-input" onSubmit={(e) => { e.preventDefault(); askBot(); }}><input value={botQuestion} onChange={(e) => setBotQuestion(e.target.value)} placeholder="Întreabă despre banii tăi…" /><button aria-label="Trimite întrebarea"><ArrowUpRight size={18} /></button></form>
            </section>
          </div>
        </>}

        {["invoices", "jobs", "expenses", "receipts", "employees"].includes(view) && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">EVIDENȚĂ SERVICE</span><h1>{currentTitle}</h1><p>{view === "invoices" ? "Facturi de achiziție · raportate după data confirmării." : view === "jobs" ? "Lucrările sunt venit înregistrat, nu încasare automată." : view === "receipts" ? "Doar banii primiți și înregistrați apar ca încasări." : "Date păstrate local și legate de istoricul financiar."}</p></div>{view === "invoices" && <button className="primary-button" onClick={() => openAdd("invoice")}><Camera size={17} /> Scanează factură</button>}</div>
          <TablePage view={view} records={records} query={query} setQuery={setQuery} onAdd={() => openAdd(({ invoices: "invoice", jobs: "job", expenses: "expense", receipts: "receipt", employees: "employee" })[view])} onEdit={(row) => openEdit(({ invoices: "invoice", jobs: "job", expenses: "expense", employees: "employee" })[view], row)} onDelete={(row) => deleteRecord(view, row)} />
          {view === "invoices" && <div className="inline-note"><Info size={17} /><span>Facturile importate devin cheltuieli legate de sursă. Corectarea sau ștergerea facturii actualizează aceeași cheltuială, fără dublare.</span></div>}
        </div>}

        {view === "salaries" && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">OBLIGAȚII ȘI PLĂȚI</span><h1>Salarii</h1><p>Salariile fixe sunt prorate pe intervalul selectat; procentele se calculează din activitatea alocată, după cheltuielile eligibile.</p></div><button className="primary-button" onClick={() => openAdd("salary")}><Plus size={17} /> Înregistrează plată</button></div>
          <div className="salary-overview"><div className="salary-box"><small>Obligații estimate</small><strong>{formatMoney(currentSummary.salaries.due)}</strong></div><div className="salary-box"><small>Plăți înregistrate</small><strong>{formatMoney(currentSummary.salaries.paid)}</strong></div><div className="salary-box accent"><small>Rest de plată</small><strong>{formatMoney(currentSummary.salaries.outstanding)}</strong></div><div className="salary-box"><small>Angajați activi</small><strong>{records.employees.filter((x) => x.active).length}</strong></div></div>
          <section className="surface table-surface"><div className="table-toolbar"><div><span className="eyebrow">ISTORIC LUNAR</span><h2>Plăți și avansuri</h2></div><button className="soft-button" onClick={() => nav("employees")}><UsersThree size={17} /> Gestionează angajații</button></div>
            {records.salaries.length ? <div className="table-scroll"><table><thead><tr><th>Data</th><th>Angajat</th><th>Tip</th><th>Notă</th><th>Sumă</th></tr></thead><tbody>{records.salaries.map((row) => <tr key={row.id}><td>{formatDate(row.entry_date)}</td><td>{row.employee_name}</td><td><span className="status-pill status-good">{row.entry_type === "advance" ? "Avans" : "Plată"}</span></td><td>{row.note || "—"}</td><td>{formatMoney(row.amount)}</td></tr>)}</tbody></table></div> : <EmptyState icon={UsersThree} title="Nicio plată salarială înregistrată." detail="Obligațiile estimate se calculează din salariile angajaților activi." />}
          </section>
        </div>}

        {view === "reports" && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">RAPORTARE FĂRĂ DUBLĂRI</span><h1>Rapoarte financiare</h1><p>Facturi după data confirmării · lucrări după data efectuării · încasări după data plății.</p></div><div className="export-actions"><button className="soft-button" onClick={() => { window.location.href = "/api/reports/export?format=pdf" + summaryQuery; }}><FilePdf size={17} /> Export PDF</button><button className="primary-button" onClick={() => { window.location.href = "/api/reports/export?format=xlsx" + summaryQuery; }}><FileXls size={17} /> Export Excel</button></div></div>
          <div className="report-period"><div className="segmented">{[["today", "Azi"], ["week", "Săptămâna"], ["month", "Luna"], ["custom", "Personalizată"]].map(([key, label]) => <button key={key} className={range === key ? "selected" : ""} onClick={() => setRange(key)}>{label}</button>)}</div>{range === "custom" && <div className="custom-date"><input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /><input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></div>}</div>
          <div className="report-grid">{[
            ["Facturi fără TVA", currentSummary.invoices.net, "cost de achiziție"], ["TVA facturi", currentSummary.invoices.vat, "evidențiat separat"], ["Total facturi cu TVA", currentSummary.invoices.total, "nu este venit"], ["Valoare lucrări", currentSummary.service.value, "venit înregistrat"], ["Încasări reale", currentSummary.receipts.value, "plăți primite"], ["Cheltuieli", currentSummary.expenses, "facturile incluse o singură dată"], ["Salarii estimate", currentSummary.salaries.due, "obligații pe perioadă"], ["Profit estimat", currentSummary.profit, "calculat în backend"], ["Restanțe lucrări", currentSummary.receivables.value, "neîncasat integral"]
          ].map(([label, value, note]) => <div className="report-tile" key={label}><small>{label}</small><strong>{formatMoney(value)}</strong><span>{note}</span></div>)}</div>
          <section className="surface chart-card report-chart"><div className="surface-heading"><div><span className="eyebrow">COMPARAȚIE ÎN PERIOADĂ</span><h2>Lucrări, încasări și costuri</h2></div></div>{currentSummary.trends.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={currentSummary.trends}><CartesianGrid strokeDasharray="4 7" stroke="#ffffff12" vertical={false} /><XAxis dataKey="date" stroke="#78859a" tick={{ fontSize: 10 }} /><YAxis stroke="#78859a" tick={{ fontSize: 10 }} /><Tooltip contentStyle={{ background: "#0c1726", border: "1px solid #254056", borderRadius: 12 }} formatter={(v) => formatMoney(v)} /><Area dataKey="work" name="Lucrări" stroke="#39d7ff" fill="#39d7ff22" /><Area dataKey="cash" name="Încasări" stroke="#42e7a0" fill="#42e7a022" /><Area dataKey="expenses" name="Cheltuieli" stroke="#ffb45c" fill="#ffb45c22" /></AreaChart></ResponsiveContainer></div> : <div className="chart-empty">Graficele apar după primele date reale.</div>}</section>
        </div>}

        {view === "archive" && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">DOCUMENTE ORIGINALE</span><h1>Arhivă</h1><p>Fotografiile și PDF-urile încărcate rămân legate de înregistrarea lor.</p></div><a className="soft-button link-button" href="/api/backup"><DownloadSimple size={17} /> Descarcă backup SQLite</a></div>
          <section className="surface archive-list"><div className="table-toolbar"><div><span className="eyebrow">{records.documents.length} DOCUMENTE</span><h2>Fișiere scanate</h2></div></div>
            {records.documents.length ? records.documents.map((doc) => <div className="archive-row" key={doc.id}><span className="archive-file"><Paperclip size={19} /></span><span className="archive-name"><strong>{doc.name}</strong><small>{doc.category.toUpperCase()} · {formatDateTime(doc.uploadedAt)} · {(doc.size / 1024).toFixed(0)} KB</small>{doc.archiveError && <small className="error-text">{doc.archiveError}</small>}</span><span className={"status-pill " + (doc.archiveStatus === "uploaded" ? "status-good" : doc.archiveStatus === "failed" ? "status-warn" : "status-muted")}>{doc.archiveStatus === "uploaded" ? "Arhivat FTP" : doc.archiveStatus === "failed" ? "Eșuat" : "Local"}</span><a className="icon-button" target="_blank" rel="noreferrer" href={doc.url} title="Vizualizează"><Eye size={18} /></a>{doc.archiveStatus !== "uploaded" && <button className="icon-button" title="Reîncearcă încărcarea" onClick={() => retryDocument(doc.id)}><ArrowClockwise size={18} /></button>}</div>) : <EmptyState icon={CloudArrowUp} title="Arhiva este goală." detail="Fișierele originale apar aici după încărcare și confirmare." />}
          </section>
          <div className="backup-note"><ShieldCheck size={18} /><span>Backup-ul descarcă o copie SQLite coerentă. Păstrează fișierul într-un loc sigur.</span></div>
        </div>}

        {view === "calendar" && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">ISTORIC PE ZILE</span><h1>Calendar financiar</h1><p>Selectează o zi pentru a vedea facturi confirmate, lucrări, încasări, cheltuieli și schimbări.</p></div><label className="date-picker"><CalendarBlank size={18} /><input type="date" value={calendarDate} onChange={(e) => setCalendarDate(e.target.value)} /></label></div>
          <section className="surface calendar-surface"><div className="surface-heading"><div><span className="eyebrow">{formatDate(calendarDate)}</span><h2>Operațiunile zilei</h2></div><span className="period-chip">{calendar.entries.length} intrări</span></div>
            {calendar.entries.length ? <div className="calendar-list">{calendar.entries.map((item, index) => <div className="calendar-entry" key={item.id + index}><span className="calendar-entry-icon"><ClockCounterClockwise size={17} /></span><div><strong>{item.title}</strong><small>{item.type} · {formatDateTime(item.date)}</small></div>{item.amount !== undefined && <b>{formatMoney(item.amount)}</b>}</div>)}</div> : <EmptyState icon={CalendarDots} title="Nu sunt operațiuni în ziua selectată." detail="Nicio valoare nu este completată automat." />}
          </section>
        </div>}

        {view === "activity" && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">JURNAL AUDIT · VALORI VECHI ȘI NOI</span><h1>Istoric operațiuni</h1><p>Modificările sunt înregistrate cu dată, oră și utilizator.</p></div></div>
          <section className="surface archive-list"><div className="table-toolbar"><div><span className="eyebrow">{records.activity.length} EVENIMENTE RECENTE</span><h2>Activitate financiară</h2></div></div>
            {records.activity.length ? records.activity.map((item) => <div className="history-row" key={item.id}><span className="archive-file"><ClockCounterClockwise size={18} /></span><div className="history-content"><strong>{item.type} · {item.action}</strong><small>{formatDateTime(item.date)} · {item.actor}</small>{(item.oldValue || item.newValue) && <details><summary>Vezi schimbarea</summary><div className="history-values">{item.oldValue && <span><small>Înainte</small><code>{JSON.stringify(item.oldValue)}</code></span>}{item.newValue && <span><small>După</small><code>{JSON.stringify(item.newValue)}</code></span>}</div></details>}</div></div>) : <EmptyState icon={ClockCounterClockwise} title="Istoricul este gol." detail="Operațiunile confirmate și modificările vor apărea aici." />}
          </section>
        </div>}

        {view === "settings" && settings && <div className="page-view">
          <div className="page-heading"><div><span className="eyebrow">PREFERINȚE ȘI CONECTĂRI</span><h1>Setări</h1><p>Personalitatea lui Nicu, formule de profit și arhivare securizată.</p></div></div>
          <div className="settings-grid">
            <section className="surface settings-card"><div className="surface-heading"><div><span className="eyebrow">NICU BOT</span><h2>Personalitatea lui Nicu</h2></div><Robot size={20} className="accent-icon" /></div>
              <label className="settings-line"><span><strong>Notificări contextuale</strong><small>Mesaje legate de operațiunile reale</small></span><input type="checkbox" checked={settings.preferences.notifications} onChange={(e) => changePref("notifications", e.target.checked)} /></label>
              <label className="settings-field"><span>Nivel de sarcasm</span><select value={settings.preferences.sarcasmLevel} onChange={(e) => changePref("sarcasmLevel", e.target.value)}><option>NORMAL</option><option>OBRAZNIC</option><option>NEMILOS</option></select></label>
              <label className="settings-line"><span><strong>Sunete</strong><small>Feedback audio în aplicație</small></span><input type="checkbox" checked={settings.preferences.sounds} onChange={(e) => changePref("sounds", e.target.checked)} /></label>
              <label className="settings-field"><span>Animații</span><select value={settings.preferences.animation} onChange={(e) => changePref("animation", e.target.value)}><option value="none">Dezactivate</option><option value="discrete">Discrete</option><option value="full">Fluide</option></select></label>
              <div className="roast-count"><Sparkle size={17} /><strong>{ROAST_COUNT}</strong><span>replici unice în biblioteca locală</span></div>
              <div className="custom-roast"><input id="custom-roast" placeholder="Adaugă o replică personalizată" /><button className="soft-button" onClick={() => { const input = document.getElementById("custom-roast"); if (input.value.trim()) { changePref("customRoasts", [...settings.preferences.customRoasts, input.value.trim()]); input.value = ""; } }}><Plus size={15} /> Adaugă</button></div>
              {settings.preferences.customRoasts.length > 0 && <button className="text-button" onClick={() => changePref("customRoasts", [])}>Resetează replicile personalizate ({settings.preferences.customRoasts.length})</button>}
              <button className="primary-button full-button" onClick={savePreferences}><FloppyDisk size={17} /> Salvează preferințele</button>
            </section>
            <section className="surface settings-card"><div className="surface-heading"><div><span className="eyebrow">FORMULA PROFITULUI</span><h2>Venituri și costuri eligibile</h2></div><SlidersHorizontal size={20} className="accent-icon" /></div>
              <label className="settings-line"><span><strong>Include veniturile din Caietul</strong><small>Valoarea lucrărilor; încasările rămân distincte</small></span><input type="checkbox" checked={settings.preferences.includeJobRevenue !== false} onChange={(e) => changePref("includeJobRevenue", e.target.checked)} /></label>
              <div className="category-checks"><strong>Cheltuieli incluse în profit</strong>{CATEGORY_OPTIONS.map((category) => <label key={category}><span>{category}</span><input type="checkbox" checked={settings.preferences.eligibleExpenseCategories.includes(category)} onChange={(e) => changePref("eligibleExpenseCategories", e.target.checked ? [...settings.preferences.eligibleExpenseCategories, category] : settings.preferences.eligibleExpenseCategories.filter((x) => x !== category))} /></label>)}</div>
              <div className="formula-note"><Info size={17} /><span>Profit estimat = venituri eligibile din Caietul − cheltuieli eligibile − obligații salariale. Facturile nu sunt venit.</span></div>
              <button className="primary-button full-button" onClick={savePreferences}><FloppyDisk size={17} /> Salvează formula</button>
            </section>
            <section className="surface settings-card ftp-card"><div className="surface-heading"><div><span className="eyebrow">ARHIVARE OFF-SITE</span><h2>FTP / SFTP</h2></div><CloudArrowUp size={20} className="accent-icon" /></div>
              <div className="ftp-note"><LockKey size={17} />Parola este criptată pe server și nu se întoarce în frontend.</div>
              <div className="form-grid ftp-grid"><label className="form-field">Protocol<select value={archiveSettings?.protocol || "sftp"} onChange={(e) => updateArchiveField("protocol", e.target.value)}><option value="sftp">SFTP</option><option value="ftp">FTP</option></select></label><label className="form-field">Port<input type="number" value={archiveSettings?.port || 22} onChange={(e) => updateArchiveField("port", e.target.value)} /></label><label className="form-field">Server<input value={archiveSettings?.host || ""} onChange={(e) => updateArchiveField("host", e.target.value)} placeholder="ftp.exemplu.ro" /></label><label className="form-field">Utilizator<input value={archiveSettings?.username || ""} onChange={(e) => updateArchiveField("username", e.target.value)} /></label><label className="form-field">Parolă<div className="password-field"><input type="password" value={archivePassword} onChange={(e) => setArchivePassword(e.target.value)} placeholder={archiveSettings?.hasPassword ? "Salvată · gol = păstrează" : "Nu este configurată"} /><LockKey size={17} /></div></label><label className="form-field">Director rădăcină<input value={archiveSettings?.rootDirectory || "/NICUBANK"} onChange={(e) => updateArchiveField("rootDirectory", e.target.value)} /></label></div>
              <label className="settings-line"><span><strong>Încărcare automată</strong><small>FACTURI / CAIETUL / DOCUMENTE / RAPOARTE · an/lună/zi</small></span><input type="checkbox" checked={Boolean(archiveSettings?.autoUpload)} onChange={(e) => updateArchiveField("autoUpload", e.target.checked)} /></label>
              <div className="ftp-actions"><button className="soft-button" disabled={archiveBusy} onClick={testArchive}><CheckCircle size={17} /> Test conexiune</button><button className="primary-button" disabled={archiveBusy} onClick={saveArchive}><FloppyDisk size={17} /> Salvează conexiunea</button></div>
            </section>
            <section className="surface settings-card ai-card"><div className="surface-heading"><div><span className="eyebrow">OCR LOCAL + AI OPȚIONAL</span><h2>Procesarea documentelor</h2></div><Sparkle size={20} className="accent-icon" /></div>
              <div className="integration-status"><span className={"live-dot " + (integrations.aiAvailable ? "" : "dot-muted")} /><strong>{integrations.aiAvailable ? "OpenAI conectat" : "OCR local disponibil"}</strong><small>{integrations.aiAvailable ? "Model: " + integrations.aiModel : "OCR AI se activează din variabilele de mediu ale serverului."}</small></div>
              <p className="settings-copy">OCR-ul Tesseract rulează în browser și poate descărca prima dată datele lingvistice românești. Pentru extragerea AI, adaugă <code>OPENAI_API_KEY</code> și opțional <code>OPENAI_MODEL</code> în fișierul <code>.env</code> de lângă aplicație, apoi repornește serverul. Fotografia este trimisă furnizorului doar când alegi „Extragere AI”.</p>
            </section>
          </div>
        </div>}
      </div>
      <footer className="app-footer"><span>NICUBANK · Banii intră, banii ies. Noi măcar știm pe unde!</span><span><ShieldCheck size={14} /> Date locale · sesiune securizată</span></footer>
    </main>

    <nav className="mobile-nav">{[["dashboard", House, "Acasă"], ["invoices", Receipt, "Facturi"], ["jobs", Notebook, "Caietul"], ["receipts", Wallet, "Încasări"]].map(([key, Icon, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => nav(key)}><Icon size={21} /><small>{label}</small></button>)}<button className={showMobileMenu ? "active" : ""} onClick={() => setShowMobileMenu(true)}><DotsNine size={21} /><small>Meniu</small></button></nav>
    {showMobileMenu && <div className="mobile-menu-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowMobileMenu(false); }}><section className="mobile-menu-sheet"><div className="mobile-menu-head"><strong>Toate modulele</strong><button className="icon-button" onClick={() => setShowMobileMenu(false)}><X size={19} /></button></div><div className="mobile-menu-grid">{NAV.map(([key, label]) => { const Icon = ICONS[key]; return <button key={key} className={view === key ? "active" : ""} onClick={() => { nav(key); setShowMobileMenu(false); }}><Icon size={20} /><span>{label}</span></button>; })}</div></section></div>}
    {modal && <FormDialog key={modal.type + (modal.record?.id || "new")} type={modal.type} record={modal.record} jobs={records.jobs} employees={records.employees} aiAvailable={integrations.aiAvailable} onClose={() => setModal(null)} onSubmit={submitForm} toast={notify} />}
    {busy && <div className="saving-indicator"><CircleNotch size={16} className="spin" /> Salvez în baza de date…</div>}
    {toast && <div className={"toast toast-" + toast.kind}><img className="toast-mark" src="/assets/nicubank-mark.jpg" alt="" /><span>{toast.kind === "error" ? <WarningCircle size={18} /> : <CheckCircle size={18} />}</span>{toast.message}<button onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}

export default App;
