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

async function sync() {
  console.log('--- Stock Sync Process Start ---');
  const tickers = new Map();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  };

  // 1. Scrape TWSE Listed (上市, strMode=2)
  try {
    await fetchAndParseISIN(2, headers, tickers);
  } catch (e) {
    console.error('[TWSE ISIN Error]:', e.message);
  }

  // 2. Scrape TPEx OTC (上櫃, strMode=4)
  try {
    await fetchAndParseISIN(4, headers, tickers);
  } catch (e) {
    console.error('[TPEx ISIN Error]:', e.message);
  }

  const list = Array.from(tickers.values());
  const filePath = path.join(process.cwd(), 'src', 'market.json');
  
  if (list.length > 1500) { // Require at least 1500 stocks to succeed
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    console.log(`--- Sync SUCCESS ---`);
    console.log(`Final Tickers: ${list.length}`);
    console.log(`File saved to: ${filePath}`);
  } else {
    console.error(`--- Sync FAILED: Too few stocks found (${list.length}) ---`);
    process.exit(1);
  }
}

sync();

