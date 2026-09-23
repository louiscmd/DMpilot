// Turns a LeadOS JSON export, any JSON array, or a CSV into lead records.

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv']);

export function extractUsername(value) {
  if (!value) return null;
  let v = String(value).trim();
  const m = v.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) v = m[1];
  else if (/^https?:\/\//i.test(v)) return null;
  v = v.replace(/^@/, '').trim();
  if (!USERNAME_RE.test(v) || RESERVED.has(v.toLowerCase())) return null;
  return v;
}

const IG_KEYS = ['instagramurl', 'instagram', 'instagram_url', 'instagramhandle', 'ig', 'ighandle', 'username', 'handle', 'ig_username'];
const NAME_KEYS = ['businessname', 'business', 'name', 'fullname', 'full_name', 'contactname', 'company'];

function pick(row, keys) {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[\s-]/g, ''), v]));
  for (const k of keys) if (lower[k]) return lower[k];
  return null;
}

function toLead(row) {
  let username = extractUsername(pick(row, IG_KEYS));
  if (!username) {
    // Fall back to any field that contains an instagram.com link.
    for (const v of Object.values(row)) {
      if (typeof v === 'string' && /instagram\.com\//i.test(v)) { username = extractUsername(v); if (username) break; }
    }
  }
  if (!username) return null;
  return { username, name: pick(row, NAME_KEYS) || '', data: row };
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  if (rows.length < 2) {
    // Single column of handles/URLs with no header.
    return rows.flat().map((v) => ({ instagram: v }));
  }
  const header = rows[0].map((h) => h.trim());
  const hasHeader = header.some((h) => /insta|user|handle|name|url/i.test(h) && !/[/@.]/.test(h));
  if (!hasHeader) return rows.map((r) => ({ instagram: r[0] }));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function parseLeads(text) {
  const trimmed = text.trim();
  let rows;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json)) rows = json;
    else if (Array.isArray(json.leads)) rows = json.leads;
    else rows = Object.values(json).find(Array.isArray) || [json];
    rows = rows.map((r) => (typeof r === 'string' ? { instagram: r } : r));
  } else {
    rows = parseCsv(trimmed);
  }
  const leads = [];
  let invalid = 0;
  for (const r of rows) {
    const lead = toLead(r);
    if (lead) leads.push(lead); else invalid++;
  }
  return { leads, invalid };
}
