const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="i"><use href="#i-${id}"/></svg>`;

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
  toastTimer = setTimeout(() => (t.hidden = true), 3800);
}
const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function avatar(username, cls = '') {
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) % 360;
  const bg = `linear-gradient(135deg, hsl(${h} 78% 62%), hsl(${(h + 45) % 360} 80% 55%))`;
  return `<span class="avatar ${cls}" style="background:${bg}">${esc(username[0]?.toUpperCase() || '?')}</span>`;
}

// ---------- navigation ----------
let activeTab = 'leads';
function go(tab) {
  activeTab = tab;
  $$('.nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'leads') loadLeads();
  if (tab === 'send') loadLogs();
  window.scrollTo(0, 0);
}
$$('.nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

// ---------- leads ----------
let leads = [];
let filter = 'all';
const selected = new Set();

async function loadLeads() {
  leads = await api('/leads');
  for (const id of [...selected]) if (!leads.some((l) => l.id === id)) selected.delete(id);
  renderLeads();
}

function visibleLeads() {
  const q = $('#search').value.trim().toLowerCase();
  return leads.filter((l) => (filter === 'all' || l.status === filter)
    && (!q || l.username.toLowerCase().includes(q) || (l.name || '').toLowerCase().includes(q)));
}

function renderLeads() {
  const rows = visibleLeads();
  $('#empty').hidden = leads.length > 0;
  $('.table-tools').hidden = leads.length === 0;
  $('.table-scroll').hidden = leads.length === 0;
  $('#nav-leads').textContent = leads.length;
  $('#lead-rows').innerHTML = rows.map((l) => {
    const d = l.data || {};
    const meta = [d.category, [d.city, d.state].filter(Boolean).join(', '), d.followerCount && `${d.followerCount} followers`].filter(Boolean).join(' · ');
    const locked = l.status === 'sent';
    return `<tr data-id="${l.id}">
      <td><input type="checkbox" class="row-check" ${selected.has(l.id) ? 'checked' : ''}></td>
      <td><div class="acct">${avatar(l.username)}<div>
        <a href="https://www.instagram.com/${esc(l.username)}/" target="_blank" rel="noreferrer">@${esc(l.username)}</a>
        ${l.name ? `<div class="nm">${esc(l.name)}</div>` : ''}${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</div></div></td>
      <td class="msg">${locked ? `<div class="sent-text">${esc(l.message)}</div>`
        : `<textarea rows="${Math.max(2, Math.ceil((l.message || '').length / 80))}" placeholder="No message yet. Type one, or let Claude write it.">${esc(l.message)}</textarea>`}
        ${l.error ? `<div class="err">${esc(l.error)}</div>` : ''}</td>
      <td><span class="pill ${l.status}">${l.status}</span>
        <div class="row-actions">${locked ? '' : '<button data-act="regen">Rewrite</button>'}
          ${['failed', 'skipped', 'sent'].includes(l.status) ? '<button data-act="requeue">Requeue</button>' : ''}</div></td>
    </tr>`;
  }).join('') || (leads.length ? `<tr><td colspan="4" class="muted" style="text-align:center;padding:30px">No leads match.</td></tr>` : '');
  $('#check-all').checked = rows.length > 0 && rows.every((l) => selected.has(l.id));
  renderBulk();
}

const STATS = [
  ['all', 'Total', 'total', 'var(--muted)'], ['new', 'New', 'new', 'var(--line-2)'], ['ready', 'Ready', 'ready', 'var(--violet)'],
  ['sent', 'Sent', 'sent', 'var(--ok)'], ['failed', 'Failed', 'failed', 'var(--bad)'], ['skipped', 'Skipped', 'skipped', 'var(--warn)'],
];
function renderStats(c) {
  $('#stats').innerHTML = STATS.map(([key, label, count, color]) =>
    `<button class="stat ${filter === key ? 'active' : ''}" data-filter="${key}">
      <div class="stat-label"><i style="background:${color}"></i>${label}</div>
      <div class="stat-value">${c[count] || 0}</div></button>`).join('');
}
$('#stats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  filter = filter === b.dataset.filter ? 'all' : b.dataset.filter;
  if (lastState) renderStats(lastState.counts);
  renderLeads();
});
$('#search').addEventListener('input', renderLeads);

function renderBulk() {
  $('#bulk').hidden = selected.size === 0;
  $('#bulk-n').textContent = `${selected.size} selected`;
}

$('#check-all').addEventListener('change', (e) => {
  visibleLeads().forEach((l) => (e.target.checked ? selected.add(l.id) : selected.delete(l.id)));
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
    refresh();
  }
}));

$('#lead-rows').addEventListener('click', guarded(async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const id = Number(e.target.closest('tr').dataset.id);
  if (act === 'regen') { await api('/generate', { body: { ids: [id] } }); await loadLeads(); refresh(); }
  if (act === 'requeue') { await api('/leads/bulk', { body: { ids: [id], action: 'requeue' } }); await loadLeads(); refresh(); }
}));

$$('[data-bulk]').forEach((b) => b.addEventListener('click', guarded(async () => {
  const ids = [...selected];
  const action = b.dataset.bulk;
  if (action === 'generate') { await api('/generate', { body: { ids } }); toast(`${ids.length} DMs ready`); await loadLeads(); refresh(); return; }
  if (action === 'delete' && !confirm(`Delete ${ids.length} lead${ids.length > 1 ? 's' : ''}?`)) return;
  await api('/leads/bulk', { body: { ids, action } });
  if (action === 'delete') selected.clear();
  await loadLeads();
  refresh();
})));

$('#delete-all').addEventListener('click', guarded(async () => {
  if (!leads.length) return toast('The list is already empty');
  if (!confirm(`Delete all ${leads.length} leads? Their messages and send history are removed too.`)) return;
  const r = await api('/leads/delete-all', { body: {} });
  selected.clear();
  toast(`Deleted ${r.deleted} leads`);
  await loadLeads();
  refresh();
}));

async function importText(text) {
  const r = await api('/import', { body: { text } });
  toast(`Added ${r.added} lead${r.added === 1 ? '' : 's'}${r.duplicates ? ` · ${r.duplicates} already in the list` : ''}${r.invalid ? ` · ${r.invalid} without an Instagram handle` : ''}`);
  await loadLeads();
  refresh();
}
for (const input of ['#file', '#file2']) {
  $(input).addEventListener('change', guarded(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importText(await file.text());
  }));
}
$('#paste-open').addEventListener('click', () => { $('#paste-text').value = ''; $('#paste-dialog').showModal(); });
$('#paste-go').addEventListener('click', guarded(async () => {
  const text = $('#paste-text').value;
  if (text.trim()) await importText(text);
}));

$('#gen-btn').addEventListener('click', guarded(async () => {
  const before = lastState?.counts.new || 0;
  await api('/generate', { body: {} });
  toast(`${before} DMs ready. Filter by Ready to review them.`);
  await loadLeads();
  refresh();
}));

// ---------- setup checklist ----------
function renderSetup(st) {
  const c = st.counts;
  const steps = [
    { done: st.setup.hasScript, title: 'Write your DM script', text: 'Campaign tab — use {{businessName}}', act: () => go('campaign') },
    { done: c.total > 0, title: 'Import leads', text: 'Your LeadOS .json export', act: () => $('#file').click() },
    { done: (c.ready || 0) + (c.sent || 0) > 0, title: 'Apply the script', text: 'Fills {{businessName}} for each lead', act: () => $('#gen-btn').click() },
    { done: st.browser.loggedIn, title: 'Log in to Instagram', text: 'Once, in the Chrome window', act: () => go('send') },
  ];
  const done = steps.filter((s) => s.done).length;
  $('#setup').hidden = done === steps.length;
  $('#setup-progress').textContent = `${done} of ${steps.length} done`;
  const current = steps.findIndex((s) => !s.done);
  $('#steps').innerHTML = steps.map((s, i) => `<li class="step ${s.done ? 'done' : ''} ${i === current ? 'current' : ''}" data-step="${i}">
    <span class="step-num">${s.done ? icon('check') : i + 1}</span><div><strong>${s.title}</strong><span>${s.text}</span></div></li>`).join('');
  setupActions = steps.map((s) => s.act);
}
let setupActions = [];
$('#steps').addEventListener('click', (e) => {
  const li = e.target.closest('[data-step]');
  if (li) setupActions[Number(li.dataset.step)]?.();
});

// ---------- settings + campaign ----------
const campaignFields = ['script'];
const autoFields = ['dailyCap', 'minDelaySec', 'maxDelaySec', 'breakEvery', 'breakMinMin', 'breakMaxMin'];

function renderWindows(list) {
  $('#windows').innerHTML = list.map((w) => `<div class="window-row">
    <input type="number" class="w-start" min="0" max="23" value="${w.startHour}" aria-label="From hour"><span class="muted">:00 to</span>
    <input type="number" class="w-end" min="1" max="24" value="${w.endHour}" aria-label="Until hour"><span class="muted">:00, max</span>
    <input type="number" class="w-cap" min="1" value="${w.cap}" aria-label="Max DMs"><span class="muted">DMs</span>
    <button type="button" class="icon-btn danger w-del" title="Remove window">${icon('trash')}</button></div>`).join('');
}
function readWindows() {
  return $('.window-row').map((r) => ({
    startHour: Number(r.querySelector('.w-start').value), endHour: Number(r.querySelector('.w-end').value), cap: Number(r.querySelector('.w-cap').value),
  }));
}
$('#add-window').addEventListener('click', () => {
  const list = readWindows();
  const last = list[list.length - 1];
  list.push(last ? { startHour: last.endHour, endHour: Math.min(24, last.endHour + 4), cap: 25 } : { startHour: 9, endHour: 17, cap: 25 });
  renderWindows(list);
});
$('#windows').addEventListener('click', (e) => {
  const del = e.target.closest('.w-del');
  if (del) { del.closest('.window-row').remove(); }
});

async function loadSettings() {
  const settings = await api('/settings');
  campaignFields.forEach((k) => ($('#c-' + k).value = settings.campaign[k] ?? ''));
  autoFields.forEach((k) => ($('#a-' + k).value = settings.auto[k]));
  const a = settings.auto;
  renderWindows(a.windows?.length ? a.windows : [{ startHour: a.startHour, endHour: a.endHour, cap: a.dailyCap }]);
  $('#s-model').value = settings.model;
  $('#s-channel').value = settings.browser.channel;
  $('#s-apiKey').value = '';
  const hasKey = !!(settings.hasApiKey);
  $('#s-apiKey').placeholder = hasKey ? '•••••••••••• (saved)' : 'sk-ant-…';
  $('#s-key-note').textContent = hasKey ? 'A key is saved. Leave this blank to keep it.' : 'Create one at console.anthropic.com → API keys.';
  $('#cap-warn').hidden = settings.auto.dailyCap <= 50;
}

function flashSaved(sel) {
  $(sel).textContent = '✓ Saved';
  setTimeout(() => ($(sel).textContent = ''), 2200);
}

$('#save-campaign').addEventListener('click', guarded(async () => {
  const campaign = Object.fromEntries(campaignFields.map((k) => [k, $('#c-' + k).value]));
  await api('/settings', { method: 'PUT', body: { campaign } });
  await loadSettings();
  flashSaved('#campaign-saved');
  refresh();
}));

$('#save-settings').addEventListener('click', guarded(async () => {
  const auto = Object.fromEntries(autoFields.map((k) => [k, Number($('#a-' + k).value)]));
  if (auto.minDelaySec > auto.maxDelaySec) throw new Error('Min gap must be less than max gap');
  if (auto.breakMinMin > auto.breakMaxMin) throw new Error('Break min must be less than break max');
  auto.windows = readWindows();
  if (!auto.windows.length) throw new Error('Add at least one sending window');
  for (const w of auto.windows) if (!(w.endHour > w.startHour) || w.cap < 1) throw new Error('Each window needs an end hour after its start hour and a max of at least 1');
  await api('/settings', { method: 'PUT', body: {
    apiKey: $('#s-apiKey').value.trim(), model: $('#s-model').value, auto, browser: { channel: $('#s-channel').value },
  } });
  await loadSettings();
  flashSaved('#settings-saved');
  refresh();
}));
$('#a-dailyCap').addEventListener('input', (e) => ($('#cap-warn').hidden = Number(e.target.value) <= 50));

// ---------- sending ----------
const PHASES = {
  idle: 'Ready when you are', starting: 'Starting…', opening: 'Opening chat', typing: 'Typing the DM', waiting_user: 'Your turn: press Enter',
  sending: 'Sending', waiting: 'Waiting before the next DM', break: 'On a break', sleeping: 'Outside active hours', cap: 'Daily cap reached',
  paused: 'Paused', done: 'All done',
};

$('#browser-open').addEventListener('click', guarded(async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try { await api('/browser/open', { body: {} }); } finally { b.disabled = false; }
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
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

let lastState;
function renderState(st) {
  lastState = st;
  const b = st.browser;
  $('#ig-dot').className = 'dot ' + (b.open ? (b.loggedIn ? 'on' : 'half') : '');
  $('#ig-label').textContent = b.open ? (b.loggedIn ? 'Instagram connected' : 'Log in to Instagram') : 'Instagram window closed';
  $('#today-label').textContent = `${st.sentToday} / ${st.dailyCap}`;
  $('#today-bar').style.width = Math.min(100, (st.sentToday / Math.max(1, st.dailyCap)) * 100) + '%';
  renderStats(st.counts);
  renderSetup(st);

  const g = st.gen;
  const gs = $('#gen-status');
  gs.hidden = !g.running && !g.failed;
  gs.className = 'gen-status' + (!g.running && g.failed ? ' bad' : '');
  gs.innerHTML = g.running ? `<span class="spinner"></span>Writing ${g.done} / ${g.total}` : g.failed ? `${g.failed} failed · ${esc(g.lastError)}` : '';
  $('#gen-btn').disabled = g.running;

  const r = st.runner;
  $('#nav-live').hidden = !r.running;
  $('#now-phase').textContent = PHASES[r.phase] || r.phase;
  $('#now-detail').textContent = r.detail || '';
  $('#pulse').className = 'pulse ' + (r.phase === 'paused' ? 'bad' : r.phase === 'done' ? 'ok' : r.phase === 'waiting_user' ? 'you' : r.running ? 'on' : '');
  $('#countdown').hidden = !r.nextAt;
  if (r.nextAt) $('#countdown').textContent = fmtLeft(r.nextAt - Date.now());

  $('#now-lead').hidden = !r.lead;
  $('#idle-art').hidden = !!r.lead;
  if (r.lead) {
    $('#now-avatar').outerHTML = avatar(r.lead.username, 'lg').replace('class="avatar', 'id="now-avatar" class="avatar');
    $('#now-user').textContent = '@' + r.lead.username;
    $('#now-user').href = `https://www.instagram.com/${r.lead.username}/`;
    $('#now-name').textContent = r.lead.name || '';
    $('#now-msg').textContent = r.lead.message;
  } else {
    $('#idle-text').textContent = !b.open ? 'Click “Open Instagram in Chrome” above to get started.'
      : !b.loggedIn ? 'Log in to Instagram in the Chrome window that just opened. You only need to do this once.'
      : !st.counts.ready ? 'No DMs are ready. Write some on the Leads page first.'
      : r.phase === 'paused' ? 'Check the Instagram window, then press Start to continue.'
      : `${st.counts.ready} DMs ready. Choose a mode and press Start.`;
  }

  $('#run-start').hidden = r.running;
  $('#run-start').disabled = !b.open || !b.loggedIn;
  $('#run-stop').hidden = !r.running;
  $('#run-skip').hidden = !r.running;
  $('#run-skip').querySelector('span').textContent = r.mode === 'auto' && r.nextAt ? 'Skip wait' : 'Skip lead';
  $('#run-mark').hidden = !(r.running && r.mode === 'assist' && r.phase === 'waiting_user');
  $$('input[name="mode"]').forEach((i) => (i.disabled = r.running));
  if (r.running && r.mode) $(`input[name="mode"][value="${r.mode}"]`).checked = true;
  $('#queue-line').textContent = `${st.counts.ready || 0} in queue · ${st.sentToday} sent today`;
  $('#browser-open').querySelector('span').textContent = b.open ? 'Show Instagram window' : 'Open Instagram in Chrome';
  $('#browser-close').hidden = !b.open;
}

let genWasRunning = false;
let countsSig = '';
async function refresh() {
  try {
    const st = await api('/state');
    renderState(st);
    const editing = document.activeElement?.closest('#lead-rows');
    // Reload the list whenever statuses change on the server (writing DMs, sending), so it never shows stale rows.
    const sig = JSON.stringify(st.counts);
    if ((st.gen.running || genWasRunning || sig !== countsSig) && activeTab === 'leads' && !editing) loadLeads();
    countsSig = sig;
    genWasRunning = st.gen.running;
    if (activeTab === 'send') loadLogs();
  } catch { /* server restarting */ }
}

async function loadLogs() {
  const logs = await api('/logs');
  $('#log').innerHTML = logs.length ? logs.map((l) => `<li class="${l.level}"><span class="ldot"></span><span>${esc(l.text)}</span>
    <time>${new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></li>`).join('')
    : '<li><span></span><span class="empty-log">Nothing yet.</span></li>';
}

setInterval(() => { if (lastState?.runner.nextAt) renderState(lastState); }, 1000);
setInterval(refresh, 2000);

loadSettings();
loadLeads();
refresh();
