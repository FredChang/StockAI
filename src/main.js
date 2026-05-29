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
  marketData: []
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initWeights();
  refreshMarkets();
  updateWatchlistUI();
  
  // Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // PWA Install Button
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
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`PWA Result: ${outcome}`);
      deferredPrompt = null;
    };
  }

  document.getElementById('start-scan').addEventListener('click', runScan);
  document.getElementById('weight-toggle').addEventListener('click', toggleWeights);
  const closeBtn = document.querySelector('.close-modal');
  if (closeBtn) closeBtn.onclick = () => document.getElementById('chart-modal').style.display = 'none';
});

window.switchTab = (tab) => {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = [...document.querySelectorAll('.tab-btn')].find(b => b.innerText.includes(tab === 'scan' ? '目標' : '監控'));
  if (activeBtn) activeBtn.classList.add('active');
  
  document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
  const targetSection = document.getElementById(`${tab}-section`);
  if (targetSection) targetSection.classList.add('active');
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

async function refreshMarkets() {
  const symbols = [
    { s: "^TWII", f: "🇹🇼", n: "台股" },
    { s: "^GSPC", f: "🇺🇸", n: "SP500" },
    { s: "BTC-USD", f: "₿", n: "BTC" }
  ];
  const tickerEl = document.getElementById('market-ticker');
  if (!tickerEl) return;
  tickerEl.innerHTML = '';
  
  for (const item of symbols) {
    try {
      const data = await proxyFetch(`${YAHOO_BASE}${item.s}?range=1d&interval=1d`);
      const meta = data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      const change = price - (meta.chartPreviousClose || price);
      const pct = (change / (meta.chartPreviousClose || price)) * 100;
      
      const div = document.createElement('div');
      div.className = 'market-item';
      div.innerHTML = `<span>${item.f} ${item.n}</span> <span class="price-text ${change >= 0 ? 'price-up' : 'price-down'}">${price.toLocaleString()} (${pct.toFixed(2)}%)</span>`;
      tickerEl.appendChild(div);
    } catch (e) {}
  }
}

async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan');
  btn.disabled = true;
  const statusStatus = document.getElementById('progress-status');
  const fill = document.getElementById('progress-fill');
  document.getElementById('progress-container').style.display = 'block';
  
  try {
    const tickers = CORE_STOCKS; // 直接使用內建名單，不再抓證交所
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
            if (feat) results.push(feat);
          }
        } catch (e) {}
        completed++;
      }));
      const pct = (completed / tickers.length) * 100;
      fill.style.width = `${pct}%`;
      statusStatus.innerText = `分析強度中: ${completed}/${tickers.length}`;
      if (i % 24 === 0) await new Promise(r => setTimeout(r, 120));
    }
    
    state.results = scoreAndRank(results);
    renderResults();
    statusStatus.innerText = `完成！篩選出 ${state.results.length} 個強勢標的`;
  } catch (err) {
    statusStatus.innerText = '連線超時，請重新掃描';
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
  const std20 = stdDev(c.slice(-20));
  const up = ma20 + 2 * std20;
  const feats = [vol, ((up - (ma20 - 2 * std20)) / ma20) * 100, (cur/ma60-1)*100, (ma5/ma60-1)*100, (cur/ma20-1)*100, (cur/up-1)*100, (cur/c[n-11]-1)*100];
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
  return recs.filter(r => r.close >= r.ma5).sort((a,b) => b.aiScore - a.aiScore).slice(20);
}

function renderResults() {
  const listEl = document.getElementById('results-list'); if (!listEl) return;
  listEl.innerHTML = state.results.map(r => `
    <div class="stock-card" onclick="showStockDetails('${r.id}')">
      <div class="stock-info"><span class="stock-id">${r.code}</span><span class="stock-name">${r.name}</span></div>
      <div style="text-align: center"><div class="price-text">${r.close.toFixed(2)}</div></div>
      <div class="stock-score"><div class="score-badge">${r.aiScore.toFixed(1)}</div><button onclick="addToWatchlist(event,'${r.id}')">➕</button></div>
    </div>
  `).join('');
}

window.addToWatchlist = (e, id) => {
  e.stopPropagation(); const s = state.results.find(r => r.id === id); if (!s) return;
  if (state.watchlist.find(w => w.id === id)) return alert('已在監控中');
  state.watchlist.push({ ...s, entryPrice: s.close, currentPrice: s.close, shares: 1 });
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); updateWatchlistUI();
};

function updateWatchlistUI() {
  const l = document.getElementById('watchlist-list'), summaryEl = document.getElementById('watchlist-summary'); if (!l || !summaryEl) return;
  if (state.watchlist.length === 0) { summaryEl.innerText = '尚未追蹤任何股票'; l.innerHTML = ''; return; }
  let totalProfit = 0;
  l.innerHTML = state.watchlist.map(w => {
    const diff = w.currentPrice - w.entryPrice, amt = diff * w.shares * 1000; totalProfit += amt;
    return `<div class="stock-card"><div class="stock-info"><span class="stock-id">${w.code}</span><span class="stock-name">${w.name}</span></div><div style="text-align: right; color:${diff>=0?'var(--danger)':'var(--accent-secondary)'}">${(diff/w.entryPrice*100).toFixed(2)}%</div><button onclick="removeFromWatchlist('${w.id}')">🗑️</button></div>`;
  }).join('');
  summaryEl.innerHTML = `預估盈虧: ${totalProfit.toLocaleString()} TWD`;
}

window.removeFromWatchlist = (id) => {
  state.watchlist = state.watchlist.filter(w => w.id !== id);
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist)); updateWatchlistUI();
};

function showStockDetails(id) {
  document.getElementById('chart-modal').style.display = 'block';
}

function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x,y)=>x+Math.pow(y-m,2),0)/a.length); }
