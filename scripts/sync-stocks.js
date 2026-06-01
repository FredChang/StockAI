import fs from 'fs';
import path from 'path';

async function fetchAndParseISIN(mode, headers, tickers) {
  const suffix = mode === 2 ? '.TW' : '.TWO';
  const label = mode === 2 ? '上市' : '上櫃';
  const url = `https://isin.twse.com.tw/isin/C_public.jsp?strMode=${mode}`;
  
  console.log(`[ISIN] Fetching ${label} list...`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP error! status: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('big5').decode(buf);
  
  // Parse rows: <tr>...</tr>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripHtml = (h) => h.replace(/<[^>]+>/g, '').trim();
  
  let rowMatch;
  let added = 0;
  
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cellMatch;
    cellRegex.lastIndex = 0; // Reset cell regex index
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue;
    const cell0 = stripHtml(cells[0]);
    const cat = stripHtml(cells[4]);
    
    // Split by spaces, tabs, full-width spaces, non-breaking spaces
    const parts = cell0.split(/[\s\t　 ]+/);
    if (parts.length < 2) continue;
    
    const code = parts[0].trim();
    const name = parts[1].trim();
    
    // Exact C# logic filters:
    // 1. Must be 4 characters or start with "00"
    if (!(code.length === 4 || code.startsWith('00'))) continue;
    // 2. Must consist entirely of digits
    if (!/^\d+$/.test(code)) continue;
    // 3. Exclude warrants/derivatives (contains 權證, 牛熊證, 認購, 認售)
    if (cat.includes('權證') || cat.includes('牛熊證') || cat.includes('認購') || cat.includes('認售')) continue;
    
    if (!tickers.has(code)) {
      tickers.set(code, { id: code + suffix, code, name });
      added++;
    }
  }
  console.log(`[ISIN] ${label} Success: Added ${added} stocks. (Total so far: ${tickers.size})`);
}

function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x, y) => x + Math.pow(y - m, 2), 0) / a.length); }

function calculateFeatures(s, c) {
  const n = c.length;
  if (n < 60) return null;
  const cur = c[n - 1];
  const ma5 = avg(c.slice(-5));
  const ma20 = avg(c.slice(-20));
  const ma60 = avg(c.slice(-60));
  
  const rets = [];
  for (let i = 1; i < n; i++) rets.push((c[i] - c[i - 1]) / c[i - 1]);
  const vol = stdDev(rets.slice(-20)) * Math.sqrt(252) * 100;
  
  const std20 = stdDev(c.slice(-20));
  const up = ma20 + 2 * std20;
  const low = ma20 - 2 * std20;
  const bbWidth = ((up - low) / ma20) * 100;
  
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    close: cur,
    ma5,
    features: [
      vol,
      bbWidth,
      (cur / ma60 - 1) * 100,
      (ma5 / ma60 - 1) * 100,
      (cur / ma20 - 1) * 100,
      (cur / up - 1) * 100,
      (cur / c[n - 11] - 1) * 100
    ]
  };
}

async function sync() {
  console.log('--- Stock Sync Process Start ---');
  const tickers = new Map();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  };

  // 1. Scrape ISIN Listed & OTC
  try {
    await fetchAndParseISIN(2, headers, tickers);
    await fetchAndParseISIN(4, headers, tickers);
  } catch (e) {
    console.error('[ISIN Scrape Error]:', e.message);
  }

  const list = Array.from(tickers.values());
  const filePath = path.join(process.cwd(), 'src', 'market.json');
  
  if (list.length < 1500) {
    console.error(`--- Sync FAILED: Too few stocks found (${list.length}) ---`);
    process.exit(1);
  }

  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
  console.log(`[Universe] Saved ${list.length} stocks to: ${filePath}`);

  // 2. Fetch Yahoo Finance Spark data & calculate features
  console.log(`[Yahoo Spark] Fetching prices for ${list.length} stocks...`);
  const scanResults = [];
  const batchSize = 20;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);
    const symbols = chunk.map(s => s.id).join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=150d&interval=1d`;

    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        const results = data.spark.result;
        for (const item of results) {
          const s = chunk.find(c => c.id === item.symbol);
          if (!s) continue;
          
          const resp = item.response && item.response[0];
          if (resp && resp.timestamp && resp.indicators && resp.indicators.quote) {
            const closes = resp.indicators.quote[0].close;
            const validCloses = closes.filter(v => v != null);
            if (validCloses.length >= 60) {
              const feat = calculateFeatures(s, validCloses);
              if (feat) {
                scanResults.push(feat);
                successCount++;
                continue;
              }
            }
          }
          failCount++;
        }
      } else {
        console.error(`[Yahoo Spark Error] Batch starting at ${i} HTTP Status: ${res.status}`);
        failCount += chunk.length;
      }
    } catch (e) {
      console.error(`[Yahoo Spark Error] Batch starting at ${i}:`, e.message);
      failCount += chunk.length;
    }

    // Progress update
    if ((i + batchSize) % 200 === 0 || (i + batchSize) >= list.length) {
      const pct = Math.min(100, Math.round(((i + batchSize) / list.length) * 100));
      console.log(`[Yahoo Spark Progress] ${pct}% completed. Success: ${successCount}, Fail: ${failCount}`);
    }

    // Delay 150ms to be rate limit friendly
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  const resultsPath = path.join(process.cwd(), 'src', 'scan_results.json');
  if (scanResults.length > 1000) {
    fs.writeFileSync(resultsPath, JSON.stringify(scanResults, null, 2));
    console.log(`--- Sync SUCCESS ---`);
    console.log(`Scanned Tickers: ${scanResults.length} / ${list.length}`);
    console.log(`File saved to: ${resultsPath}`);
  } else {
    console.error(`--- Sync FAILED: Too few successfully analyzed stocks (${scanResults.length}) ---`);
    process.exit(1);
  }
}

sync();


