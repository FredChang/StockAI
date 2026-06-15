import fs from 'fs';
import path from 'path';

const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, { retries = 3, baseDelayMs = 1000, label = 'fetch' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 && attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt + 1);
        console.warn(`[${label}] Rate limited (429). Waiting ${delay}ms before retry ${attempt + 1}/${retries}...`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      if (attempt === retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`[${label}] Attempt ${attempt + 1} failed: ${e.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastError || new Error(`${label} failed after ${retries + 1} attempts`);
}

function loadJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.warn(`[Load] Could not read ${filePath}: ${e.message}`);
  }
  return null;
}

async function fetchAndParseISIN(mode, headers, tickers) {
  const suffix = mode === 2 ? '.TW' : '.TWO';
  const label = mode === 2 ? '上市' : '上櫃';
  const url = `https://isin.twse.com.tw/isin/C_public.jsp?strMode=${mode}`;

  console.log(`[ISIN] Fetching ${label} list...`);
  const res = await fetchWithRetry(url, { headers }, { label: `ISIN ${label}`, retries: 3, baseDelayMs: 2000 });
  if (!res.ok) {
    throw new Error(`HTTP error! status: ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('big5').decode(buf);

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripHtml = (h) => h.replace(/<[^>]+>/g, '').trim();

  let rowMatch;
  let added = 0;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cellMatch;
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue;
    const cell0 = stripHtml(cells[0]);
    const cat = stripHtml(cells[4]);

    const parts = cell0.split(/[\s\t　 ]+/);
    if (parts.length < 2) continue;

    const code = parts[0].trim();
    const name = parts[1].trim();

    if (!(code.length === 4 || code.startsWith('00'))) continue;
    if (!/^\d+$/.test(code)) continue;
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

function parseYahooBatch(chunk, data) {
  const results = [];
  let failCount = 0;
  const items = data?.spark?.result;
  if (!items) {
    return { results, failCount: chunk.length };
  }

  for (const item of items) {
    const s = chunk.find(c => c.id === item.symbol);
    if (!s) continue;

    const resp = item.response && item.response[0];
    if (resp && resp.timestamp && resp.indicators && resp.indicators.quote) {
      const closes = resp.indicators.quote[0].close;
      const validCloses = closes.filter(v => v != null);
      if (validCloses.length >= 60) {
        const feat = calculateFeatures(s, validCloses);
        if (feat) {
          results.push(feat);
          continue;
        }
      }
    }
    failCount++;
  }
  return { results, failCount };
}

async function fetchYahooBatch(chunk, headers, hostIndex) {
  const host = YAHOO_HOSTS[hostIndex % YAHOO_HOSTS.length];
  const symbols = chunk.map(s => s.id).join(',');
  const url = `https://${host}/v7/finance/spark?symbols=${symbols}&range=150d&interval=1d`;
  const label = `Yahoo Spark (${chunk[0]?.id})`;

  const res = await fetchWithRetry(url, { headers }, { label, retries: 3, baseDelayMs: 1500 });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  return parseYahooBatch(chunk, data);
}

async function sync() {
  console.log('--- Stock Sync Process Start ---');
  const tickers = new Map();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  };

  const filePath = path.join(process.cwd(), 'public', 'market.json');
  const resultsPath = path.join(process.cwd(), 'public', 'scan_results.json');

  // 1. Scrape ISIN Listed & OTC
  try {
    await fetchAndParseISIN(2, headers, tickers);
    await fetchAndParseISIN(4, headers, tickers);
  } catch (e) {
    console.error('[ISIN Scrape Error]:', e.message);
  }

  let list = Array.from(tickers.values());

  if (list.length < 1500) {
    const existing = loadJsonFile(filePath);
    if (existing && existing.length >= 1500) {
      console.warn(`[Universe] ISIN scrape incomplete (${list.length}), falling back to existing market.json (${existing.length} stocks)`);
      list = existing;
    } else {
      console.error(`--- Sync FAILED: Too few stocks found (${list.length}) ---`);
      process.exit(1);
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
  console.log(`[Universe] Saved ${list.length} stocks to: ${filePath}`);

  // 2. Fetch Yahoo Finance Spark data & calculate features
  console.log(`[Yahoo Spark] Fetching prices for ${list.length} stocks...`);
  const scanResults = [];
  const failedChunks = [];
  const batchSize = 15;
  let successCount = 0;
  let failCount = 0;
  let batchIndex = 0;

  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);

    try {
      const { results, failCount: batchFails } = await fetchYahooBatch(chunk, headers, batchIndex);
      scanResults.push(...results);
      successCount += results.length;
      failCount += batchFails;
    } catch (e) {
      console.error(`[Yahoo Spark Error] Batch starting at ${i}:`, e.message);
      failedChunks.push({ chunk, startIndex: i });
      failCount += chunk.length;
    }

    batchIndex++;

    if ((i + batchSize) % 200 === 0 || (i + batchSize) >= list.length) {
      const pct = Math.min(100, Math.round(((i + batchSize) / list.length) * 100));
      console.log(`[Yahoo Spark Progress] ${pct}% completed. Success: ${successCount}, Fail: ${failCount}, Pending retry: ${failedChunks.length} batches`);
    }

    await sleep(250);
  }

  // Retry failed batches with longer delay and alternate host
  if (failedChunks.length > 0) {
    console.log(`[Yahoo Spark] Retrying ${failedChunks.length} failed batches...`);
    await sleep(3000);

    const stillFailed = [];
    for (let j = 0; j < failedChunks.length; j++) {
      const { chunk, startIndex } = failedChunks[j];
      try {
        const { results, failCount: batchFails } = await fetchYahooBatch(chunk, headers, batchIndex + j + 1);
        scanResults.push(...results);
        successCount += results.length;
        failCount -= chunk.length;
        failCount += batchFails;
        console.log(`[Yahoo Spark Retry] Batch at ${startIndex}: recovered ${results.length}/${chunk.length}`);
      } catch (e) {
        console.error(`[Yahoo Spark Retry] Batch at ${startIndex} still failed:`, e.message);
        stillFailed.push(startIndex);
      }
      await sleep(500);
    }

    if (stillFailed.length > 0) {
      console.warn(`[Yahoo Spark] ${stillFailed.length} batches could not be recovered this run`);
    }
  }

  // Merge with existing scan results so transient failures don't wipe good data
  const existingResults = loadJsonFile(resultsPath);
  const mergedMap = new Map();
  if (Array.isArray(existingResults)) {
    for (const r of existingResults) mergedMap.set(r.id, r);
  }
  const freshCount = scanResults.length;
  for (const r of scanResults) mergedMap.set(r.id, r);
  const merged = Array.from(mergedMap.values());
  const staleCount = merged.length - freshCount;

  if (merged.length > 1000) {
    fs.writeFileSync(resultsPath, JSON.stringify(merged, null, 2));
    console.log(`--- Sync SUCCESS ---`);
    console.log(`Fresh this run: ${freshCount}, Carried over: ${staleCount}, Total: ${merged.length} / ${list.length}`);
    console.log(`File saved to: ${resultsPath}`);
    if (freshCount < 1000) {
      console.warn(`[Yahoo Spark] Warning: only ${freshCount} stocks refreshed; used previous data for the rest`);
    }
  } else {
    console.error(`--- Sync FAILED: Too few stocks in merged results (${merged.length}, fresh: ${freshCount}) ---`);
    process.exit(1);
  }
}

sync();
