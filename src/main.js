// --- 專業版台股動能掃描器 (手機網頁版) ---
const PROXY_BASE = 'https://api.allorigins.win/get?url=';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TWSE_URL = 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=';

let state = {
  activeTab: 'scan',
  isScanning: false,
  results: [],
  watchlist: JSON.parse(localStorage.getItem('watchlist') || '[]'),
  weights: [1.0, 1.5, 0.8, 2.0, 1.2, 1.5, 1.8],
  currentChart: null
};

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
  initWeights();
  updateWatchlistUI();
  
  // 延後加載市場數據
  setTimeout(() => {
    refreshMarkets();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }, 1000);

  document.getElementById('start-scan').onclick = runScan;
  document.getElementById('weight-toggle').onclick = toggleWeights;
  const closeBtn = document.querySelector('.close-modal');
  if (closeBtn) closeBtn.onclick = closeModal;
});

function closeModal() {
  document.getElementById('chart-modal').style.display = 'none';
  if (state.currentChart) { state.currentChart.destroy(); state.currentChart = null; }
}

// --- 切換分頁 ---
window.switchTab = (tab) => {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const targetBtn = [...document.querySelectorAll('.tab-btn')].find(b => b.innerText.includes(tab === 'scan' ? '目標' : '監控'));
  if (targetBtn) targetBtn.classList.add('active');
  
  document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
  const section = document.getElementById(`${tab}-section`);
  if (section) section.classList.add('active');
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

// --- 資料抓取與 Proxy ---
async function proxyFetch(targetUrl, isJson = true) {
  const url = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
  const res = await fetch(url);
  const data = await res.json();
  const content = data.contents;
  if (!content) throw new Error('Proxy 抓取失敗');
  return isJson ? JSON.parse(content) : content;
}

async function refreshMarkets() {
  const indices = [
    { s: "^TWII", f: "🇹🇼", n: "台股" }, { s: "^DJI", f: "🇺🇸", n: "道瓊" },
    { s: "^GSPC", f: "🇺🇸", n: "S&P500" }, { s: "^SOX", f: "🇺🇸", n: "費半" },
    { s: "^IXIC", f: "🇺🇸", n: "NASDQA" }, { s: "^N225", f: "🇯🇵", n: "日經" },
    { s: "^KS11", f: "🇰🇷", n: "韓股" }, { s: "GC=F", f: "🟡", n: "金價" },
    { s: "CL=F", f: "🛢️", n: "油價" }, { s: "BTC-USD", f: "₿", n: "BTC" }
  ];
  const ticker = document.getElementById('market-ticker');
  if (!ticker) return;
  ticker.innerHTML = '';

  for (let i = 0; i < indices.length; i += 2) {
    const batch = indices.slice(i, i + 2);
    await Promise.allSettled(batch.map(async (item) => {
      try {
        const data = await proxyFetch(`${YAHOO_BASE}${item.s}?range=1d&interval=1d`);
        const meta = data.chart.result[0].meta;
        const price = meta.regularMarketPrice;
        const change = price - (meta.chartPreviousClose || price);
        const pct = (change / (meta.chartPreviousClose || price)) * 100;
        
        const div = document.createElement('div');
        div.className = 'market-item';
        div.innerHTML = `<span>${item.f} ${item.n}</span> <span class="price-text ${change >= 0 ? 'price-up' : 'price-down'}">${price.toLocaleString(undefined, {maximumFractionDigits:1})} (${pct.toFixed(2)}%)</span>`;
        ticker.appendChild(div);
      } catch (e) {}
    }));
    await new Promise(r => setTimeout(r, 400));
  }
}

// --- 掃描核心：回歸即時抓取 ---
async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan');
  btn.disabled = true;
  const status = document.getElementById('progress-status');
  const fill = document.getElementById('progress-fill');
  document.getElementById('progress-container').style.display = 'block';
  
  try {
    status.innerText = '正在連線證交所抓取台股標的...';
    const tickers = await fetchAllTickers();
    status.innerText = `成功識別 ${tickers.length} 檔標的，開始 AI 動能分析...`;
    
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
      status.innerText = `深度解析中: ${completed}/${tickers.length}`;
      await new Promise(r => setTimeout(r, 100));
    }
    
    state.results = scoreAndRank(results);
    renderResults();
    status.innerText = `掃描完成！列出 Top 20 核心名單`;
  } catch (err) {
    status.innerText = '連線超時或被證交所阻擋，請稍後重試';
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
}

async function fetchAllTickers() {
  let list = [];
  // 模式 2 是上市，4 是上櫃
  for (const mode of [2, 4]) {
    try {
      const html = await proxyFetch(TWSE_URL + mode, false);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      [...doc.querySelectorAll('tr')].forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 5) {
          const text = cells[0].textContent.trim().replace(/[\s\u3000\u00A0]+/g, ' ');
          const cat = cells[4].textContent.trim();
          const p = text.split(' ');
          if (p.length >= 2 && /^\d{4}$/.test(p[0]) && !cat.includes('權證') && !cat.includes('ETF')) {
            list.push({ id: p[0] + (mode === 2 ? '.TW' : '.TWO'), code: p[0], name: p[1], industry: cat });
          }
        }
      });
    } catch (e) {
      console.error('Mode fetch failed', mode);
    }
  }
  return list;
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
  const up = ma20 + 2 * std20;
  const f = [vol, ((up - (ma20 - 2 * std20)) / ma20) * 100, (cur/ma60-1)*100, (avg(c.slice(-5))/ma60-1)*100, (cur/ma20-1)*100, (cur/up-1)*100, (cur/c[n-11]-1)*100];
  return { ...s, close: cur, ma5: avg(c.slice(-5)), features: f };
}

function scoreAndRank(recs) {
  const n = recs.length; if (n === 0) return [];
  const prs = recs.map(() => new Array(7).fill(0));
  for (let f = 0; f < 7; f++) {
    const s = recs.map((r, i) => ({ v: r.features[f], i })).sort((a,b) => a.v - b.v);
    s.forEach((it, ranking) => prs[it.i][f] = (ranking+1)/n);
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
      <div class="stock-info"><span>${r.code}</span> <span>${r.name}</span></div>
      <div style="text-align:center"><div class="price-text">${r.close.toFixed(2)}</div></div>
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
  const l = document.getElementById('watchlist-list'), s = document.getElementById('watchlist-summary'); if (!l || !s) return;
  if (state.watchlist.length === 0) { s.innerText = '尚無追蹤'; l.innerHTML = ''; return; }
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
  document.getElementById('modal-title').innerText = `${s.name} (${s.code})`;
  const opts = {
    series: [{ name: 'Price', data: s.history.slice(-30) }],
    chart: { type: 'area', height: 250, toolbar: { show: false } },
    colors: ['#39d2c0'], stroke: { curve: 'smooth', width: 2 },
    xaxis: { labels: { show: false } }, theme: { mode: 'dark' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.3, opacityTo: 0 } }
  };
  const el = document.getElementById('chart-container'); el.innerHTML = '';
  // 使用 CDN 載入的全域 ApexCharts
  state.currentChart = new window.ApexCharts(el, opts);
  state.currentChart.render();
};

function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x,y)=>x+Math.pow(y-m,2),0)/a.length); }
