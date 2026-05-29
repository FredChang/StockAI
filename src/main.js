import { CORE_STOCKS } from './stocks.js';
import ApexCharts from 'apexcharts';

// --- Constants & State ---
const PROXY_BASE = 'https://api.allorigins.win/get?url=';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

let state = {
  activeTab: 'scan',
  isScanning: false,
  results: [],
  watchlist: JSON.parse(localStorage.getItem('watchlist') || '[]'),
  weights: [1.0, 1.5, 0.8, 2.0, 1.2, 1.5, 1.8],
  currentChart: null
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initWeights();
  refreshMarkets();
  updateWatchlistUI();
  
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  document.getElementById('start-scan').onclick = runScan;
  document.getElementById('weight-toggle').onclick = toggleWeights;
  const closeBtn = document.querySelector('.close-modal');
  if (closeBtn) {
    closeBtn.onclick = () => {
      document.getElementById('chart-modal').style.display = 'none';
      if (state.currentChart) state.currentChart.destroy();
    };
  }
});

window.switchTab = (tab) => {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const btn = [...document.querySelectorAll('.tab-btn')].find(b => b.innerText.includes(tab === 'scan' ? '目標' : '監控'));
  if (btn) btn.classList.add('active');
  
  document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
  const sec = document.getElementById(`${tab}-section`);
  if (sec) sec.classList.add('active');
};

function initWeights() {
  state.weights.forEach((w, i) => {
    const slider = document.getElementById(`w${i+1}`);
    const label = document.getElementById(`v-w${i+1}`);
    if (slider && label) {
      slider.value = w;
      label.innerText = w.toFixed(1);
      slider.oninput = (e) => {
        state.weights[i] = parseFloat(e.target.value);
        label.innerText = state.weights[i].toFixed(1);
      };
    }
  });
}

function toggleWeights() {
  const ctrl = document.getElementById('weight-controls');
  if (ctrl) ctrl.style.display = ctrl.style.display === 'none' ? 'block' : 'none';
}

async function proxyFetch(targetUrl, isJson = true) {
  const url = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
  const res = await fetch(url);
  const data = await res.json();
  const content = data.contents;
  return isJson ? JSON.parse(content) : content;
}

// --- Market Ticker ---
async function refreshMarkets() {
  const symbols = [
    { s: "^TWII", f: "🇹🇼", n: "台股" },
    { s: "^DJI", f: "🇺🇸", n: "道瓊" },
    { s: "^GSPC", f: "🇺🇸", n: "S&P500" },
    { s: "^SOX", f: "🇺🇸", n: "費半" },
    { s: "^IXIC", f: "🇺🇸", n: "NASDQA" },
    { s: "^N225", f: "🇯🇵", n: "日經" },
    { s: "^KS11", f: "🇰🇷", n: "韓股" },
    { s: "GC=F", f: "🟡", n: "金價" },
    { s: "CL=F", f: "🛢️", n: "油價" },
    { s: "BTC-USD", f: "₿", n: "BTC" }
  ];
  const tickerEl = document.getElementById('market-ticker');
  if (!tickerEl) return;
  tickerEl.innerHTML = '';
  
  // 並行抓取所有市場數據，防止序列等待導致的介面卡死
  const results = await Promise.allSettled(symbols.map(async (item) => {
    try {
      const data = await proxyFetch(`${YAHOO_BASE}${item.s}?range=1d&interval=1d`);
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose || price;
      const change = price - prev;
      const pct = (change / prev) * 100;
      
      return { ...item, price, pct, change };
    } catch (e) { return null; }
  }));

  results.forEach(res => {
    if (res.status === 'fulfilled' && res.value) {
      const item = res.value;
      const div = document.createElement('div');
      div.className = 'market-item';
      div.innerHTML = `<span>${item.f} ${item.n}</span> <span class="price-text ${item.change >= 0 ? 'price-up' : 'price-down'}">${item.price.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 2})} (${item.pct.toFixed(2)}%)</span>`;
      tickerEl.appendChild(div);
    }
  });
}

// --- Scanning Logic ---
async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan');
  btn.disabled = true;
  const statusEl = document.getElementById('progress-status');
  const fill = document.getElementById('progress-fill');
  document.getElementById('progress-container').style.display = 'block';
  
  try {
    const tickers = CORE_STOCKS;
    let results = [];
    let completed = 0;
    const batch = 8;
    
    for (let i = 0; i < tickers.length; i += batch) {
      const currentBatch = tickers.slice(i, i + batch);
      await Promise.all(currentBatch.map(async (s) => {
        try {
          const data = await getHistoricalData(s.id);
          if (data && data.length >= 60) {
            const feat = calculateFeatures(s, data);
            if (feat) results.push({ ...feat, history: data });
          }
        } catch (e) {}
        completed++;
      }));
      const pct = (completed / tickers.length) * 100;
      fill.style.width = `${pct}%`;
      statusEl.innerText = `深度 AI 分析中: ${completed}/${tickers.length}`;
      if (i % 24 === 0) await new Promise(r => setTimeout(r, 100));
    }
    
    state.results = scoreAndRank(results);
    renderResults();
    statusEl.innerText = `完成！成功掃描 ${results.length} 檔，列出 Top 20 核心目標`;
  } catch (err) {
    statusEl.innerText = '連線狀況不穩，請點擊重新掃描';
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
}

async function getHistoricalData(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const data = await proxyFetch(`${YAHOO_BASE}${ticker}?period1=${now - 120 * 86400}&period2=${now}&interval=1d`);
  return data.chart.result[0].indicators.quote[0].close.filter(v => v !== null);
}

