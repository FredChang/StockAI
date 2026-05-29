import { CORE_STOCKS } from './stocks.js';

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
  updateWatchlistUI();
  
  // 延後執行，確保 UI 先渲染出來，不影響第一眼觀感
  setTimeout(() => {
    refreshMarkets();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }, 1000);

  // PWA Handle
  let deferredPrompt;
  const installBtn = document.getElementById('pwa-install-btn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.style.display = 'block';
  });

  if (installBtn) {
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      installBtn.style.display = 'none';
      deferredPrompt.prompt();
      deferredPrompt = null;
    };
  }

  document.getElementById('start-scan').onclick = runScan;
  document.getElementById('weight-toggle').onclick = toggleWeights;
  const closeBtn = document.querySelector('.close-modal');
  if (closeBtn) closeBtn.onclick = () => {
    document.getElementById('chart-modal').style.display = 'none';
    if (state.currentChart) {
      state.currentChart.destroy();
      state.currentChart = null;
    }
  };
});

window.switchTab = (tab) => {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = [...document.querySelectorAll('.tab-btn')].find(b => b.innerText.includes(tab === 'scan' ? '目標' : '監控'));
  if (activeBtn) activeBtn.classList.add('active');
  document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
  const sec = document.getElementById(`${tab}-section`);
  if (sec) sec.classList.add('active');
};

function initWeights() {
  state.weights.forEach((w, i) => {
    const s = document.getElementById(`w${i+1}`), l = document.getElementById(`v-w${i+1}`);
    if (s && l) {
      s.value = w; l.innerText = w.toFixed(1);
      s.oninput = (e) => { state.weights[i] = parseFloat(e.target.value); l.innerText = state.weights[i].toFixed(1); };
    }
  });
}

function toggleWeights() {
  const c = document.getElementById('weight-controls');
  if (c) c.style.display = c.style.display === 'none' ? 'block' : 'none';
}

async function proxyFetch(targetUrl, isJson = true) {
  const url = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
  const res = await fetch(url);
  const data = await res.json();
  const content = data.contents;
  return isJson ? JSON.parse(content) : content;
}

async function refreshMarkets() {
  const symbols = [
    { s: "^TWII", f: "🇹🇼", n: "台股" }, { s: "^DJI", f: "🇺🇸", n: "道瓊" },
    { s: "^GSPC", f: "🇺🇸", n: "S&P500" }, { s: "^SOX", f: "🇺🇸", n: "費半" },
    { s: "^IXIC", f: "🇺🇸", n: "NASDQA" }, { s: "^N225", f: "🇯🇵", n: "日經" },
    { s: "^KS11", f: "🇰🇷", n: "韓股" }, { s: "GC=F", f: "🟡", n: "金價" },
    { s: "CL=F", f: "🛢️", n: "油價" }, { s: "BTC-USD", f: "₿", n: "BTC" }
  ];
  const tickerEl = document.getElementById('market-ticker');
  if (!tickerEl) return;
  
  // 先清空「載入中」字樣
  tickerEl.innerHTML = '';

  for (let i = 0; i < symbols.length; i += 2) {
    const batch = symbols.slice(i, i + 2);
    await Promise.allSettled(batch.map(async (item) => {
      try {
        const data = await proxyFetch(`${YAHOO_BASE}${item.s}?range=1d&interval=1d`);
        const meta = data.chart.result[0].meta;
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || price;
        const change = price - prev;
        const pct = (change / prev) * 100;
        
        const div = document.createElement('div');
        div.className = 'market-item';
        div.innerHTML = `<span>${item.f} ${item.n}</span> <span class="price-text ${change >= 0 ? 'price-up' : 'price-down'}">${price.toLocaleString(undefined, {maximumFractionDigits:1})} (${pct.toFixed(2)}%)</span>`;
        tickerEl.appendChild(div);
      } catch (e) {}
    }));
    await new Promise(r => setTimeout(r, 300));
  }
  const t = document.getElementById('update-time');
  if (t) t.innerText = `更新於: ${new Date().toLocaleTimeString()}`;
}

