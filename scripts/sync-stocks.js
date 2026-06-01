import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function sync() {
  console.log('Starting Stock Sync v2 (with headers)...');
  const tickers = new Map();

  // Common User-Agent to bypass simple blocks
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  const add = (code, name, ext) => {
    if (code && code.length >= 4 && !tickers.has(code)) {
      tickers.set(code, { id: code + ext, code, name });
    }
  };

  // 1. TWSE Listed (上市) - Usually reliable
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers });
    if (res.ok) {
      const data = await res.json();
      data.forEach(i => add(i.Code, i.Name, '.TW'));
      console.log(`Synced TWSE: ${data.length} stocks`);
    }
  } catch (e) { console.error('TWSE fail', e); }

  // 2. TPEx OTC (上櫃與興櫃) - Multi-Source
  const otcSources = [
    'https://www.tpex.org.tw/openapi/v1/t13n04nd', // OTC
    'https://www.tpex.org.tw/openapi/v1/t13n04d1', // Emerging
    'https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/otc_quotes_no1430_result.php?l=zh-tw&o=json'
  ];

  for (const url of otcSources) {
    try {
      console.log(`Attempting OTC source: ${url}`);
      const res = await fetch(url, { headers });
      if (res.ok) {
        const d = await res.json();
        if (Array.isArray(d)) {
          d.forEach(i => add(i.SecuritiesCode || i.Code, i.SecuritiesName || i.Name, '.TWO'));
        } else if (d.aaData) {
          d.aaData.forEach(r => add(r[0].trim(), r[1].trim(), '.TWO'));
        }
        console.log(`Current Total: ${tickers.size}`);
      }
    } catch (e) { console.error(`OTC Source fail: ${url}`, e.message); }
  }

  // 3. Last fallback: Hard-Scrape ISIN if still under 1800
  if (tickers.size < 1800) {
    try {
      console.log('Last Resort: Scraping ISIN Mode 4...');
      const res = await fetch('https://isin.twse.com.tw/isin/C_public.jsp?strMode=4', { headers });
      if (res.ok) {
        const html = await res.text();
        const m = html.matchAll(/(\d{4,6})(?:\s|&nbsp;|　)+([^<\s]+)/g);
        for (const res of m) add(res[1], res[2], '.TWO');
        console.log(`Post-Scrape Total: ${tickers.size}`);
      }
    } catch (e) { console.error('ISIN scrape fail', e); }
  }

  const list = Array.from(tickers.values());
  const filePath = path.join(__dirname, '../src/market.json');
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
  console.log(`Sync complete! Final count: ${list.length}.`);
}

sync();
