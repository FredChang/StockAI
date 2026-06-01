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
  weights: [29.08, 19.33, 10.39, 7.67, 7.26, 5.09, 4.25],
  version: 'v2.4.0-SyncEngine',
  lastUpdate: '2026.06.01',
  currentChart: null,
  selectedStock: null,
  currentTimeframe: '1mo'
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

async function getFullMarketTickers(statusEl) {
  const result = new Map();
  const add = (code, name, ext) => {
    if (code && !result.has(code)) {
        result.set(code, { id: code + ext, code, name });
    }
  };

  // 1. Priority: Fetch pre-synced market universe (from GitHub Action)
  if (statusEl) statusEl.innerText = `📋 [1/3] 同步市場大局...`;
  try {
      const res = await fetch('./src/market.json?v=' + Date.now());
      if (res.ok) {
          const list = await res.json();
          list.forEach(i => add(i.code, i.name, i.id.includes('.TW') ? '.TW' : '.TWO'));
          if (result.size > 2000) {
              if (statusEl) statusEl.innerText = `✅ GitHub雲端同步完成！取得 ${result.size} 檔標的。`;
              return Array.from(result.values());
          }
      }
  } catch (e) { console.warn('Pre-sync file not found yet'); }

  // 2. Fallback: Traditional Real-time Sync (Listed)
  try {
    const data = await safeFetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', false, 1);
    if (Array.isArray(data)) data.forEach(i => add(i.Code, i.Name, '.TW'));
  } catch (e) {}

  // 3. Fallback: OTC/Emerging Chain
  const now = new Date();
  const dateStr = `${now.getFullYear()-1911}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;
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

    let results = [];
    let completed = 0;
    const startTime = Date.now();
    // Speed optimization: Increased concurrency to 15, slightly shorter wait.
    const batchSize = 20; 
    for (let i = 0; i < total; i += batchSize) {
      if (!state.isScanning) break;
      const batchIds = tickers.slice(i, i + batchSize);
      
      const promises = batchIds.map(async (s) => {
        try {
          const data = await safeFetch(`${YAHOO_URL}${s.id}?range=150d&interval=1d`, false, 2);
          const res = data.chart.result[0];
          const quotes = res.indicators.quote[0].close;
          const validQuotes = quotes.filter(v => v != null);
          
          if (validQuotes.length >= 60) {
            const feat = calculateFeatures(s, validQuotes);
            if (feat) {
               results.push({ 
                   ...feat, 
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
      
      await new Promise(r => setTimeout(r, 600));
    }

    state.results = scoreAndRank(results);
    renderResults();
    
    // Show Monitor All button after scan
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

function scoreAndRank(recs, limit = 20) {
  const n = recs.length; if (n === 0) return [];
  const prs = recs.map(() => new Array(7).fill(0));
  
  for (let f = 0; f < 7; f++) {
    const sorted = recs.map((r, i) => ({ v: r.features[f] || 0, i })).sort((a,b) => a.v - b.v);
    sorted.forEach((it, ranking) => prs[it.i][f] = (ranking+1)/n);
  }
  
  recs.forEach((r, i) => {
    let sc = 0; for (let f = 0; f < 7; f++) sc += prs[i][f] * state.weights[f];
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
        <span class="stock-id">${r.code}</span> 
        <span class="stock-name">${r.name}</span>
      </div>
      <div style="text-align:center">
        <div class="price-text">${r.close.toFixed(2)}</div>
      </div>
      <div class="score-badge">${r.aiScore.toFixed(1)}</div>
    </div>
  `).join('');
}

window.showStockDetails = async (id) => {
  const s = state.results.find(r => r.id === id) || state.watchlist.find(w => w.id === id) || CORE_STOCKS.find(f => f.id === id);
  if (!s) return;
  
  state.selectedStock = s;
  state.currentTimeframe = '1mo';
  
  document.getElementById('chart-modal').style.display = 'block';
  document.getElementById('modal-title').innerText = `${s.name} (${s.code})`;
  
  updateWatchlistBtnUI();
  updateChartTabsUI();
  
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
            entryPrice: s.close,
            currentPrice: s.close,
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
    const s = document.getElementById(`w${i+1}`), l = document.getElementById(`v-w${i+1}`);
    if(s && l){ 
        s.value=w; l.innerText=w.toFixed(1); 
        s.oninput=(e)=>{
            state.weights[i]=parseFloat(e.target.value); 
            l.innerText=state.weights[i].toFixed(1);
        }; 
    }
  });
  const m = document.getElementById('monitor-all-btn');
  if(m) m.addEventListener('click', monitorAllResults);
  
  const c = document.getElementById('clear-watchlist-btn');
  if(c) c.addEventListener('click', clearWatchlist);
  
  const r = document.getElementById('refresh-watchlist-btn');
  if(r) r.addEventListener('click', refreshWatchlistQuotes);
}

function toggleWeights() {
  const c = document.getElementById('weight-controls');
  if(c) c.style.display = c.style.display==='none'?'block':'none';
}

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
  if (state.watchlist.length === 0) { 
      s.innerText = '尚無追蹤標的'; 
      l.innerHTML = '<div style="text-align: center; padding: 3rem 1rem; color: var(--text-secondary);">點擊股票加入監控</div>'; 
      return; 
  }
  
  let totalPnl = 0;
  let totalPrincipal = 0;
  
  l.innerHTML = state.watchlist.map(w => {
    const curP = w.currentPrice || 0;
    const entP = w.entryPrice || curP || 0;
    const shares = w.shares || 0;
    
    const pnlPerShare = curP - entP;
    const pct = entP === 0 ? 0 : (pnlPerShare / entP * 100);
    const principal = entP * shares * 1000;
    const amt = pnlPerShare * shares * 1000; 
    
    totalPnl += amt;
    totalPrincipal += principal;
    
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
  
  const totalPct = (totalPnl / totalPrincipal) * 100;
  
  s.innerHTML = `
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <div class="summary-item">
            <div style="font-size:0.65rem; color:var(--text-secondary);">總投入本金</div>
            <div style="font-size:0.9rem; font-weight:700;">${totalPrincipal.toLocaleString()}</div>
        </div>
        <div class="summary-item" style="text-align:right;">
            <div style="font-size:0.65rem; color:var(--text-secondary);">累積總盈虧</div>
            <div style="font-size:0.9rem; font-weight:800; color:${totalPnl >= 0 ? '#ff4d4d' : '#00ff00'};">
                ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()} (${totalPct.toFixed(2)}%)
            </div>
        </div>
    </div>
  `;
}
