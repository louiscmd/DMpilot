const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

// ---------- tabs ----------
let activeTab = 'leads';
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  activeTab = b.dataset.tab;
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + activeTab));
  if (activeTab === 'leads') loadLeads();
  if (activeTab === 'send') loadLogs();
}));

// ---------- leads ----------
let leads = [];
const selected = new Set();

async function loadLeads() {
  leads = await api('/leads');
  renderLeads();
}

function renderLeads() {
  const f = $('#filter').value;
  const rows = leads.filter((l) => f === 'all' || l.status === f);
  $('#empty').hidden = leads.length > 0;
  $('#lead-rows').innerHTML = rows.map((l) => {
    const d = l.data || {};
    const sub = [d.category, [d.city, d.state].filter(Boolean).join(', '), d.followerCount && `${d.followerCount} followers`].filter(Boolean).join(' · ');
    const locked = l.status === 'sent';
    return `<tr data-id="${l.id}">
      <td><input type="checkbox" class="row-check" ${selected.has(l.id) ? 'checked' : ''}></td>
      <td class="acct"><a href="https://www.instagram.com/${esc(l.username)}/" target="_blank" rel="noreferrer">@${esc(l.username)}</a>
        <div>${esc(l.name)}</div><div class="sub">${esc(sub)}</div></td>
      <td class="msg">${locked ? `<div style="white-space:pre-wrap;padding:4px 6px">${esc(l.message)}</div>`
        : `<textarea rows="${Math.max(2, Math.ceil((l.message || '').length / 90))}" placeholder="No message yet. Write one or let Claude do it.">${esc(l.message)}</textarea>`}
        ${l.error ? `<div class="err">${esc(l.error)}</div>` : ''}</td>
      <td><span class="pill ${l.status}">${l.status}</span>
        <div class="row-actions">${locked ? '' : '<button data-act="regen">Rewrite</button>'}
          ${['failed', 'skipped', 'sent'].includes(l.status) ? '<button data-act="requeue">Requeue</button>' : ''}</div></td>
    </tr>`;
  }).join('');
  $('#check-all').checked = rows.length > 0 && rows.every((l) => selected.has(l.id));
  renderBulk();
}

function renderCounts(c) {
  $('#counts').innerHTML = ['total', 'new', 'ready', 'sent', 'failed', 'skipped']
    .map((k) => `<span>${k === 'total' ? 'Total' : k[0].toUpperCase() + k.slice(1)} <b>${c[k] || 0}</b></span>`).join('');
}

function renderBulk() {
  $('#bulk').hidden = selected.size === 0;
  $('#bulk-n').textContent = `${selected.size} selected`;
}

$('#filter').addEventListener('change', renderLeads);
$('#check-all').addEventListener('change', (e) => {
  const f = $('#filter').value;
  leads.filter((l) => f === 'all' || l.status === f).forEach((l) => e.target.checked ? selected.add(l.id) : selected.delete(l.id));
  renderLeads();
});

$('#lead-rows').addEventListener('change', guarded(async (e) => {
  const id = Number(e.target.closest('tr')?.dataset.id);
  if (e.target.classList.contains('row-check')) {
    e.target.checked ? selected.add(id) : selected.delete(id);
    renderBulk();
  } else if (e.target.tagName === 'TEXTAREA') {
    const updated = await api(`/leads/${id}`, { method: 'PATCH', body: { message: e.target.value } });
    Object.assign(leads.find((l) => l.id === id), updated);
    renderLeads();
  }
}));

$('#lead-rows').addEventListener('click', guarded(async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const id = Number(e.target.closest('tr').dataset.id);
  if (act === 'regen') { await api('/generate', { body: { ids: [id] } }); toast('Rewriting…'); }
  if (act === 'requeue') { await api('/leads/bulk', { body: { ids: [id], action: 'requeue' } }); await loadLeads(); }
}));

