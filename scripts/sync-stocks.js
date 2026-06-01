import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function sync() {
  console.log('Starting stock sync (ESM)...');
  const tickers = new Map();

  const add = (code, name, ext) => {
    if (code && code.length >= 4 && !tickers.has(code)) {
      tickers.set(code, { id: code + ext, code, name });
    }
  };

  try {
    // 1. TWSE Listed (上市)
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    if (res.ok) {
      const data = await res.json();
      data.forEach(i => add(i.Code, i.Name, '.TW'));
      console.log(`Synced TWSE: ${data.length} stocks`);
    }
  } catch (e) { console.error('TWSE fail', e); }

  try {
    // 2. TPEx OTC (上櫃)
    const res = await fetch('https://www.tpex.org.tw/openapi/v1/t13n04nd');
    if (res.ok) {
      const data = await res.json();
      data.forEach(i => add(i.SecuritiesCode || i.Code, i.SecuritiesName || i.Name, '.TWO'));
      console.log(`Synced OTC: ${data.length} stocks`);
    }
  } catch (e) { console.error('OTC fail', e); }

  try {
    // 3. Emerging (興櫃)
    const res = await fetch('https://www.tpex.org.tw/openapi/v1/t13n04d1');
    if (res.ok) {
      const data = await res.json();
      data.forEach(i => add(i.SecuritiesCode || i.Code, i.SecuritiesName || i.Name, '.TWO'));
      console.log(`Synced Emerging: ${data.length} stocks`);
    }
  } catch (e) { console.error('Emerging fail', e); }

  const list = Array.from(tickers.values());
  const filePath = path.join(__dirname, '../src/market.json');
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
  console.log(`Sync complete! Total tickers: ${list.length}. Saved to ${filePath}`);
}

sync();
