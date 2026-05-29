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

// --- 掃描核心：全市場抓取 (優化防封鎖邏輯) ---
async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan');
  btn.disabled = true;
  const statusEl = document.getElementById('progress-status');
  const fill = document.getElementById('progress-fill');
  document.getElementById('progress-container').style.display = 'block';
  
  try {
    statusEl.innerText = '正在擷取證交所最新名單...';
    let tickers = await fetchAllTickers();
    const total = tickers.length;
    statusEl.innerText = `成功識別 ${total} 檔標的，準備開始分析...`;
    
    let results = [];
    let completed = 0;
    const batchSize = 3; 
    const startTime = Date.now();
    
    for (let i = 0; i < total; i += batchSize) {
      const currentBatch = tickers.slice(i, i + batchSize);
      
      await Promise.all(currentBatch.map(async (s) => {
        try {
          const data = await getHistoricalData(s.id);
          if (data && data.length >= 40) {
            const feat = calculateFeatures(s, data);
            if (feat) results.push({ ...feat, history: data });
          }
        } catch (e) {}
        completed++;
      }));
      
      // 計算進度與預估時間
      const pct = (completed / total) * 100;
      fill.style.width = `${pct}%`;
      
      const timeElapsed = (Date.now() - startTime) / 1000;
      const timePerStock = timeElapsed / completed;
      const remainingStocks = total - completed;
      const secondsLeft = Math.round(remainingStocks * timePerStock);
      
      let timeText = '';
      if (completed > 15) { // 掃描超過 15 檔後開始顯示預估時間
        const mins = Math.floor(secondsLeft / 60);
        const secs = secondsLeft % 60;
        timeText = ` (約剩 ${mins > 0 ? mins + '分 ' : ''}${secs}秒)`;
      }
      
      statusEl.innerText = `全市場分析: ${completed}/${total} [${pct.toFixed(0)}%]${timeText}`;
      
      if (completed % 15 === 0) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    
    state.results = scoreAndRank(results);
    renderResults();
    statusEl.innerText = `掃描完成！列出前 20 檔目標標的`;
    
  } catch (err) {
    statusEl.innerText = '連線異常，請重新點擊掃描';
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
}

async function fetchAllTickers() {
  let list = [];
  const apis = [
    { url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', mode: 'TW' }, // 上市
    { url: 'https://openapi.twse.com.tw/v1/tpex/STOCK_DAY_ALL', mode: 'TWO' } // 上櫃
  ];

  for (const api of apis) {
    try {
      // 官方 Open Data API 通常支援 CORS, 若不行則走 Proxy
      let data;
      try {
        const res = await fetch(api.url);
        data = await res.json();
      } catch (e) {
        data = await proxyFetch(api.url);
      }

      if (Array.isArray(data)) {
        data.forEach(item => {
          const code = item.Code || item.ID || item.stkNo;
          const name = item.Name || item.stkName;
          if (code && /^\d{4}$/.test(code)) {
            list.push({
              id: `${code}.${api.mode}`,
              code: code,
              name: name
            });
          }
        });
      }
    } catch (e) {
      console.error(`Fetch API failed: ${api.url}`, e);
    }
  }
  
  // 若官方 API 報廢，則使用保底名單（防止結果為空）
  if (list.length < 100) {
      return [
        {id:"2330.TW",code:"2330",name:"台積電"}, {id:"2317.TW",code:"2317",name:"鴻海"},
        {id:"2454.TW",code:"2454",name:"聯發科"}, {id:"2308.TW",code:"2308",name:"台達電"},
        {id:"2382.TW",code:"2382",name:"廣達"},    {id:"1513.TW",code:"1513",name:"中興電"}
      ];
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