$$('[data-bulk]').forEach((b) => b.addEventListener('click', guarded(async () => {
  const ids = [...selected];
  const action = b.dataset.bulk;
  if (action === 'generate') { await api('/generate', { body: { ids } }); toast(`Writing ${ids.length} DMs…`); return; }
  if (action === 'delete' && !confirm(`Delete ${ids.length} leads?`)) return;
  await api('/leads/bulk', { body: { ids, action } });
  if (action === 'delete') selected.clear();
  await loadLeads();
})));

async function importText(text) {
  const r = await api('/import', { body: { text } });
  toast(`Added ${r.added} leads${r.duplicates ? ` · ${r.duplicates} already in the list` : ''}${r.invalid ? ` · ${r.invalid} without an Instagram handle` : ''}`);
  await loadLeads();
}
$('#file').addEventListener('change', guarded(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) await importText(await file.text());
}));
$('#paste-open').addEventListener('click', () => { $('#paste-text').value = ''; $('#paste-dialog').showModal(); });
$('#paste-go').addEventListener('click', guarded(async () => {
  const text = $('#paste-text').value;
  if (text.trim()) await importText(text);
}));

$('#gen-btn').addEventListener('click', guarded(async () => {
  await api('/generate', { body: {} });
  toast('Writing DMs for all new leads…');
}));

// ---------- settings + campaign ----------
let settings;
const campaignFields = ['senderName', 'offer', 'tone', 'maxWords', 'language', 'rules', 'example'];
const autoFields = ['dailyCap', 'startHour', 'endHour', 'minDelaySec', 'maxDelaySec', 'breakEvery', 'breakMinMin', 'breakMaxMin'];

async function loadSettings() {
  settings = await api('/settings');
  campaignFields.forEach((k) => ($('#c-' + k).value = settings.campaign[k] ?? ''));
  autoFields.forEach((k) => ($('#a-' + k).value = settings.auto[k]));
  $('#s-model').value = settings.model;
  $('#s-channel').value = settings.browser.channel;
  $('#s-apiKey').value = '';
  $('#s-key-note').textContent = settings.hasApiKey ? 'A key is saved. Leave blank to keep it.' : 'Get one at console.anthropic.com. It is stored only on this computer.';
  $('#cap-warn').hidden = settings.auto.dailyCap <= 50;
}

function flashSaved(btn) {
  const s = btn.parentElement.querySelector('.saved');
  s.textContent = 'Saved';
  setTimeout(() => (s.textContent = ''), 2000);
}

$('#save-campaign').addEventListener('click', guarded(async (e) => {
  const campaign = Object.fromEntries(campaignFields.map((k) => [k, k === 'maxWords' ? Number($('#c-' + k).value) || 60 : $('#c-' + k).value]));
  await api('/settings', { method: 'PUT', body: { campaign } });
  await loadSettings();
  flashSaved(e.target);
}));

$('#save-settings').addEventListener('click', guarded(async (e) => {
  const auto = Object.fromEntries(autoFields.map((k) => [k, Number($('#a-' + k).value)]));
  if (auto.minDelaySec > auto.maxDelaySec) throw new Error('Min gap must be less than max gap');
  if (auto.breakMinMin > auto.breakMaxMin) throw new Error('Break min must be less than break max');
  await api('/settings', { method: 'PUT', body: {
    apiKey: $('#s-apiKey').value.trim(), model: $('#s-model').value, auto, browser: { channel: $('#s-channel').value },
  } });
  await loadSettings();
  flashSaved(e.target);
}));
$('#a-dailyCap').addEventListener('input', (e) => ($('#cap-warn').hidden = Number(e.target.value) <= 50));

// ---------- sending ----------
const PHASES = {
  idle: 'Idle', starting: 'Starting', opening: 'Opening chat', typing: 'Typing', waiting_user: 'Your turn: press Enter',
  sending: 'Sending', waiting: 'Waiting', break: 'On a break', sleeping: 'Outside active hours', cap: 'Daily cap reached',
  paused: 'Paused', done: 'All done',
};