async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan'); btn.disabled = true;
  const statusEl = document.getElementById('progress-status');
  const fill = document.getElementById('progress-fill');
  document.getElementById('progress-container').style.display = 'block';
  
  try {
    const tickers = CORE_STOCKS;
    let results = [];
    let completed = 0;
    const batchSize = 6;
    
    for (let i = 0; i < tickers.length; i += batchSize) {
      const current = tickers.slice(i, i + batchSize);
      await Promise.all(current.map(async (s) => {
        try {
          const data = await getHistoricalData(s.id);
          if (data && data.length >= 60) {
            const feat = calculateFeatures(s, data);
            if (feat) results.push({ ...feat, history: data });
          }
        } catch (e) {}
        completed++;
      }));
      fill.style.width = `${(completed / tickers.length) * 100}%`;
      statusEl.innerText = `分析強度中: ${completed}/${tickers.length}`;
      await new Promise(r => setTimeout(r, 100));
    }
    
    state.results = scoreAndRank(results);
    renderResults();
    statusEl.innerText = `完成！篩選 Top 20 精選強勢股`;
  } catch (err) {
    statusEl.innerText = '連線狀況不穩，請重新掃描';
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
  const cur = c[n-1], ma20 = avg(c.slice(-20)), ma60 = avg(c.slice(-60));
  const rets = []; for (let i = 1; i < n; i++) rets.push((c[i]-c[i-1])/c[i-1]);
  const vol = stdDev(rets.slice(-20)) * Math.sqrt(252) * 100;
  const std20 = stdDev(c.slice(-20));
  const feats = [vol, ((ma20+2*std20 - (ma20-2*std20)) / ma20) * 100, (cur/ma60-1)*100, (avg(c.slice(-5))/ma60-1)*100, (cur/ma20-1)*100, (cur/(ma20+2*std20)-1)*100, (cur/c[n-11]-1)*100];
  return { ...s, close: cur, ma5: avg(c.slice(-5)), features: feats };
}

function scoreAndRank(recs) {
  const n = recs.length; if (n === 0) return [];
  const prs = recs.map(() => new Array(7).fill(0));
  for (let f = 0; f < 7; f++) {
    const sorted = recs.map((r, i) => ({ v: r.features[f], i })).sort((a,b) => a.v - b.v);
    sorted.forEach((it, rank) => prs[it.i][f] = (rank+1)/n);
  }
  recs.forEach((r, i) => {
    let sc = 0; for (let f = 0; f < 7; f++) sc += prs[i][f] * state.weights[f];
    r.aiScore = (sc / state.weights.reduce((a,b)=>a+b,0)) * 100;
  });
  return recs.filter(r => r.close >= r.ma5).sort((a,b) => b.aiScore - a.aiScore).slice(0, 20);
}

function renderResults() {
  const el = document.getElementById('results-list'); if (!el) return;
  el.innerHTML = state.results.map(r => `
    <div class="stock-card" onclick="showStockDetails('${r.id}')">
      <div class="stock-info"><span class="stock-id">${r.code}</span><span class="stock-name">${r.name}</span></div>
      <div style="text-align: center"><div class="price-text">${r.close.toFixed(2)}</div></div>
      <div class="stock-score"><div class="score-badge">${r.aiScore.toFixed(1)}</div><button onclick="addToWatchlist(event,'${r.id}')">➕</button></div>
    </div>
  `).join('');
}

window.addToWatchlist = (e, id) => {
  e.stopPropagation(); const s = state.results.find(r => r.id === id); if (!s) return;
  if (state.watchlist.find(w => w.id === id)) return alert('已在清單');
  state.watchlist.push({ ...s, entryPrice: s.close, currentPrice: s.close, shares: 1 });
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); updateWatchlistUI();
};

function updateWatchlistUI() {
  const l = document.getElementById('watchlist-list'), s = document.getElementById('watchlist-summary'); if (!l || !s) return;
  if (state.watchlist.length === 0) { s.innerText = '尚無監控點標'; l.innerHTML = ''; return; }
  let tot = 0;
  l.innerHTML = state.watchlist.map(w => {
    const p = w.currentPrice - w.entryPrice, amt = p * w.shares * 1000; tot += amt;
    return `<div class="stock-card" onclick="showStockDetails('${w.id}')"><div class="stock-info"><span>${w.code}</span> <span>${w.name}</span></div><div style="text-align: right; color:${p>=0?'var(--danger)':'var(--accent-secondary)'}">${(p/w.entryPrice*100).toFixed(2)}%</div><button onclick="removeFromWatchlist(event, '${w.id}')">🗑️</button></div>`;
  }).join('');
  s.innerText = `總損益: ${tot.toLocaleString()} TWD`;
}

window.removeFromWatchlist = (e, id) => {
  e.stopPropagation(); state.watchlist = state.watchlist.filter(w => w.id !== id);
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); updateWatchlistUI();
};

window.showStockDetails = (id) => {
  const s = state.results.find(r => r.id === id) || state.watchlist.find(w => w.id === id);
  if (!s || !s.history) return;
  document.getElementById('chart-modal').style.display = 'block';
  document.getElementById('modal-title').innerText = `${s.name} (${s.code}) 30日趨勢`;
  const opts = {
    series: [{ name: 'Price', data: s.history.slice(-30) }],
    chart: { type: 'area', height: 250, toolbar: { show: false } },
    colors: ['#39d2c0'], stroke: { curve: 'smooth', width: 2 },
    dataLabels: { enabled: false },
    xaxis: { labels: { show: false } },
    theme: { mode: 'dark' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.3, opacityTo: 0 } }
  };
  const el = document.getElementById('chart-container'); el.innerHTML = '';
  state.currentChart = new window.ApexCharts(el, opts);
  state.currentChart.render();
};

function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x,y)=>x+Math.pow(y-m,2),0)/a.length); }
