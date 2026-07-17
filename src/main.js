import { CORE_STOCKS } from './stocks.js';

// --- 全市場精選標的 (Initial fallback) ---
let FULL_MARKET_LIST = [...CORE_STOCKS];

const PROXY_URL = 'https://corsproxy.io/?'; 
const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TWSE_LIST_URL = 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=';

let state = {
  activeTab: 'scan',
  isScanning: false,
  results: [],
  watchlist: JSON.parse(localStorage.getItem('watchlist') || '[]'),
  weights: [29.08, 19.33, 10.39, 7.67, 7.26, 5.09, 4.25, 0, 0, 0, 0, 0],
  version: 'v3.1.0-Nitro',
  lastUpdate: '2026.07.17',
  currentChart: null,
  selectedStock: null,
  currentTimeframe: '1mo',
  preScannedResults: []
};

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
  try { initWeights(); } catch(e) { console.error('Weights fail', e); }
  try { updateWatchlistUI(); } catch(e) { console.error('Watchlist UI fail', e); }
  try {
    updateTime();
    setInterval(updateTime, 1000);
    setTimeout(refreshMarkets, 800);
  } catch(e) { console.error('Ticker fail', e); }
  const scanBtn = document.getElementById('start-scan');
  if (scanBtn) scanBtn.onclick = runScan;
  
  const weightToggle = document.getElementById('weight-toggle');
  if (weightToggle) weightToggle.onclick = toggleWeights;
  
  const watchBtn = document.getElementById('add-to-watchlist-btn');
  if (watchBtn) watchBtn.onclick = toggleWatchlist;
  
  const cb = document.querySelector('.close-modal');
  if (cb) cb.onclick = () => {
    document.getElementById('chart-modal').style.display = 'none';
    if (state.currentChart) { state.currentChart.destroy(); state.currentChart = null; }
  };

  const searchInput = document.getElementById('watchlist-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      updateWatchlistUI();
    });
  }
  const searchClearBtn = document.getElementById('watchlist-search-clear-btn');
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      if (searchInput) {
        searchInput.value = '';
        updateWatchlistUI();
      }
    });
  }

  // Pre-fetch all market tickers for global search
  try {
    getFullMarketTickers().then(() => {
      if (searchInput && searchInput.value.trim()) {
        updateWatchlistUI();
      }
    });
  } catch (e) {
    console.error('Ticker pre-fetch fail', e);
  }
});

function updateTime() {
    const el = document.getElementById('update-time');
    if (el) el.innerText = `更新於: ${new Date().toLocaleTimeString()}`;
}

async function safeFetch(url, isHtml = false, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const separator = url.includes('?') ? '&' : '?';
      const finalUrl = `${url}${separator}cb=${Date.now()}_${i}`;
      const res = await fetch(PROXY_URL + encodeURIComponent(finalUrl));
      if (!res.ok) {
          if (res.status === 429 && i < retries) {
              await new Promise(r => setTimeout(r, 1000 * (i + 1)));
              continue;
          }
          throw new Error(`Fetch Error: ${res.status}`);
      }
      return isHtml ? await res.text() : await res.json();
    } catch (e) {
      if (i === retries) {
          console.error('Fetch failed after retries:', url, e);
          throw e;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function fetchCloudJson(filename) {
  const cacheBust = '?v=' + Date.now();
  // 1. Try public/filename (covers raw repo deployment and local dev server)
  try {
      const res = await fetch('public/' + filename + cacheBust);
      if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 500) {
              return data;
          }
      }
  } catch (e) {
      console.warn(`Failed to fetch public/${filename}, trying root:`, e);
  }

  // 2. Try root filename (covers compiled/bundled environment)
  const res = await fetch(filename + cacheBust);
  if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 500) {
          return data;
      }
  }
  throw new Error(`Failed to load ${filename} from all paths`);
}

