import express from 'express';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { parseLeads } from './importer.js';
import { writeDM } from './ai.js';
import { Instagram } from './instagram.js';
import { Runner } from './runner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const PORT = Number(process.env.PORT) || 4777;

const db = openDb(dataDir);
const ig = new Instagram(path.join(dataDir, 'browser-profile'));
const runner = new Runner({ db, ig });
const gen = { running: false, total: 0, done: 0, failed: 0, lastError: '' };

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(root, 'public')));

const publicSettings = (s) => ({ ...s, apiKey: '', hasApiKey: !!(s.apiKey || process.env.ANTHROPIC_API_KEY) });
const handle = (fn) => async (req, res) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/state', handle(async () => {
  const s = db.getSettings();
  return {
  setup: { hasApiKey: !!(s.apiKey || process.env.ANTHROPIC_API_KEY), hasOffer: !!s.campaign.offer.trim() },
  browser: { open: ig.isOpen, loggedIn: await ig.loggedIn() },
  runner: runner.state,
  gen,
  counts: db.counts(),
  sentToday: db.sentToday(),
  dailyCap: s.auto.dailyCap,
  mode: runner.state.mode,
  };
}));

// ---- leads ----
app.get('/api/leads', handle(() => db.listLeads()));

app.post('/api/import', handle((req) => {
  const { leads, invalid } = parseLeads(String(req.body.text || ''));
  let added = 0;
  for (const l of leads) if (db.insertLead(l)) added++;
  db.log('info', `Imported ${added} leads (${leads.length - added} duplicates, ${invalid} without an Instagram handle)`);
  return { added, duplicates: leads.length - added, invalid };
}));

app.patch('/api/leads/:id', handle((req) => {
  const id = Number(req.params.id);
  const lead = db.getLead(id);
  if (!lead) throw new Error('Lead not found');
  const patch = {};
  if (typeof req.body.message === 'string') {
    patch.message = req.body.message.trim();
    if (['new', 'ready'].includes(lead.status)) patch.status = patch.message ? 'ready' : 'new';
  }
  if (req.body.status) {
    patch.status = req.body.status;
    if (req.body.status === 'ready' && !(patch.message ?? lead.message)) patch.status = 'new';
    if (req.body.status !== 'sent') patch.sent_at = null;
    patch.error = null;
  }
  db.updateLead(id, patch);
  return db.getLead(id);
}));

app.post('/api/leads/bulk', handle((req) => {
  const { ids = [], action } = req.body;
  for (const id of ids) {
    const lead = db.getLead(id);
    if (!lead) continue;
    if (action === 'delete') db.deleteLead(id);
    else if (action === 'skip') db.updateLead(id, { status: 'skipped' });
    else if (action === 'requeue') db.updateLead(id, { status: lead.message ? 'ready' : 'new', error: null, sent_at: null });
    else if (action === 'clear') db.updateLead(id, { message: '', status: lead.status === 'sent' ? 'sent' : 'new' });
  }
}));

app.post('/api/leads/delete-all', handle(() => {
  if (runner.state.running) throw new Error('Stop sending before deleting leads');
  const n = db.deleteAllLeads();
  db.log('info', `Deleted all ${n} leads`);
  return { deleted: n };
}));

// ---- message writing ----
async function generate(ids) {
  const settings = db.getSettings();
  if (!settings.apiKey && !process.env.ANTHROPIC_API_KEY) throw new Error('Add your Claude API key in Settings first');
  if (!settings.campaign.offer.trim()) throw new Error('Describe your offer in the Campaign tab first');
  const queue = ids.map((id) => db.getLead(id)).filter((l) => l && l.status !== 'sent');
  Object.assign(gen, { running: true, total: queue.length, done: 0, failed: 0, lastError: '' });
  const worker = async () => {
    for (let lead = queue.shift(); lead; lead = queue.shift()) {
      try {
        const message = await writeDM(lead, settings);
        const current = db.getLead(lead.id);
        if (current && current.status !== 'sent') db.updateLead(lead.id, { message, status: 'ready', error: null });
      } catch (e) {
        gen.failed++;
        gen.lastError = e.message;
        db.log('error', `Writing DM for @${lead.username} failed: ${e.message}`);
      }
      gen.done++;
    }
  };
  Promise.all([worker(), worker(), worker(), worker()]).finally(() => {
    gen.running = false;
    db.log('info', `Wrote ${gen.done - gen.failed} DMs${gen.failed ? `, ${gen.failed} failed` : ''}`);
  });
}

app.post('/api/generate', handle(async (req) => {
  if (gen.running) throw new Error('Already writing messages');
  let ids = req.body.ids;
  if (!ids?.length) ids = db.listLeads().filter((l) => l.status === 'new').map((l) => l.id);
  if (!ids.length) throw new Error('No leads to write messages for');
  await generate(ids);
}));

// ---- settings ----
app.get('/api/settings', handle(() => publicSettings(db.getSettings())));
app.put('/api/settings', handle((req) => {
  const patch = { ...req.body };
  delete patch.hasApiKey;
  if (!patch.apiKey) delete patch.apiKey; // blank field keeps the stored key
  return publicSettings(db.saveSettings(patch));
}));

// ---- browser + sending ----
app.post('/api/browser/open', handle(async () => { await ig.launch(db.getSettings().browser.channel); }));
app.post('/api/browser/close', handle(async () => { runner.stop(); await ig.close(); }));
app.post('/api/run/start', handle(async (req) => {
  if (!(await ig.loggedIn())) throw new Error('Log in to Instagram in the DM Pilot window first');
  runner.start(req.body.mode === 'auto' ? 'auto' : 'assist');
}));
app.post('/api/run/stop', handle(() => runner.stop()));
app.post('/api/run/skip', handle(() => runner.skip()));
app.post('/api/run/mark-sent', handle(() => runner.markSent()));
app.post('/api/run/reset', handle(() => { if (!runner.state.running) Object.assign(runner.state, { phase: 'idle', detail: '' }); }));

app.get('/api/logs', handle(() => db.recentLogs(150)));

const url = `http://127.0.0.1:${PORT}`;
const openInBrowser = () => {
  if (process.argv.includes('--open')) exec(process.platform === 'win32' ? `start "" ${url}` : `open ${url}`);
};

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DM Pilot is running at ${url}\n  It should open in your browser now. Keep this window open while you use it.\n`);
  openInBrowser();
});
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Already running (e.g. launched twice): just bring up the existing one.
  console.log(`\n  DM Pilot is already running. Opening ${url}\n`);
  openInBrowser();
  setTimeout(() => process.exit(3), 1500);
});

process.on('SIGINT', async () => { await ig.close(); process.exit(0); });
