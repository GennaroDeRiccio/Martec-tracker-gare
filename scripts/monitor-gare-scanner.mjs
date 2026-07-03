import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'monitor-gare.config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'monitor-gare.config.example.json');

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const config = await readJson(CONFIG_PATH, await readJson(CONFIG_EXAMPLE_PATH, {}));
const timezone = config.timezone || 'Europe/Rome';
const allowedHours = Array.isArray(config.allowedHours) ? config.allowedHours : [9, 11, 13];

function getLocalHour(tz) {
  const value = new Intl.DateTimeFormat('it-IT', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false
  }).format(new Date());
  return Number(value);
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function scoreTender(item) {
  const positive = config.positiveKeywords || [];
  const negative = config.negativeKeywords || [];
  const text = normalizeText([
    item.titolo,
    item.descrizione,
    item.ente,
    item.tipologia
  ].join(' '));
  let score = 45;
  const reasons = [];
  for (const keyword of positive) {
    if (text.includes(normalizeText(keyword))) {
      score += 8;
      if (reasons.length < 4) reasons.push(`Keyword: ${keyword}`);
    }
  }
  for (const keyword of negative) {
    if (text.includes(normalizeText(keyword))) score -= 18;
  }
  const amount = Number(item.base_asta ?? item.importo);
  if (Number.isFinite(amount) && amount >= 3000) {
    score += 8;
    reasons.push('Importo rilevante');
  }
  if (Number.isFinite(amount) && amount >= 15000) score += 8;
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: [...new Set(reasons)].slice(0, 4)
  };
}

function fingerprint(item) {
  const raw = [
    item.sourceUrl || item.url || '',
    item.num_rdo || item.cig || '',
    item.titolo || item.descrizione || '',
    item.ente || ''
  ].map(value => String(value).trim().toLowerCase()).filter(Boolean).join('|');
  return crypto.createHash('sha256').update(raw || JSON.stringify(item)).digest('hex').slice(0, 24);
}

async function collectFromStaticJsonEnv() {
  const raw = process.env.MONITOR_SAMPLE_RESULTS_JSON;
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function collectPortalResults() {
  const results = [];
  results.push(...await collectFromStaticJsonEnv());

  // Adapter reali da aggiungere portale per portale.
  // Importante: non scaricare allegati qui. Salvare solo metadati e link.
  for (const portal of config.portals || []) {
    if (!portal.enabled) continue;
    console.log(`Portal "${portal.name}" enabled but no adapter is configured yet; skipping.`);
  }

  return results;
}

function normalizeTender(item) {
  const scored = scoreTender(item);
  const normalized = {
    id: item.id || `mon-${fingerprint(item)}`,
    portale: String(item.portale || item.portalName || 'PORTALE').toUpperCase(),
    portalKey: item.portalKey || item.sourceKey || '',
    titolo: item.titolo || item.title || item.descrizione || '',
    descrizione: item.descrizione || item.description || item.titolo || item.title || '',
    ente: item.ente || item.authority || '',
    tipologia: item.tipologia || item.type || '',
    num_rdo: item.num_rdo || item.rdo || item.cig || '',
    base_asta: Number(item.base_asta ?? item.importo ?? 0) || 0,
    scadenza: item.scadenza || item.deadline || '',
    sourceUrl: item.sourceUrl || item.url || '',
    foundAt: item.foundAt || new Date().toISOString(),
    status: item.status || 'NUOVA',
    score: item.score ?? scored.score,
    reasons: item.reasons || scored.reasons,
    note: item.note || ''
  };
  normalized.id = normalized.id || `mon-${fingerprint(normalized)}`;
  return normalized;
}

async function getSupabaseState() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const workspaceId = config.workspaceId || 'shared';
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/app_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=payload`;
  const response = await fetch(endpoint, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`
    }
  });
  if (!response.ok) throw new Error(`Supabase read failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows[0]?.payload || {};
}

async function saveSupabaseState(payload) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const workspaceId = config.workspaceId || 'shared';
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/app_state?workspace_id=eq.${encodeURIComponent(workspaceId)}`;
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify({ payload, updated_at: new Date().toISOString() })
  });
  if (!response.ok) throw new Error(`Supabase write failed: ${response.status} ${await response.text()}`);
}

function mergeMonitorGare(existing, incoming) {
  const byFingerprint = new Map();
  for (const item of existing || []) {
    byFingerprint.set(fingerprint(item), item);
  }
  for (const item of incoming) {
    const key = fingerprint(item);
    const previous = byFingerprint.get(key);
    byFingerprint.set(key, previous ? {
      ...previous,
      ...item,
      status: previous.status || item.status || 'NUOVA',
      importedGaraId: previous.importedGaraId || item.importedGaraId || ''
    } : item);
  }
  return [...byFingerprint.values()].sort((a, b) => String(b.foundAt || '').localeCompare(String(a.foundAt || '')));
}

const force = process.env.SCANNER_FORCE === '1' || process.argv.includes('--force');
const localHour = getLocalHour(timezone);
if (!force && !allowedHours.includes(localHour)) {
  console.log(`Skip: local hour in ${timezone} is ${localHour}, allowed hours are ${allowedHours.join(', ')}.`);
  process.exit(0);
}

const rawResults = await collectPortalResults();
const normalized = rawResults.map(normalizeTender).filter(item => {
  const minScore = Number(config.minScoreToKeep ?? 45);
  return item.titolo && item.sourceUrl && Number(item.score) >= minScore;
});

if (!normalized.length) {
  console.log('No new monitor gare candidates.');
  process.exit(0);
}

const state = await getSupabaseState();
state.monitorGare = mergeMonitorGare(state.monitorGare || [], normalized);
await saveSupabaseState(state);
console.log(`Saved ${normalized.length} monitor gare candidates. Total: ${state.monitorGare.length}.`);
