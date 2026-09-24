import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5',
  campaign: {
    script: '',
  },
  auto: {
    dailyCap: 25,
    minDelaySec: 120,
    maxDelaySec: 360,
    breakEvery: 10,
    breakMinMin: 10,
    breakMaxMin: 25,
    startHour: 9,
    endHour: 21,
    // Sending windows, each with its own cap. When set, they replace startHour/endHour.
    windows: [],
  },
  browser: { channel: 'chrome' },
};

function merge(base, over) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = merge(base[k], over[k]);
  return out;
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'dm-pilot.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT,
      data TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const rowToLead = (r) => r && { ...r, data: r.data ? JSON.parse(r.data) : {} };

  return {
    // ---- settings ----
    getSettings() {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'main'`).get();
      return merge(DEFAULT_SETTINGS, row ? JSON.parse(row.value) : {});
    },
    saveSettings(patch) {
      const next = merge(this.getSettings(), patch);
      db.prepare(`INSERT INTO settings (key, value) VALUES ('main', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(next));
      return next;
    },

    // ---- leads ----
    listLeads() {
      return db.prepare(`SELECT * FROM leads ORDER BY id`).all().map(rowToLead);
    },
    getLead(id) {
      return rowToLead(db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id));
    },
    insertLead({ username, name, data }) {
      const r = db.prepare(`INSERT OR IGNORE INTO leads (username, name, data, created_at)
        VALUES (?, ?, ?, ?)`).run(username, name || '', JSON.stringify(data || {}), new Date().toISOString());
      return r.changes > 0;
    },
    updateLead(id, fields) {
      const allowed = ['message', 'status', 'error', 'sent_at', 'name'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      db.prepare(`UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k] ?? null), id);
    },
    deleteLead(id) {
      db.prepare(`DELETE FROM leads WHERE id = ?`).run(id);
    },
    deleteAllLeads() {
      return db.prepare(`DELETE FROM leads`).run().changes;
    },
    nextReady() {
      return rowToLead(db.prepare(`SELECT * FROM leads WHERE status = 'ready'
        AND message IS NOT NULL AND trim(message) <> '' ORDER BY id LIMIT 1`).get());
    },
    counts() {
      const out = { new: 0, ready: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
      for (const r of db.prepare(`SELECT status, COUNT(*) n FROM leads GROUP BY status`).all()) {
        out[r.status] = r.n;
        out.total += r.n;
      }
      return out;
    },
    sentBetween(from, to) {
      return db.prepare(`SELECT COUNT(*) n FROM leads WHERE status = 'sent' AND sent_at >= ? AND sent_at < ?`)
        .get(from.toISOString(), to.toISOString()).n;
    },
    sentToday() {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return db.prepare(`SELECT COUNT(*) n FROM leads WHERE status = 'sent' AND sent_at >= ?`)
        .get(midnight.toISOString()).n;
    },

    // ---- logs ----
    log(level, text) {
      db.prepare(`INSERT INTO logs (ts, level, text) VALUES (?, ?, ?)`).run(new Date().toISOString(), level, text);
      console.log(`[${level}] ${text}`);
    },
    recentLogs(limit = 100) {
      return db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`).all(limit);
    },
  };
}