async function getFullMarketTickers(statusEl) {
  if (statusEl) statusEl.innerText = `📋 [1/3] 同步雲端分析數據...`;
  try {
      const list = await fetchCloudJson('scan_results.json');
      state.preScannedResults = list;
      if (statusEl) statusEl.innerText = `✅ 雲端同步完成！取得 ${list.length} 檔技術分析標的。`;
      return list;
  } catch (e) { 
      console.error('Cloud Scanned Data Sync Error:', e); 
  }

  if (statusEl) statusEl.innerText = `⚠️ 雲端數據不可用，改採傳統即時同步...`;
  const result = new Map();
  const add = (code, name, ext) => {
    if (code && !result.has(code)) {
        result.set(code, { id: code + ext, code, name });
    }
  };

  try {
      const list = await fetchCloudJson('market.json');
      list.forEach(i => add(i.code, i.name, i.id.includes('.TW') ? '.TW' : '.TWO'));
      return Array.from(result.values());
  } catch (e) {
      console.warn('Cloud market.json Sync Error:', e);
  }

  try {
    const data = await safeFetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', false, 1);
    if (Array.isArray(data)) data.forEach(i => add(i.Code, i.Name, '.TW'));
  } catch (e) {}

  const otcSources = [
    async () => {
      const url = `https://api.allorigins.win/get?url=${encodeURIComponent('https://www.tpex.org.tw/openapi/v1/t13n04nd')}`;
      const r = await fetch(url);
      const j = await r.json();
      const d = JSON.parse(j.contents);
      if (Array.isArray(d)) d.forEach(i => add(i.SecuritiesCode || i.Code, i.SecuritiesName || i.Name, '.TWO'));
    },
    async () => {
      const url = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent('https://isin.twse.com.tw/isin/C_public.jsp?strMode=4')}`;
      const r = await fetch(url);
      const html = await r.text();
      const m = html.matchAll(/(\d{4,6})(?:\s|&nbsp;|　)+([^<\s]+)/g);
      for (const res of m) add(res[1], res[2], '.TWO');
    }
  ];

  await Promise.allSettled(otcSources.map(f => f().catch(() => {})));
  CORE_STOCKS.forEach(s => add(s.code, s.name, s.id.includes('.TW') ? '.TW' : '.TWO'));
  
  if (statusEl) statusEl.innerText = `✅ 同步完成！取得標的共 ${result.size} 檔。`;
  return Array.from(result.values());
}

async function refreshMarkets() {
  const indices = [
    { s: "^TWII", n: "台股" }, { s: "^N225", n: "日經" }, { s: "^KS11", n: "韓股" },
    { s: "^DJI", n: "道瓊" }, { s: "^IXIC", n: "那指" }, { s: "^SOX", n: "費半" },
    { s: "CL=F", n: "原油" }, { s: "GC=F", n: "黃金" }, { s: "BTC-USD", n: "BTC" }
  ];
  const ticker = document.getElementById('market-ticker');
  if (!ticker) return;
  ticker.innerHTML = '';
  for (const item of indices) {
    try {
      const data = await safeFetch(`${YAHOO_URL}${item.s}?range=1d&interval=1d`);
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose || price;
      const change = price - prevClose;
      const pct = (change / prevClose) * 100;
      const div = document.createElement('div');
      div.className = 'market-item';
      div.innerHTML = `<span>${item.n}</span> <span class="${change >= 0 ? 'price-up' : 'price-down'}">${price.toFixed(0)} (${pct.toFixed(2)}%)</span>`;
      ticker.appendChild(div);
    } catch (e) {}
  }
}

async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan');
  const status = document.getElementById('progress-status');
  const fill = document.getElementById('progress-fill');
  document.getElementById('progress-container').style.display = 'block';
  btn.disabled = true;

  try {
    let tickers = await getFullMarketTickers(status);
    const total = tickers.length;
    status.innerText = `📡 取得標的 ${total} 檔，開始 AI 數據分析...`;

    // 1. If we have cloud pre-scanned results, run instant local scoring
    if (state.preScannedResults && state.preScannedResults.length > 0) {
      // Visual feedback animation
      for (let p = 0; p <= 100; p += 10) {
        fill.style.width = `${p}%`;
        status.innerText = `AI 權重評分計算中... [${p}%]`;
        await new Promise(r => setTimeout(r, 45));
      }

      state.results = scoreAndRank(state.preScannedResults);
      renderResults();

      const monitorContainer = document.getElementById('monitor-all-container');
      if (monitorContainer) monitorContainer.style.display = 'block';

      status.innerText = `✅ 掃描完成！共分析 ${state.preScannedResults.length} 檔，篩選出 TOP 20`;
      return;
    }

    // 2. Fallback: Slow client-side real-time sync with proxy
    let results = [];
    let completed = 0;
    const startTime = Date.now();
    const batchSize = 50; 
    for (let i = 0; i < total; i += batchSize) {
      if (!state.isScanning) break;
      const batchIds = tickers.slice(i, i + batchSize);
      
      const promises = batchIds.map(async (s) => {
        try {
          const data = await safeFetch(`${YAHOO_URL}${s.id}?range=150d&interval=1d`, false, 2);
          const res = data.chart.result[0];
          const quotes = res.indicators.quote[0].close;
          const volumes = res.indicators.quote[0].volume;
          
          const validQuotes = [];
          const validVolumes = [];
          for (let idx = 0; idx < quotes.length; idx++) {
            if (quotes[idx] != null && volumes && volumes[idx] != null) {
              validQuotes.push(quotes[idx]);
              validVolumes.push(volumes[idx]);
            }
          }
          
          if (validQuotes.length >= 60) {
            const feat = calculateFeatures(s, validQuotes);
            if (feat) {
               const lastVol = validVolumes[validVolumes.length - 1] || 0;
               const lastClose = validQuotes[validQuotes.length - 1] || 0;
               const volLots = Math.round(lastVol / 1000);
               const turnMillion = parseFloat(((lastVol * lastClose) / 1000000).toFixed(2));
               results.push({ 
                   ...feat, 
                   volLots,
                   turnMillion,
                   history: validQuotes,
                   timestamps: res.timestamp.filter((_, idx) => quotes[idx] != null)
               });
            }
          }
        } catch (e) {}
        completed++;
      });

      await Promise.all(promises);
      
      const pct = (completed / total) * 100;
      fill.style.width = `${pct}%`;
      const elapsed = (Date.now() - startTime) / 1000;
      const rem = Math.round(((total - completed) * (elapsed / completed)));
      status.innerText = `掃描中: ${completed}/${total} [${pct.toFixed(0)}%] (剩約 ${Math.floor(rem/60)}分${rem%60}秒)`;
      
      await new Promise(r => setTimeout(r, 500));
    }

    state.results = scoreAndRank(results);
    renderResults();
    
    const monitorContainer = document.getElementById('monitor-all-container');
    if (monitorContainer) monitorContainer.style.display = 'block';

    status.innerText = `✅ 掃描完成！共分析 ${results.length} 檔，篩選出 TOP 20`;
  } catch (err) {
    status.innerText = '❌ 掃描異常，請重試';
    console.error(err);
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
}

function monitorAllResults() {
    if (!state.results.length) return;
    const currentResults = state.results;
    let addedCount = 0;
    
    currentResults.forEach(stock => {
        if (!state.watchlist.some(w => w.code === stock.code)) {
            state.watchlist.push({
                id: stock.id,
                code: stock.code,
                name: stock.name,
                currentPrice: stock.close,
                entryPrice: stock.close,
                shares: 1,
                addDate: new Date().toLocaleDateString(),
                addedAt: Date.now()
            });
            addedCount++;
        }
    });
    
    if (addedCount > 0) {
        localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
        updateWatchlistUI();
        alert(`已成功將 ${addedCount} 檔標的加入監控清單！`);
    } else {
        alert('監控清單已包含全部 TOP 20 標的。');
    }
}

async function refreshWatchlistQuotes() {
  if (state.watchlist.length === 0) return;
  const btn = document.getElementById('refresh-watchlist-btn');
  if (btn) btn.disabled = true;
  
  let updated = 0;
  const batchSize = 10;
  for (let i = 0; i < state.watchlist.length; i += batchSize) {
    const batch = state.watchlist.slice(i, i + batchSize);
    const promises = batch.map(async (stock) => {
      try {
        const data = await safeFetch(`${YAHOO_URL}${stock.id}?range=1d&interval=1d`);
        const res = data.chart.result[0];
        const cur = res.indicators.quote[0].close[0];
        if (cur != null) {
          stock.currentPrice = cur;
          updated++;
        }
      } catch (e) {}
    });
    await Promise.all(promises);
  }
  
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
  updateWatchlistUI();
  if (btn) btn.disabled = false;
  alert(`價格刷新完成！共更新 ${updated} 檔標的。`);
}

function clearWatchlist() {
    if (state.watchlist.length === 0) return;
    if (confirm('確定要移除監控清單中的所有標的嗎？此動作無法復原。')) {
        state.watchlist = [];
        localStorage.setItem('watchlist', '[]');
        updateWatchlistUI();
        updateWatchlistBtnUI();
        alert('監控清單已清空。');
    }
}

function calculateFeatures(s, c) {
  const n = c.length;
  if (n < 60) return null;
  
  const cur = c[n-1];
  const ma5 = avg(c.slice(-5)), ma20 = avg(c.slice(-20)), ma60 = avg(c.slice(-60));
  
  const rets = []; 
  for(let i=1; i<n; i++) rets.push((c[i]-c[i-1])/c[i-1]);
  
  // Align with WPF: stdDev * Math.sqrt(252) * 100
  const vol = stdDev(rets.slice(-20)) * Math.sqrt(252) * 100;
  
  const std20 = stdDev(c.slice(-20)); 
  const up = ma20 + 2 * std20;
  const low = ma20 - 2 * std20;
  
  const bbWidth = ((up - low) / ma20) * 100;
  
  return { 
      ...s, 
      id: s.id,
      code: s.code,
      name: s.name,
      close: cur, 
      ma5, ma20, ma60,
      features: [
          vol, 
          bbWidth, 
          (cur / ma60 - 1) * 100, 
          (ma5 / ma60 - 1) * 100, 
          (cur / ma20 - 1) * 100, 
          (cur / up - 1) * 100, 
          (cur / c[n-11] - 1) * 100
      ] 
  };
}

function getScoreFactorValue(r, f) {
  if (f < 7) return r.features[f] || 0;
  if (f === 7) { // 現金殖利率
    const dy = Number(r.dy);
    return (isNaN(dy) || dy < 0) ? 0 : dy;
  }
  if (f === 8) { // 合理估值折價
    const pe = Number(r.pe);
    const fairPEInfo = calculateFairPE(r);
    return (fairPEInfo && pe && pe > 0) ? (fairPEInfo.fairPE - pe) : -999;
  }
  if (f === 9) { // 營收成長動能
    const revYoY = Number(r.revYoY);
    const revCumYoY = Number(r.revCumYoY);
    return !isNaN(revYoY) ? revYoY : (!isNaN(revCumYoY) ? revCumYoY : -999);
  }
  if (f === 10) { // 成交張數
    const vol = Number(r.volLots);
    return (isNaN(vol) || vol < 0) ? 0 : vol;
  }
  if (f === 11) { // 成交金額
    const turn = Number(r.turnMillion);
    return (isNaN(turn) || turn < 0) ? 0 : turn;
  }
  return 0;
}

function scoreAndRank(recs, limit = 20) {
  const n = recs.length; if (n === 0) return [];
  const prs = recs.map(() => new Array(12).fill(0));
  
  for (let f = 0; f < 12; f++) {
    const sorted = recs.map((r, i) => ({ v: getScoreFactorValue(r, f), i })).sort((a,b) => a.v - b.v);
    sorted.forEach((it, ranking) => prs[it.i][f] = (ranking+1)/n);
  }
  
  recs.forEach((r, i) => {
    let sc = 0;
    for (let f = 0; f < 12; f++) {
      sc += prs[i][f] * state.weights[f];
    }
    r.aiScore = (sc / state.weights.reduce((a,b)=>a+b,0)) * 100;
  });
  
  // Return only top 20 carefully
  return recs.filter(r => r.close >= r.ma5).sort((a,b) => b.aiScore - a.aiScore).slice(0, limit);
}

function renderResults() {
  const el = document.getElementById('results-list');
  el.innerHTML = state.results.map(r => `
    <div class="stock-card" onclick="showStockDetails('${r.id}')">
      <div class="stock-info">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="stock-id">${r.code}</span> 
          <span class="stock-name">${r.name}</span>
        </div>
        <div style="font-size: 0.65rem; color: var(--text-secondary); margin-top: 3px; display: flex; gap: 8px;">
          <span>📊 ${r.volLots ? r.volLots.toLocaleString() : 0} 張</span>
          <span>💰 ${r.turnMillion ? (r.turnMillion >= 100 ? (r.turnMillion/100).toFixed(2) + ' 億' : r.turnMillion.toFixed(1) + ' 百萬') : '0.0 百萬'}</span>
        </div>
      </div>
      <div style="text-align:center">
        <div class="price-text">${r.close.toFixed(2)}</div>
      </div>
      <div class="score-badge">${r.aiScore.toFixed(1)}</div>
    </div>
  `).join('');
}

window.showStockDetails = async (id) => {
  const s = state.results.find(r => r.id === id) || 
            state.watchlist.find(w => w.id === id) || 
            state.preScannedResults.find(p => p.id === id) || 
            CORE_STOCKS.find(f => f.id === id);
  if (!s) return;
  
  state.selectedStock = s;
  state.currentTimeframe = '1mo';
  
  document.getElementById('chart-modal').style.display = 'block';
  document.getElementById('modal-title').innerText = `${s.name} (${s.code})`;
  
  updateWatchlistBtnUI();
  updateChartTabsUI();
  
  // Find full fundamental info if available in pre-scanned results
  const fullInfo = state.preScannedResults.find(p => p.id === id) || s;
  renderFinancialGrid(fullInfo);
  renderVolumeTrendChart(s.id);

  renderChart(s.id, '1mo');
};

async function renderChart(symbol, range) {
    const el = document.getElementById('chart-container');
    el.innerHTML = '<div style="color: var(--text-secondary);">載入圖表數據...</div>';
    
    try {
        let interval = '1d';
        if (range === '1d') interval = '5m';
        if (range === '1y') interval = '1wk';
        
        const data = await safeFetch(`${YAHOO_URL}${symbol}?range=${range}&interval=${interval}`);
        const result = data.chart.result[0];
        const timestamps = result.timestamp;
        const prices = result.indicators.quote[0].close;
        
        const chartData = timestamps.map((t, i) => {
            if (prices[i] == null) return null;
            return { x: t * 1000, y: parseFloat(prices[i].toFixed(2)) };
        }).filter(v => v != null);

        const opts = {
            series: [{ name: '價格', data: chartData }],
            chart: { 
                type: 'area', 
                height: 250, 
                toolbar: { show: false },
                zoom: { enabled: false },
                animations: { enabled: true }
            },
            colors: ['#39d2c0'],
            fill: {
                type: 'gradient',
                gradient: {
                    shadeIntensity: 1, opacityFrom: 0.7, opacityTo: 0.2, stops: [0, 90, 100]
                }
            },
            dataLabels: { enabled: false },
            stroke: { curve: 'smooth', width: 2 },
            theme: { mode: 'dark' },
            xaxis: { 
                type: 'datetime',
                labels: { 
                    style: { colors: '#94a3b8', fontSize: '10px' },
                    datetimeFormatter: { year: 'yyyy', month: 'MM/dd', day: 'MM/dd', hour: 'HH:mm' }
                }
            },
            yaxis: {
                labels: { 
                    style: { colors: '#94a3b8', fontSize: '10px' },
                    formatter: (v) => v.toFixed(1)
                }
            },
            grid: { borderColor: 'rgba(255,255,255,0.05)' },
            tooltip: { x: { format: 'yyyy/MM/dd HH:mm' }, theme: 'dark' }
        };

        el.innerHTML = '';
        if (state.currentChart) state.currentChart.destroy();
        state.currentChart = new window.ApexCharts(el, opts);
        state.currentChart.render();
    } catch (e) {
        el.innerHTML = '<div style="color: var(--danger);">圖表載入失敗</div>';
    }
}

window.updateChartTimeframe = (range) => {
    state.currentTimeframe = range;
    updateChartTabsUI();
    if (state.selectedStock) {
        renderChart(state.selectedStock.id, range);
    }
};

function updateChartTabsUI() {
    document.querySelectorAll('.tf-btn').forEach(btn => {
        const range = btn.getAttribute('onclick').match(/'([^']+)'/)[1];
        if (range === state.currentTimeframe) btn.classList.add('active');
        else btn.classList.remove('active');
    });
}

function toggleWatchlist() {
    if (!state.selectedStock) return;
    const s = state.selectedStock;
    const idx = state.watchlist.findIndex(w => w.id === s.id);
    
    if (idx >= 0) {
        state.watchlist.splice(idx, 1);
    } else {
        const now = new Date();
        state.watchlist.push({
            ...s,
            entryPrice: s.close || s.currentPrice || 0,
            currentPrice: s.close || s.currentPrice || 0,
            shares: 1,
            addDate: now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
        });
    }
    
    localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
    updateWatchlistBtnUI();
    updateWatchlistUI();
}

function updateWatchlistBtnUI() {
    const btn = document.getElementById('add-to-watchlist-btn');
    if (!btn || !state.selectedStock) return;
    
    const inWatchlist = state.watchlist.some(w => w.id === state.selectedStock.id);
    if (inWatchlist) {
        btn.innerText = '− 移除監控';
        btn.classList.add('in-watchlist');
    } else {
        btn.innerText = '+ 加入監控';
        btn.classList.remove('in-watchlist');
    }
}

function initWeights() {
  state.weights.forEach((w, i) => {
    const s = document.getElementById(`w${i+1}`);
    const l = document.getElementById(`v-w${i+1}`);
    if (s && l) { 
        s.value = w;
        l.innerText = w.toFixed(0); 
        s.oninput = (e) => {
            state.weights[i] = parseFloat(e.target.value); 
            l.innerText = state.weights[i].toFixed(0);
            document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
        }; 
    }
  });

  const defBtn = document.getElementById('preset-default');
  if (defBtn) defBtn.classList.add('active');

  const m = document.getElementById('monitor-all-btn');
  if(m) m.addEventListener('click', monitorAllResults);
  
  const c = document.getElementById('clear-watchlist-btn');
  if(c) c.addEventListener('click', clearWatchlist);
  
  const r = document.getElementById('refresh-watchlist-btn');
  if(r) r.addEventListener('click', refreshWatchlistQuotes);
}

function toggleWeights() {
  const c = document.getElementById('weight-controls');
  if (c) c.style.display = c.style.display === 'none' ? 'block' : 'none';
}

const MARKET_PRESETS = {
  bull: [60, 70, 50, 90, 60, 80, 90, 0, 0, 0, 0, 0],
  flat: [10, 5, 20, 40, 10, 5, 20, 80, 90, 65, 40, 60],
  bear: [5, 5, 20, 50, 5, 5, 10, 90, 80, 40, 30, 50],
  default: [29.08, 19.33, 10.39, 7.67, 7.26, 5.09, 4.25, 0, 0, 0, 0, 0]
};

window.applyMarketPreset = (key) => {
  const weights = MARKET_PRESETS[key];
  if (!weights) return;
  
  state.weights = [...weights];
  
  state.weights.forEach((w, i) => {
    const s = document.getElementById(`w${i+1}`);
    const l = document.getElementById(`v-w${i+1}`);
    if (s && l) {
      s.value = w;
      l.innerText = w.toFixed(0);
    }
  });
  
  document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`preset-${key}`);
  if (activeBtn) activeBtn.classList.add('active');
  
  const sourceData = (state.preScannedResults && state.preScannedResults.length > 0)
    ? state.preScannedResults
    : (state.results && state.results.length > 0 ? state.results : null);
    
  if (sourceData) {
    state.results = scoreAndRank(sourceData);
    renderResults();
  }
};

function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x,y)=>x+Math.pow(y-m,2),0)/a.length); }

window.switchTab = (t) => {
  state.activeTab = t;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.tab-btn')].find(b => b.innerText.includes(t==='scan'?'目標':'監控'));
  if(btn) btn.classList.add('active');
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const targetSection = document.getElementById(`${t}-section`);
  if (targetSection) targetSection.classList.add('active');
};

function updateWatchlistUI() {
  const l = document.getElementById('watchlist-list'), s = document.getElementById('watchlist-summary');
  if (!l || !s) return;
  
  const searchContainer = document.getElementById('watchlist-search-container');
  const searchInput = document.getElementById('watchlist-search-input');
  const searchClearBtn = document.getElementById('watchlist-search-clear-btn');
  
  // Calculate watchlist totals if there are elements, otherwise show 0
  let totalPnl = 0;
  let totalPrincipal = 0;
  
  state.watchlist.forEach(w => {
    const curP = Number(w.currentPrice) || 0;
    const entP = Number(w.entryPrice) || curP || 0;
    const shares = Number(w.shares) || 0;
    const principal = entP * shares * 1000;
    const amt = (curP - entP) * shares * 1000;
    
    totalPnl += amt;
    totalPrincipal += principal;
  });
  
  const totalPct = totalPrincipal === 0 ? 0 : (totalPnl / totalPrincipal) * 100;
  
  const pctText = isNaN(totalPct) || !isFinite(totalPct) ? '0.00' : totalPct.toFixed(2);
  const principalText = isNaN(totalPrincipal) ? '0' : Math.round(totalPrincipal).toLocaleString();
  const pnlText = isNaN(totalPnl) ? '0' : Math.round(totalPnl).toLocaleString();
  
  if (state.watchlist.length === 0) {
    s.innerHTML = `
      <div style="display:grid; grid-template-columns: 1fr; text-align: center;">
          <div style="font-size:0.65rem; color:var(--text-secondary);">累積總盈虧</div>
          <div style="font-size:0.9rem; font-weight:800; color:var(--text-secondary);">尚無追蹤標的</div>
      </div>
    `;
  } else {
    s.innerHTML = `
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="summary-item">
              <div style="font-size:0.65rem; color:var(--text-secondary);">總投入本金</div>
              <div style="font-size:0.9rem; font-weight:700;">${principalText}</div>
          </div>
          <div class="summary-item" style="text-align:right;">
              <div style="font-size:0.65rem; color:var(--text-secondary);">累積總盈虧</div>
              <div style="font-size:0.9rem; font-weight:800; color:${totalPnl >= 0 ? '#ff4d4d' : '#00ff00'};">
                  ${totalPnl >= 0 ? '+' : ''}${pnlText} (${pctText}%)
              </div>
          </div>
      </div>
    `;
  }
  
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (searchClearBtn) {
    searchClearBtn.style.display = query ? 'inline-block' : 'none';
  }
  
  // If search query is empty
  if (!query) {
    if (state.watchlist.length === 0) {
      l.innerHTML = `
        <div style="text-align: center; padding: 3rem 1rem; color: var(--text-secondary);">
          <div style="font-size: 2rem; margin-bottom: 0.8rem;">📈</div>
          <div style="font-size: 0.85rem; line-height: 1.5; color: var(--text-secondary);">點擊上方的搜尋欄輸入代碼或名稱，<br>即可搜尋全市場個股並加入監控。</div>
        </div>
      `;
    } else {
      l.innerHTML = state.watchlist.map(w => {
        const curP = Number(w.currentPrice) || 0;
        const entP = Number(w.entryPrice) || curP || 0;
        const shares = Number(w.shares) || 0;
        
        const pnlPerShare = curP - entP;
        const pct = entP === 0 ? 0 : (pnlPerShare / entP * 100);
        const amt = pnlPerShare * shares * 1000; 
        
        return `
          <div class="stock-card" onclick="showStockDetails('${w.id}')">
            <div class="stock-info">
                <span class="stock-id">${w.code}</span> 
                <span class="stock-name">${w.name}</span>
                <span style="font-size:0.6rem; color:var(--text-secondary); margin-top:4px;">📅 加入: ${w.addDate || '--'}</span>
            </div>
            <div style="text-align: right;">
                <div class="price-text">${curP.toFixed(2)}</div>
                <div style="color:${pct >= 0 ? '#ff4d4d' : '#00ff00'}; font-size: 0.8rem; font-weight: 700;">
                    ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%
                </div>
                <div style="font-size:0.7rem; color:${pct >= 0 ? '#ff4d4d' : '#00ff00'}; opacity:0.8;">
                    ${Math.round(amt).toLocaleString()} TWD
                </div>
            </div>
          </div>`;
      }).join('');
    }
    return;
  }
  
  // Search active: filter watchlist
  const watchlistMatches = state.watchlist.filter(w => 
    (w.code && w.code.toLowerCase().includes(query)) || 
    (w.name && w.name.toLowerCase().includes(query))
  );
  
  // Search active: filter all market tickers (preScannedResults fallback to CORE_STOCKS)
  const searchUniverse = (state.preScannedResults && state.preScannedResults.length > 0)
    ? state.preScannedResults
    : CORE_STOCKS;
    
  // Exclude already monitored stocks
  const watchlistIds = new Set(state.watchlist.map(w => w.id));
  const rawMarketMatches = searchUniverse.filter(m => 
    !watchlistIds.has(m.id) &&
    ((m.code && m.code.toLowerCase().includes(query)) || 
     (m.name && m.name.toLowerCase().includes(query)))
  );
  
  // Limit all-market results to top 15
  const marketMatches = rawMarketMatches.slice(0, 15);
  
  let html = '';
  
  // Section 1: Watchlist matches
  if (watchlistMatches.length > 0) {
    html += `
      <div style="font-size: 0.75rem; color: var(--accent-color); font-weight: bold; margin: 0.5rem 0 0.5rem 0; padding-left: 4px; display: flex; align-items: center; gap: 4px;">
        📌 已加入監控 (${watchlistMatches.length})
      </div>
    `;
    html += watchlistMatches.map(w => {
      const curP = Number(w.currentPrice) || 0;
      const entP = Number(w.entryPrice) || curP || 0;
      const shares = Number(w.shares) || 0;
      const pnlPerShare = curP - entP;
      const pct = entP === 0 ? 0 : (pnlPerShare / entP * 100);
      const amt = pnlPerShare * shares * 1000;
      
      return `
        <div class="stock-card" onclick="showStockDetails('${w.id}')">
          <div class="stock-info">
              <span class="stock-id">${w.code}</span> 
              <span class="stock-name">${w.name}</span>
              <span style="font-size:0.6rem; color:var(--text-secondary); margin-top:4px;">📅 加入: ${w.addDate || '--'}</span>
          </div>
          <div style="text-align: right;">
              <div class="price-text">${curP.toFixed(2)}</div>
              <div style="color:${pct >= 0 ? '#ff4d4d' : '#00ff00'}; font-size: 0.8rem; font-weight: 700;">
                  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%
              </div>
              <div style="font-size:0.7rem; color:${pct >= 0 ? '#ff4d4d' : '#00ff00'}; opacity:0.8;">
                  ${Math.round(amt).toLocaleString()} TWD
              </div>
          </div>
        </div>`;
    }).join('');
  }
  
  // Section 2: All market matches
  if (marketMatches.length > 0) {
    const showLimitNotice = rawMarketMatches.length > 15;
    html += `
      <div style="font-size: 0.75rem; color: var(--text-secondary); font-weight: bold; margin: 1.2rem 0 0.5rem 0; padding-left: 4px; display: flex; align-items: center; justify-content: space-between;">
        <span>🌐 全市場搜尋結果 (${marketMatches.length}${showLimitNotice ? '+' : ''})</span>
        ${showLimitNotice ? '<span style="font-size: 0.6rem; opacity: 0.7; font-weight: normal;">僅顯示前 15 筆</span>' : ''}
      </div>
    `;
    html += marketMatches.map(m => {
      const price = Number(m.close) || Number(m.currentPrice) || 0;
      const priceText = price > 0 ? price.toFixed(2) : '--';
      return `
        <div class="stock-card" onclick="showStockDetails('${m.id}')" style="border-left: 3px solid var(--text-secondary); opacity: 0.95;">
          <div class="stock-info">
              <span class="stock-id">${m.code}</span> 
              <span class="stock-name">${m.name}</span>
              <span style="font-size:0.6rem; color:var(--text-secondary); margin-top:4px;">🔍 點擊查看詳情</span>
          </div>
          <div style="text-align: right; display: flex; flex-direction: column; justify-content: center; align-items: flex-end;">
              <div class="price-text" style="font-size: 0.9rem;">${priceText}</div>
              <div style="font-size:0.65rem; color: var(--accent-color); margin-top: 4px; font-weight: bold;">
                + 加入監控
              </div>
          </div>
        </div>`;
    }).join('');
  }
  
  if (watchlistMatches.length === 0 && marketMatches.length === 0) {
    html = '<div style="text-align: center; padding: 3rem 1rem; color: var(--text-secondary);">無符合搜尋條件的標的</div>';
  }
  
  l.innerHTML = html;
}

function calculateFairPE(s) {
  const pe = s.pe, pb = s.pb, dy = s.dy;
  // Use cumulative YoY revenue growth as primary growth proxy, fallback to single-month
  const growthRate = (s.revCumYoY != null && !isNaN(s.revCumYoY)) ? s.revCumYoY
                   : (s.revYoY != null && !isNaN(s.revYoY)) ? s.revYoY
                   : null;

  const methods = [];

  // Method 1: PEG-based Fair PE
  // Fair PE ≈ earnings growth rate (PEG=1 principle)
  // Clamp growth to [3, 60] to avoid extreme outliers
  if (growthRate != null && !isNaN(growthRate)) {
    const clampedGrowth = Math.max(3, Math.min(60, Math.abs(growthRate)));
    // If growth is negative, fair PE should be discounted
    const pegFairPE = growthRate >= 0
      ? clampedGrowth * 1.0   // PEG=1 baseline
      : clampedGrowth * 0.6;  // Negative growth → significant discount
    methods.push({ value: pegFairPE, weight: 0.40, name: 'PEG' });
  }

  // Method 2: Dividend Yield inverse method
  // If DY=5%, implies market expects PE ≈ 20; adjust with payout ratio estimate
  if (dy != null && !isNaN(dy) && dy > 0) {
    // Estimated payout ratio from DY and PE: payout ≈ DY * PE / 100
    // Fair PE ≈ payout_ratio / target_yield, target_yield = market avg ~4%
    const estimatedPayout = pe != null && !isNaN(pe) && pe > 0
      ? Math.min(1.0, (dy * pe) / 100)
      : 0.5; // assume 50% payout if PE unavailable
    const targetYield = 0.04; // 4% market average yield for TW
    const dyFairPE = estimatedPayout / targetYield;
    // Clamp to reasonable range
    const clampedDyPE = Math.max(5, Math.min(40, dyFairPE));
    methods.push({ value: clampedDyPE, weight: 0.30, name: 'DY' });
  }

  // Method 3: PB-ROE method
  // ROE ≈ PB / PE, Fair PE ≈ PB / target_ROE
  // Use industry benchmark ROE ~10% as target
  if (pb != null && !isNaN(pb) && pb > 0 && pe != null && !isNaN(pe) && pe > 0) {
    const impliedROE = pb / pe; // decimal form
    // Fair PE = PB / benchmark_ROE; benchmark ~10%
    const benchmarkROE = 0.10;
    const pbrFairPE = pb / benchmarkROE;
    // Also consider: if actual ROE > benchmark, allow premium
    const roePremium = impliedROE > benchmarkROE
      ? 1.0 + (impliedROE - benchmarkROE) * 3 // mild premium for high ROE
      : 1.0;
    const adjustedPbrPE = Math.max(5, Math.min(50, pbrFairPE * Math.min(roePremium, 2.0)));
    methods.push({ value: adjustedPbrPE, weight: 0.30, name: 'PB-ROE' });
  }

  if (methods.length === 0) return null;

  // Normalize weights
  const totalWeight = methods.reduce((sum, m) => sum + m.weight, 0);
  const fairPE = methods.reduce((sum, m) => sum + m.value * (m.weight / totalWeight), 0);

  // Determine valuation verdict
  let verdict, verdictColor, verdictIcon;
  if (pe != null && !isNaN(pe) && pe > 0) {
    const ratio = pe / fairPE;
    if (ratio < 0.75) {
      verdict = '明顯低估'; verdictColor = '#00ff88'; verdictIcon = '🟢';
    } else if (ratio < 0.95) {
      verdict = '偏低估'; verdictColor = '#39d2c0'; verdictIcon = '🔵';
    } else if (ratio <= 1.10) {
      verdict = '合理區間'; verdictColor = '#f0b90b'; verdictIcon = '🟡';
    } else if (ratio <= 1.35) {
      verdict = '偏高估'; verdictColor = '#ff8c00'; verdictIcon = '🟠';
    } else {
      verdict = '明顯高估'; verdictColor = '#ff4d4d'; verdictIcon = '🔴';
    }
  } else {
    verdict = '無法判定'; verdictColor = '#94a3b8'; verdictIcon = '⚪';
  }

  return {
    fairPE: Math.round(fairPE * 10) / 10,
    verdict,
    verdictColor,
    verdictIcon,
    methods: methods.map(m => m.name).join('+')
  };
}

function renderFinancialGrid(s) {
  const grid = document.getElementById('financial-grid');
  if (!grid) return;

  const formatPE = (pe) => (pe == null || isNaN(pe)) ? '--' : pe.toFixed(1);
  const formatPB = (pb) => (pb == null || isNaN(pb)) ? '--' : pb.toFixed(2);
  const formatDY = (dy) => (dy == null || isNaN(dy)) ? '--' : `${dy.toFixed(2)}%`;
  
  const formatRevenue = (rev) => {
    if (rev == null || isNaN(rev)) return '--';
    const amountInYuan = rev * 1000;
    if (amountInYuan >= 100000000) {
      return `${(amountInYuan / 100000000).toFixed(2)} 億`;
    } else {
      return `${Math.round(amountInYuan / 10000).toLocaleString()} 萬`;
    }
  };
  
  const formatChange = (pct) => {
    if (pct == null || isNaN(pct)) return '--';
    const color = pct >= 0 ? '#ff4d4d' : '#00ff00';
    const sign = pct >= 0 ? '+' : '';
    return `<span style="color: ${color}; font-weight: bold;">${sign}${pct.toFixed(1)}%</span>`;
  };

  const fairPEResult = calculateFairPE(s);

  const renderFairPECard = () => {
    if (!fairPEResult) {
      return `
    <div class="financial-card financial-card-fair-pe">
        <div class="financial-card-title">🎯 合理本益比 (Fair P/E)</div>
        <div class="financial-card-value" style="color: #94a3b8;">--</div>
        <div class="financial-card-sub">數據不足，無法估算</div>
    </div>`;
    }
    const { fairPE, verdict, verdictColor, verdictIcon, methods } = fairPEResult;
    const currentPE = formatPE(s.pe);
    const premium = (s.pe != null && !isNaN(s.pe) && s.pe > 0)
      ? ((s.pe / fairPE - 1) * 100).toFixed(1)
      : null;
    const premiumText = premium != null
      ? `<span style="color:${verdictColor}; font-weight:700;">${premium >= 0 ? '+' : ''}${premium}%</span>`
      : '';

    return `
    <div class="financial-card financial-card-fair-pe" style="border-color: ${verdictColor}33;">
        <div class="financial-card-title">🎯 合理本益比 (Fair P/E)</div>
        <div style="display: flex; align-items: baseline; gap: 8px;">
          <div class="financial-card-value" style="color: ${verdictColor};">${fairPE.toFixed(1)}</div>
          <div style="font-size: 0.75rem; color: var(--text-secondary);">
            目前 ${currentPE} ${premiumText}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 5px; margin-top: 2px;">
          <span style="font-size: 0.7rem;">${verdictIcon}</span>
          <span style="font-size: 0.7rem; font-weight: 700; color: ${verdictColor};">${verdict}</span>
          <span style="font-size: 0.55rem; color: var(--text-secondary); margin-left: auto;">模型: ${methods}</span>
        </div>
    </div>`;
  };

  grid.innerHTML = `
    <div class="financial-card">
        <div class="financial-card-title">本益比 (P/E)</div>
        <div class="financial-card-value">${formatPE(s.pe)}</div>
        <div class="financial-card-sub">近四季盈餘計算</div>
    </div>
    <div class="financial-card">
        <div class="financial-card-title">股價淨值比 (P/B)</div>
        <div class="financial-card-value">${formatPB(s.pb)}</div>
        <div class="financial-card-sub">資產安全邊際</div>
    </div>
    <div class="financial-card">
        <div class="financial-card-title">現金殖利率</div>
        <div class="financial-card-value">${formatDY(s.dy)}</div>
        <div class="financial-card-sub">近期配息報酬</div>
    </div>
    <div class="financial-card">
        <div class="financial-card-title">單月營收 (${s.revYm || '--'})</div>
        <div class="financial-card-value">${formatRevenue(s.rev)}</div>
        <div class="financial-card-sub">年增: ${formatChange(s.revYoY)} | 月增: ${formatChange(s.revMoM)}</div>
    </div>
    ${renderFairPECard()}
  `;
}

async function renderVolumeTrendChart(symbol) {
  const el = document.getElementById('volume-chart-container');
  if (!el) return;
  el.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.8rem;">載入成交量數據中...</div>';
  
  try {
    const data = await safeFetch(`${YAHOO_URL}${symbol}?range=1mo&interval=1d`);
    const result = data.chart.result[0];
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    const closes = quotes.close;
    const volumes = quotes.volume;
    
    if (!timestamps || timestamps.length === 0) {
      el.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.8rem;">暫無成交量數據</div>';
      return;
    }
    
    const chartData = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (volumes[i] == null || closes[i] == null) continue;
      const prevClose = i > 0 ? (closes[i - 1] != null ? closes[i - 1] : closes[i]) : closes[i];
      const isUp = closes[i] >= prevClose;
      chartData.push({
        timestamp: timestamps[i] * 1000,
        volumeLots: Math.round(volumes[i] / 1000),
        isUp: isUp
      });
    }
    
    // Take the last 10 trading days (2 weeks)
    const last2Weeks = chartData.slice(-10);
    
    if (last2Weeks.length === 0) {
      el.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.8rem;">暫無成交量數據</div>';
      return;
    }
    
    const categories = last2Weeks.map(d => {
      const date = new Date(d.timestamp);
      return `${date.getMonth() + 1}/${date.getDate()}`;
    });
    
    const seriesData = last2Weeks.map(d => ({
      x: `${new Date(d.timestamp).getMonth() + 1}/${new Date(d.timestamp).getDate()}`,
      y: d.volumeLots,
      isUp: d.isUp
    }));
    
    const opts = {
      series: [{
        name: '成交張數',
        data: seriesData
      }],
      chart: {
        type: 'bar',
        height: 180,
        toolbar: { show: false },
        animations: { enabled: true }
      },
      plotOptions: {
        bar: {
          columnWidth: '55%',
          distributed: true,
          borderRadius: 3
        }
      },
      colors: [
        function({ dataPointIndex, w }) {
          const d = w.config.series[0].data[dataPointIndex];
          if (!d) return '#3b82f6';
          return d.isUp ? '#ef4444' : '#22c55e'; // Red up, Green down (Taiwan Standard)
        }
      ],
      dataLabels: { enabled: false },
      legend: { show: false },
      xaxis: {
        type: 'category',
        categories: categories,
        labels: {
          style: { colors: '#94a3b8', fontSize: '9px' }
        },
        axisBorder: { show: false },
        axisTicks: { show: false }
      },
      yaxis: {
        labels: {
          style: { colors: '#94a3b8', fontSize: '9px' },
          formatter: (v) => `${Math.round(v)}`
        }
      },
      grid: {
        borderColor: 'rgba(255,255,255,0.05)',
        strokeDashArray: 4,
        yaxis: {
          lines: { show: true }
        }
      },
      tooltip: {
        theme: 'dark',
        y: {
          formatter: (v) => `${v} 張`
        }
      }
    };
    
    el.innerHTML = '';
    const chart = new window.ApexCharts(el, opts);
    chart.render();
  } catch (e) {
    console.error('Render volume chart error:', e);
    el.innerHTML = '<div style="color: var(--danger); font-size: 0.8rem;">成交量圖表載入失敗</div>';
  }
}