function calculateFeatures(s, c) {
  const n = c.length; if (n < 60) return null;
  const cur = c[n-1], ma5 = avg(c.slice(-5)), ma20 = avg(c.slice(-20)), ma60 = avg(c.slice(-60));
  const rets = []; for (let i = 1; i < n; i++) rets.push((c[i]-c[i-1])/c[i-1]);
  const vol = stdDev(rets.slice(-20)) * Math.sqrt(252) * 100;
  const up = ma20 + 2 * stdDev(c.slice(-20));
  const feats = [vol, ((up - (ma20 - 2 * stdDev(c.slice(-20)))) / ma20) * 100, (cur/ma60-1)*100, (ma5/ma60-1)*100, (cur/ma20-1)*100, (cur/up-1)*100, (cur/c[n-11]-1)*100];
  return { ...s, close: cur, ma5, features: feats };
}

function scoreAndRank(recs) {
  const n = recs.length; if (n === 0) return [];
  const prs = recs.map(() => new Array(7).fill(0));
  for (let f = 0; f < 7; f++) {
    const s = recs.map((r, i) => ({ v: r.features[f], i })).sort((a,b) => a.v - b.v);
    s.forEach((it, r) => prs[it.i][f] = (r+1)/n);
  }
  recs.forEach((r, i) => {
    let sc = 0; for (let f = 0; f < 7; f++) sc += prs[i][f] * state.weights[f];
    r.aiScore = (sc / state.weights.reduce((a,b)=>a+b,0)) * 100;
  });
  return recs.filter(r => r.close >= r.ma5).sort((a,b) => b.aiScore - a.aiScore).slice(0, 20);
}

function renderResults() {
  const listEl = document.getElementById('results-list'); if (!listEl) return;
  listEl.innerHTML = state.results.map(r => `
    <div class="stock-card" onclick="showStockDetails('${r.id}')">
      <div class="stock-info">
        <span class="stock-id">${r.code}</span>
        <span class="stock-name">${r.name}</span>
      </div>
      <div style="text-align: center">
        <div class="price-text">${r.close.toFixed(2)}</div>
        <div style="font-size: 0.6rem; color: var(--text-secondary)">動能: ${r.features[3].toFixed(1)}%</div>
      </div>
      <div class="stock-score">
        <div class="score-badge">${r.aiScore.toFixed(1)}</div>
        <button class="btn-add-mini" onclick="addToWatchlist(event,'${r.id}')">➕</button>
      </div>
    </div>
  `).join('');
}

window.addToWatchlist = (e, id) => {
  e.stopPropagation(); 
  const s = state.results.find(r => r.id === id); if (!s) return;
  if (state.watchlist.find(w => w.id === id)) return alert('已在監控中');
  state.watchlist.push({ ...s, entryPrice: s.close, currentPrice: s.close, shares: 1 });
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); updateWatchlistUI();
};

function updateWatchlistUI() {
  const l = document.getElementById('watchlist-list'), s = document.getElementById('watchlist-summary'); if (!l || !s) return;
  if (state.watchlist.length === 0) { s.innerText = '尚無監控股票'; l.innerHTML = ''; return; }
  let totalProfit = 0;
  l.innerHTML = state.watchlist.map(w => {
    const p = w.currentPrice - w.entryPrice, amt = p * w.shares * 1000; totalProfit += amt;
    return `
      <div class="stock-card" onclick="showStockDetails('${w.id}')">
        <div class="stock-info"><span class="stock-id">${w.code}</span><span class="stock-name">${w.name}</span></div>
        <div style="text-align: right">
          <div class="price-text ${p>=0?'price-up':'price-down'}">${(p/w.entryPrice*100).toFixed(2)}%</div>
          <div style="font-size: 0.7rem;">${amt.toLocaleString()} TWD</div>
        </div>
        <button class="btn-remove-mini" onclick="removeFromWatchlist(event, '${w.id}')" style="background:none; border:none; color:var(--text-secondary); font-size: 1rem; margin-left:1rem;">🗑️</button>
      </div>
    `;
  }).join('');
  s.innerHTML = `總盈虧預估: ${totalProfit.toLocaleString()} TWD`;
}

window.removeFromWatchlist = (e, id) => {
  e.stopPropagation();
  state.watchlist = state.watchlist.filter(w => w.id !== id);
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); updateWatchlistUI();
};

window.showStockDetails = (id) => {
  const stock = state.results.find(r => r.id === id) || state.watchlist.find(w => w.id === id);
  if (!stock || !stock.history) return;
  
  document.getElementById('chart-modal').style.display = 'block';
  document.getElementById('modal-title').innerText = `${stock.name} (${stock.code}) 趨勢圖`;
  
  const options = {
    series: [{ name: '收盤價', data: stock.history.slice(-30) }],
    chart: { type: 'area', height: 250, toolbar: { show: false }, background: 'transparent' },
    colors: ['#39d2c0'],
    dataLabels: { enabled: false },
    stroke: { curve: 'smooth', width: 3 },
    xaxis: { labels: { show: false }, axisBorder: { show: false } },
    yaxis: { labels: { style: { colors: '#94a3b8' } } },
    grid: { borderColor: 'rgba(255,255,255,0.05)' },
    theme: { mode: 'dark' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0 } }
  };
  
  const chartEl = document.getElementById('chart-container');
  chartEl.innerHTML = '';
  state.currentChart = new ApexCharts(chartEl, options);
  state.currentChart.render();
};

function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x,y)=>x+Math.pow(y-m,2),0)/a.length); }
