import fs from 'fs';
import path from 'path';

async function sync() {
  console.log('--- Stock Sync Process Start ---');
  const tickers = new Map();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  const add = (code, name, ext) => {
    if (code && code.length >= 4 && !tickers.has(code)) {
      tickers.set(code, { id: code + ext, code, name });
    }
  };

  // 1. TWSE Listed (上市)
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers });
    if (res.ok) {
      const data = await res.json();
      data.forEach(i => add(i.Code, i.Name, '.TW'));
      console.log(`[TWSE] Success: Found ${data.length} stocks`);
    }
  } catch (e) { console.error('[TWSE] Error:', e.message); }

  // 2. TPEx OTC (上櫃與興櫃)
  const otcSources = [
    'https://www.tpex.org.tw/openapi/v1/t13n04nd',
    'https://www.tpex.org.tw/openapi/v1/t13n04d1',
    'https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/otc_quotes_no1430_result.php?l=zh-tw&o=json'
  ];

  for (const url of otcSources) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const d = await res.json();
        const startCount = tickers.size;
        if (Array.isArray(d)) {
          d.forEach(i => add(i.SecuritiesCode || i.Code, i.SecuritiesName || i.Name, '.TWO'));
        } else if (d.aaData) {
          d.aaData.forEach(r => add(r[0].trim(), r[1].trim(), '.TWO'));
        }
        console.log(`[OTC Source] ${url.substring(0, 40)}... Added: ${tickers.size - startCount}`);
      }
    } catch (e) { console.error(`[OTC Error] ${url}:`, e.message); }
  }

  // 3. Last stand: ISIN Scrape
  if (tickers.size < 1800) {
    console.log('[Fallback] Count low, starting ISIN scrape...');
    try {
      const res = await fetch('https://isin.twse.com.tw/isin/C_public.jsp?strMode=4', { headers });
      if (res.ok) {
        const html = await res.text();
        const m = html.matchAll(/(\d{4,6})(?:\s|&nbsp;|　)+([^<\s]+)/g);
        let count = 0;
        for (const res of m) { add(res[1], res[2], '.TWO'); count++; }
        console.log(`[ISIN Scrape] Found ${count} matches. New Total: ${tickers.size}`);
      }
    } catch (e) { console.error('[ISIN Error]:', e.message); }
  }

  const list = Array.from(tickers.values());
  // Use project root path (process.cwd() in GitHub Action is the root)
  const filePath = path.join(process.cwd(), 'src', 'market.json');
  
  if (list.length > 500) {
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    console.log(`--- Sync SUCCESS ---`);
    console.log(`Final Tickers: ${list.length}`);
    console.log(`File saved to: ${filePath}`);
  } else {
    console.error('--- Sync FAILD: Too few stocks found ---');
    process.exit(1);
  }
}

sync();
