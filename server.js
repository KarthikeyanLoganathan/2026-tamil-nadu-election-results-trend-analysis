/**
 * TN Election 2026 – Live Dashboard Server
 * Uses puppeteer-core + system Chrome to bypass Akamai bot-protection on ECI.
 * Parses all 12 constituency-list pages and serves a JSON API + dashboard UI.
 *
 * Usage:  node server.js
 * Open:   http://localhost:3000
 */

'use strict';

const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const puppeteer  = require('puppeteer-core');

// System Chrome path on macOS
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PORT      = parseInt(process.env.PORT || '3000', 10);
const ECI_PAGES = 12;
const ECI_BASE  = 'https://results.eci.gov.in/ResultAcGenMay2026/statewiseS22';

// ---------- Browser singleton + DOM-based page fetcher ----------
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

/**
 * Opens one ECI page and extracts constituency rows using the browser DOM.
 * This correctly handles nested tables (party names are in nested <table> cells).
 */
async function fetchPageRows(pageNum) {
  const br   = await getBrowser();
  const page = await br.newPage();
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://results.eci.gov.in/ResultAcGenMay2026/partywiseresult-S22.htm',
    });
    await page.goto(`${ECI_BASE}${pageNum}.htm`, { waitUntil: 'networkidle2', timeout: 30000 });

    return await page.evaluate(() => {
      const results = [];
      for (const row of document.querySelectorAll('tbody tr')) {
        // :scope > td gives only DIRECT td children — skips nested-table tds
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        if (cells.length < 8) continue;

        const acNum = parseInt(cells[1].textContent.trim(), 10);
        if (!acNum || acNum < 1 || acNum > 234) continue;

        const margin = parseInt(cells[6].textContent.trim().replace(/,/g, ''), 10);
        if (isNaN(margin) || margin < 0) continue;

        const roundsStr = cells[7].textContent.trim();
        const rM = roundsStr.match(/(\d+)\/(\d+)/);
        if (!rM) continue;

        // Party name is inside the first <td> of a nested <table> within cells[3] / cells[5]
        const lPartyEl = cells[3].querySelector('table tr td:first-child');
        const tPartyEl = cells[5].querySelector('table tr td:first-child');

        results.push({
          name:          cells[0].textContent.trim(),
          ac:            acNum,
          leadingParty:  lPartyEl ? lPartyEl.textContent.trim() : cells[3].textContent.trim(),
          trailingParty: tPartyEl ? tPartyEl.textContent.trim() : cells[5].textContent.trim(),
          margin,
          roundsDone:  parseInt(rM[1], 10),
          roundsTotal: parseInt(rM[2], 10) || 1,
          status:      cells[8] ? cells[8].textContent.trim() : '',
        });
      }
      return results;
    });
  } finally {
    await page.close();
  }
}

// ---------- Party short-name map ----------
// IMPORTANT: Order matters! Longer/more specific names must come BEFORE shorter substrings
// e.g., "All India Anna Dravida Munnetra Kazhagam" must check BEFORE "Dravida Munnetra Kazhagam"
const PARTY_MAP = [
  ['All India Anna Dravida Munnetra Kazhagam', 'ADMK'],  // Check 3-word variant FIRST
  ['Tamilaga Vettri Kazhagam',              'TVK'],
  ['Dravida Munnetra Kazhagam',             'DMK'],
  ['Pattali Makkal Katchi',                 'PMK'],
  ['Indian National Congress',              'INC'],
  ['Indian Union Muslim League',            'IUML'],
  ['Bharatiya Janata Party',                'BJP'],
  ['Communist Party of India (Marxist)',    'CPI(M)'],
  ['Communist Party of India',              'CPI'],
  ['Desiya Murpokku Dravida Kazhagam',      'DMDK'],
  ['Viduthalai Chiruthaigal Katchi',        'VCK'],
  ['Amma Makkal Munnettra Kazagam',         'AMMK'],
  ['Independent',                           'IND'],
];

function shortParty(name) {
  if (!name) return '?';
  for (const [full, abbr] of PARTY_MAP) {
    if (name.includes(full)) return abbr;
  }
  const m = name.match(/\(([A-Z()]+)\)/);
  if (m) return m[1];
  return name.split(/\s+/).slice(0, 2).join(' ');
}

// ---------- Aggregate all pages ----------
let cachedData  = null;
let lastFetchMs = 0;
let fetching    = false;

const CACHE_TTL = 60 * 1000; // 60 s

async function fetchAllData(force = false) {
  const now = Date.now();
  if (!force && cachedData && (now - lastFetchMs) < CACHE_TTL) return cachedData;
  if (fetching) return cachedData || { constituencies: [], partySummary: {}, timestamp: new Date().toISOString(), loading: true };

  fetching = true;
  console.log(`[${new Date().toISOString()}] Fetching ECI data (${ECI_PAGES} pages)…`);

  const all = [];
  for (let i = 1; i <= ECI_PAGES; i++) {
    try {
      const rows = await fetchPageRows(i);
      for (const r of rows) {
        r.leadingParty  = shortParty(r.leadingParty);
        r.trailingParty = shortParty(r.trailingParty);
        r.completionPct = Math.round((r.roundsDone / r.roundsTotal) * 100);
        r.status        = /declared/i.test(r.status) ? 'Declared' : 'In Progress';
        all.push(r);
      }
      process.stdout.write(`  page ${i}: ${rows.length} rows\n`);
    } catch (err) {
      console.error(`  page ${i} error: ${err.message}`);
    }
  }

  // Deduplicate by AC number (keep first occurrence)
  const seen   = new Set();
  const unique = all.filter((c) => { if (seen.has(c.ac)) return false; seen.add(c.ac); return true; });
  unique.sort((a, b) => a.ac - b.ac);

  // Party tally
  const partySummary = {};
  for (const c of unique) partySummary[c.leadingParty] = (partySummary[c.leadingParty] || 0) + 1;
  // Sort by count desc
  const sortedSummary = Object.fromEntries(
    Object.entries(partySummary).sort((a, b) => b[1] - a[1])
  );

  cachedData = {
    constituencies: unique,
    partySummary:   sortedSummary,
    timestamp:      new Date().toISOString(),
    total:          unique.length,
    loading:        false,
  };
  lastFetchMs = Date.now();
  fetching    = false;

  const tvk = sortedSummary['TVK'] || 0;
  console.log(`  Done: ${unique.length} seats | TVK leading: ${tvk}`);
  return cachedData;
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/data' || req.url === '/api/refresh') {
    const force = req.url === '/api/refresh';
    try {
      const data = await fetchAllData(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, constituencies: [], partySummary: {} }));
    }
    return;
  }

  // Serve dashboard
  const filePath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Dashboard not found – ensure public/index.html exists.'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n🗳️  TN Election 2026 – TVK Live Tracker`);
  console.log(`   Dashboard → http://localhost:${PORT}`);
  console.log(`   Data API  → http://localhost:${PORT}/api/data`);
  console.log(`   Press Ctrl+C to stop\n`);
  fetchAllData().catch(console.error);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down…');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