$('#browser-open').addEventListener('click', guarded(async (e) => {
  e.target.disabled = true;
  try { await api('/browser/open', { body: {} }); } finally { e.target.disabled = false; }
  refresh();
}));
$('#browser-close').addEventListener('click', guarded(async () => { await api('/browser/close', { body: {} }); refresh(); }));
$('#run-start').addEventListener('click', guarded(async () => {
  const mode = $('input[name="mode"]:checked').value;
  if (mode === 'auto' && !confirm('Automatic mode sends DMs with no one watching. This breaks Instagram\'s terms and can get the account restricted or banned. Start anyway?')) return;
  await api('/run/start', { body: { mode } });
  refresh();
}));
$('#run-stop').addEventListener('click', guarded(async () => { await api('/run/stop', { body: {} }); refresh(); }));
$('#run-skip').addEventListener('click', guarded(() => api('/run/skip', { body: {} })));
$('#run-mark').addEventListener('click', guarded(() => api('/run/mark-sent', { body: {} })));

function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

let lastState;
function renderState(st) {
  lastState = st;
  const b = st.browser;
  $('#sb-browser').innerHTML = `<i class="dot ${b.open ? (b.loggedIn ? 'on' : 'half') : ''}"></i><span>${b.open ? (b.loggedIn ? 'Instagram logged in' : 'Log in to Instagram') : 'Browser closed'}</span>`;
  $('#sb-today').textContent = `${st.sentToday} / ${st.dailyCap} sent today`;
  renderCounts(st.counts);

  const g = st.gen;
  $('#gen-status').textContent = g.running ? `Writing ${g.done}/${g.total}…` : g.failed ? `${g.failed} failed: ${g.lastError}` : '';
  $('#gen-btn').disabled = g.running;

  const r = st.runner;
  $('#now-phase').textContent = PHASES[r.phase] || r.phase;
  $('#now-phase').className = 'phase ' + r.phase;
  let detail = r.detail || '';
  if (r.nextAt) detail += ` · ${fmtLeft(r.nextAt - Date.now())}`;
  $('#now-detail').textContent = detail;
  $('#now-lead').hidden = !r.lead;
  if (r.lead) {
    $('#now-user').textContent = '@' + r.lead.username + (r.lead.name ? ` · ${r.lead.name}` : '');
    $('#now-user').href = `https://www.instagram.com/${r.lead.username}/`;
    $('#now-msg').textContent = r.lead.message;
  }
  $('#now-actions').hidden = !r.running;
  $('#run-mark').hidden = r.mode !== 'assist' || r.phase !== 'waiting_user';
  $('#run-skip').textContent = r.mode === 'auto' && r.nextAt ? 'Skip wait' : 'Skip';
  $('#run-start').disabled = r.running || !b.open;
  $('#run-stop').disabled = !r.running;
  $$('input[name="mode"]').forEach((i) => (i.disabled = r.running));
  $('#queue-line').textContent = `${st.counts.ready || 0} ready in queue`;
  $('#browser-help').textContent = b.open && !b.loggedIn
    ? 'Log in to Instagram in the window that opened. You only need to do this once.'
    : 'Opens a separate browser window just for DM Pilot. Log in to Instagram there once; it stays logged in.';
}

let genWasRunning = false;
async function refresh() {
  try {
    const st = await api('/state');
    renderState(st);
    const editing = document.activeElement?.closest('#lead-rows');
    if ((st.gen.running || genWasRunning) && activeTab === 'leads' && !editing) loadLeads();
    genWasRunning = st.gen.running;
    if (activeTab === 'send') loadLogs();
  } catch { /* server restarting */ }
}

async function loadLogs() {
  const logs = await api('/logs');
  $('#log').innerHTML = logs.map((l) => `<li><time>${new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span class="${l.level}">${esc(l.text)}</span></li>`).join('');
}

// Countdown ticks between polls.
setInterval(() => { if (lastState?.runner.nextAt) renderState(lastState); }, 1000);
setInterval(refresh, 2000);

loadSettings();
loadLeads();
refresh();
