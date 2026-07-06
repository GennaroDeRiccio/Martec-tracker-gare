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

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseItalianDate(value) {
  const text = compactText(value);
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return '';
  const [, day, month, year, hour = '23', minute = '59'] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00`;
}

function parseEuro(value) {
  const text = compactText(value).replace(/\./g, '').replace(',', '.');
  const match = text.match(/(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) || 0 : 0;
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

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(`Playwright non installato. Aggiungi lo step "npm install playwright --no-save" al workflow. Dettaglio: ${error.message}`);
  }
}

async function collectFareAppalti(portal) {
  const username = process.env[portal.usernameSecret || 'FAREAPPALTI_USERNAME'];
  const password = process.env[portal.passwordSecret || 'FAREAPPALTI_PASSWORD'];
  if (!username || !password) {
    console.log('FareAppalti enabled but credentials are missing; skipping.');
    return [];
  }

  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    locale: 'it-IT',
    timezoneId: timezone,
    viewport: { width: 1440, height: 1000 }
  });
  let page = await context.newPage();

  const pageHasTenderCards = async () => page.waitForFunction(() => /COD\.\s*[A-Z0-9-]+/i.test(document.body?.innerText || ''), null, { timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  const clickAndFollow = async target => {
    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
      target.click({ timeout: 8000 }).catch(() => null)
    ]);
    const popup = await popupPromise;
    if (popup) {
      page = popup;
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    }
  };

  const tryOpenTenderListFromVisibleLinks = async () => {
    const fallbackTargets = [
      page.getByText(/\d+\s+Bandi/i).first(),
      page.getByText(/Nuovi Bandi/i).first(),
      page.getByText(/Mail giornaliere/i).first(),
      page.getByText(/Ricerca/i).first()
    ];
    for (const target of fallbackTargets) {
      if (!(await target.count())) continue;
      await clickAndFollow(target);
      if (await pageHasTenderCards()) return true;
    }
    return false;
  };

  try {
    const loginUrl = portal.loginUrl || 'https://app.fareappalti.it/login';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const emailInput = page.locator('input[type="email"], input[name*="email" i], input[placeholder*="email" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();
    if (await emailInput.count()) await emailInput.fill(username);
    if (await passwordInput.count()) await passwordInput.fill(password);

    const loginButton = page.getByRole('button', { name: /accedi/i }).first();
    if (await loginButton.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
        loginButton.click()
      ]);
    } else if (await passwordInput.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
        passwordInput.press('Enter')
      ]);
    }

    let hasTenderCards = await pageHasTenderCards();
    if (!hasTenderCards) {
      hasTenderCards = await tryOpenTenderListFromVisibleLinks();
    }

    const listUrl = portal.mailUrl || portal.searchUrl || 'https://mail.fareappalti.it';
    if (!hasTenderCards) {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      hasTenderCards = await pageHasTenderCards();
    }

    if (!hasTenderCards) {
      hasTenderCards = await tryOpenTenderListFromVisibleLinks();
    }

    if (!hasTenderCards) {
      const diagnostics = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800)
      })).catch(error => ({ url: page.url(), title: '', text: error.message }));
      console.log(`FareAppalti: nessuna card COD trovata. URL=${diagnostics.url}`);
      console.log(`FareAppalti: titolo pagina="${diagnostics.title}"`);
      console.log(`FareAppalti: testo pagina="${diagnostics.text}"`);
      return [];
    }

    const maxResults = Number(portal.maxResults || 25);
    const tenders = await page.evaluate(({ maxResults }) => {
      const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
      const linesOf = value => String(value || '').split('\n').map(compact).filter(Boolean);
      const afterLabel = (lines, label) => {
        const index = lines.findIndex(line => line.toLowerCase() === label.toLowerCase());
        return index >= 0 ? lines[index + 1] || '' : '';
      };
      const afterStarts = (lines, label) => {
        const index = lines.findIndex(line => line.toLowerCase().startsWith(label.toLowerCase()));
        return index >= 0 ? lines[index + 1] || lines[index].replace(new RegExp(`^${label}`, 'i'), '').trim() : '';
      };
      const codeNodes = [...document.querySelectorAll('body *')].filter(element => /^COD\.\s*[A-Z0-9-]+/i.test(compact(element.textContent)));
      const seen = new Set();
      const cards = [];

      for (const node of codeNodes) {
        let card = node;
        for (let depth = 0; depth < 10 && card.parentElement; depth += 1) {
          const parentText = card.parentElement.innerText || '';
          if (/Stazione appaltante/i.test(parentText) && /Termine/i.test(parentText)) {
            card = card.parentElement;
            break;
          }
          card = card.parentElement;
        }
        const text = card.innerText || '';
        const code = text.match(/COD\.\s*([A-Z0-9-]+)/i)?.[1] || '';
        if (!code || seen.has(code)) continue;
        seen.add(code);
        cards.push(card);
      }

      return cards.slice(0, maxResults).map(card => {
        const text = card.innerText || '';
        const lines = linesOf(text);
        const code = text.match(/COD\.\s*([A-Z0-9-]+)/i)?.[1] || '';
        const titleLine = lines.find(line => /^PROCEDURA|^AVVISO|^BANDO|^AFFIDAMENTO|^GARA/i.test(line)) || lines.find(line => line.length > 30) || '';
        const [procedureRaw, ...titleParts] = titleLine.split(':');
        const procedure = titleParts.length ? procedureRaw : afterLabel(lines, 'Procedura di gara');
        const title = titleParts.length ? titleParts.join(':').trim() : titleLine;
        const detailAnchor = [...card.querySelectorAll('a')].find(anchor => /dettagli/i.test(anchor.innerText || anchor.ariaLabel || '') || /dettagli|bando/i.test(anchor.href || ''));
        const linkAnchor = [...card.querySelectorAll('a')].find(anchor => /link/i.test(anchor.innerText || anchor.ariaLabel || '') && anchor.href);
        const sourceUrl = detailAnchor?.href || linkAnchor?.href || (code ? `https://app.fareappalti.it/Bando/Dettagli/${code}` : window.location.href);
        const categoryLines = lines.filter(line => /^[A-Z]+\/[A-Z]+\/\d+/i.test(line));

        return {
          portale: 'FARE APPALTI',
          portalKey: 'fareappalti',
          num_rdo: code,
          cig: afterStarts(lines, 'CIG'),
          titolo: title || titleLine || code,
          descrizione: titleLine,
          ente: afterLabel(lines, 'Stazione appaltante'),
          luogo: afterLabel(lines, 'Luogo'),
          importoRaw: afterLabel(lines, 'Importo') || afterStarts(lines, 'Importo'),
          baseAstaRaw: afterLabel(lines, "Base d'asta") || afterStarts(lines, "Base d'asta"),
          tipologia: compact(procedure || afterLabel(lines, 'Procedura di gara')),
          criterio: afterLabel(lines, 'Criterio aggiudicazione'),
          pubblicazioneRaw: afterLabel(lines, 'Pubblicazione'),
          scadenzaRaw: afterLabel(lines, 'Termine'),
          categorie: categoryLines,
          sourceUrl,
          rawText: text.slice(0, 2500)
        };
      });
    }, { maxResults });

    return tenders.map(item => {
      const amount = parseEuro(item.importoRaw) || parseEuro(item.baseAstaRaw);
      const noteParts = [
        item.luogo ? `Luogo: ${item.luogo}` : '',
        item.criterio ? `Criterio: ${item.criterio}` : '',
        item.pubblicazioneRaw ? `Pubblicazione: ${item.pubblicazioneRaw}` : '',
        item.categorie?.length ? `Categorie: ${item.categorie.join(', ')}` : ''
      ].filter(Boolean);

      return {
        ...item,
        base_asta: amount,
        scadenza: parseItalianDate(item.scadenzaRaw),
        foundAt: new Date().toISOString(),
        note: noteParts.join(' | ')
      };
    });
  } finally {
    await browser.close();
  }
}

async function collectPortalResults() {
  const results = [];
  results.push(...await collectFromStaticJsonEnv());

  // Importante: non scaricare allegati qui. Salvare solo metadati e link.
  for (const portal of config.portals || []) {
    if (!portal.enabled) continue;
    if (portal.key === 'fareappalti') {
      console.log('Scanning FareAppalti...');
      results.push(...await collectFareAppalti(portal));
      continue;
    }
    console.log(`Portal "${portal.name}" enabled but no adapter is configured; skipping.`);
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
