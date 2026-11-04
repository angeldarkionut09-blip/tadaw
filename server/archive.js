import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import { db, getSetting, saveSetting, nowIso } from "./db.js";

const dataDir = resolve(process.env.NICUBANK_DATA_DIR || "server/data");
const keyFile = resolve(dataDir, "local-encryption.key");
mkdirSync(dirname(keyFile), { recursive: true });
if (!existsSync(keyFile)) {
  const key = randomBytes(32);
  try { const fd = openSync(keyFile, "wx", 0o600); writeFileSync(fd, key); closeSync(fd); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
const environmentKey = process.env.APP_SECRET ? Buffer.from(process.env.APP_SECRET, "hex") : null;
if (environmentKey && environmentKey.length !== 32) throw new Error("APP_SECRET trebuie să conțină exact 64 de caractere hexazecimale.");
const encryptionKey = environmentKey || readFileSync(keyFile);

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function unseal(value) {
  const raw = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}

export function readArchiveSettings(userId) {
  const encrypted = getSetting(userId, "ftpEncrypted");
  let config = {};
  if (encrypted) {
    try { config = unseal(encrypted); } catch { config = {}; }
  }
  return {
    protocol: config.protocol || "sftp", host: config.host || "", port: config.port || (config.protocol === "ftp" ? 21 : 22),
    username: config.username || "", rootDirectory: config.rootDirectory || "/NICUBANK",
    autoUpload: Boolean(config.autoUpload), hasPassword: Boolean(config.password),
  };
}

export function saveArchiveSettings(userId, incoming) {
  const previous = (() => {
    const v = getSetting(userId, "ftpEncrypted");
    try { return v ? unseal(v) : {}; } catch { return {}; }
  })();
  const password = typeof incoming.password === "string" && incoming.password ? incoming.password : previous.password || "";
  const protocol = incoming.protocol === "ftp" ? "ftp" : "sftp";
  const port = Number(incoming.port || (protocol === "ftp" ? 21 : 22));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port invalid.");
  const config = {
    protocol, host: String(incoming.host || "").trim().slice(0, 255), port,
    username: String(incoming.username || "").trim().slice(0, 255), password,
    rootDirectory: (String(incoming.rootDirectory || "/NICUBANK").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/NICUBANK").slice(0, 255),
    autoUpload: Boolean(incoming.autoUpload),
  };
  saveSetting(userId, "ftpEncrypted", seal(config));
  return readArchiveSettings(userId);
}

async function withConnection(config, action) {
  if (!config.host || !config.username || !config.password) throw new Error("Completează serverul, utilizatorul și parola FTP/SFTP în Setări.");
  if (config.protocol === "ftp") {
    const client = new FtpClient(12_000);
    try {
      await client.access({ host: config.host, port: config.port, user: config.username, password: config.password, secure: false });
      return await action({ mkdir: async (path) => client.ensureDir(path), put: async (local, remote) => client.uploadFrom(local, remote), close: () => client.close() });
    } finally { client.close(); }
  }
  const client = new SftpClient("nicubank-archive");
  try {
    await client.connect({ host: config.host, port: config.port, username: config.username, password: config.password, readyTimeout: 12_000 });
    return await action({ mkdir: async (path) => client.mkdir(path, true).catch((error) => { if (!/exist/i.test(error.message)) throw error; }), put: async (local, remote) => client.put(local, remote), close: () => client.end() });
  } finally { await client.end().catch(() => {}); }
}

export async function testArchiveConnection(userId) {
  const encrypted = getSetting(userId, "ftpEncrypted");
  if (!encrypted) throw new Error("Salvează mai întâi configurația FTP/SFTP.");
  const config = unseal(encrypted);
  const started = Date.now();
  await withConnection(config, async ({ close }) => close());
  return { success: true, elapsedMs: Date.now() - started };
}

export async function archiveDocument(documentId, userId) {
  const doc = db.prepare("SELECT * FROM documents WHERE id=? AND user_id=?").get(documentId, userId);
  if (!doc) throw new Error("Documentul nu există.");
  const encrypted = getSetting(userId, "ftpEncrypted");
  if (!encrypted) throw new Error("Configurează mai întâi FTP/SFTP.");
  const config = unseal(encrypted);
  const date = new Date(doc.uploaded_at);
  const datePath = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
  const category = doc.category === "facturi" ? "FACTURI" : doc.category === "caiet" ? "CAIETUL" : doc.category === "rapoarte" ? "RAPOARTE" : "DOCUMENTE";
  const folder = `${config.rootDirectory}/${category}/${datePath}`.replace(/\/{2,}/g, "/");
  const remotePath = `${folder}/${doc.stored_name}`;
  db.prepare("UPDATE documents SET archive_status='pending',archive_error=NULL WHERE id=?").run(documentId);
  try {
    await withConnection(config, async ({ mkdir, put }) => { await mkdir(folder); await put(doc.local_path, remotePath); });
    db.prepare("UPDATE documents SET remote_path=?,archive_status='uploaded',archive_error=NULL WHERE id=?").run(remotePath, documentId);
    return { success: true, remotePath };
  } catch (error) {
    db.prepare("UPDATE documents SET archive_status='failed',archive_error=? WHERE id=?").run(String(error.message || error).slice(0, 500), documentId);
    throw error;
  }
}
