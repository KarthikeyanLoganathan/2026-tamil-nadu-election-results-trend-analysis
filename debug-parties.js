/**
 * Debug script: fetch page 1 and show raw party names from HTML
 */
'use strict';

const puppeteer = require('puppeteer-core');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function debugFetchPage1() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
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

    console.log('Fetching page 1...');
    await page.goto('https://results.eci.gov.in/ResultAcGenMay2026/statewiseS221.htm', 
                    { waitUntil: 'networkidle2', timeout: 30000 });

    const results = await page.evaluate(() => {
      const rows = [];
      for (const row of document.querySelectorAll('tbody tr').values()) {
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        if (cells.length < 8) continue;

        const acNum = parseInt(cells[1].textContent.trim(), 10);
        if (!acNum || acNum < 1 || acNum > 234) continue;

        const lPartyEl = cells[3].querySelector('table tr td:first-child');
        const tPartyEl = cells[5].querySelector('table tr td:first-child');
        const lParty = lPartyEl ? lPartyEl.textContent.trim() : cells[3].textContent.trim();
        const tParty = tPartyEl ? tPartyEl.textContent.trim() : cells[5].textContent.trim();

        rows.push({
          ac: acNum,
          name: cells[0].textContent.trim(),
          leadingPartyRaw: lParty,
          trailingPartyRaw: tParty,
        });
      }
      return rows;
    });

    console.log('\n=== First 10 rows with RAW party names ===');
    results.slice(0, 10).forEach(r => {
      console.log(`AC ${r.ac} (${r.name}): ${r.leadingPartyRaw} vs ${r.trailingPartyRaw}`);
    });

    console.log('\n=== Unique leading parties (raw) ===');
    const unique = new Set(results.map(r => r.leadingPartyRaw));
    Array.from(unique).sort().forEach(p => console.log(`  - "${p}"`));

  } finally {
    await page.close();
    await browser.close();
  }
}

debugFetchPage1().catch(console.error);
