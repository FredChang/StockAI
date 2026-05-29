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
  weights: [1.0, 1.5, 0.8, 2.0, 1.2, 1.5, 1.8],
  currentChart: null,
  selectedStock: null,
  currentTimeframe: '1mo'
};

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
  initWeights();
  updateWatchlistUI();
  updateTime();
  setInterval(updateTime, 1000);
  setTimeout(refreshMarkets, 1000);
  
  document.getElementById('start-scan').onclick = runScan;
  document.getElementById('weight-toggle').onclick = toggleWeights;
  document.getElementById('add-to-watchlist-btn').onclick = toggleWatchlist;
  
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

async function safeFetch(url, isHtml = false) {
  try {
    const res = await fetch(PROXY_URL + encodeURIComponent(url));
    if (!res.ok) throw new Error('Fetch Error');
    return isHtml ? await res.text() : await res.json();
  } catch (e) {
    console.error('Fetch failed:', url, e);
    throw e;
  }
}

async function getFullMarketTickers() {
  const tickers = [];
  const modes = [{mode: 2, suffix: '.TW'}, {mode: 4, suffix: '.TWO'}];
  
  for (const {mode, suffix} of modes) {
    try {
      const html = await safeFetch(`${TWSE_LIST_URL}${mode}`, true);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const rows = doc.querySelectorAll('tr');
      
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) return;
        
        const cell0 = cells[0].innerText.trim();
        const category = cells[4].innerText.trim();
        
        const match = cell0.match(/^(\d{4,6})\s+(.+)$/);
        if (match) {
          const code = match[1];
          const name = match[2];
          
          if (category.includes('權證') || category.includes('牛熊證') || category.includes('認購') || category.includes('認售')) return;
          if (code.length === 4 || code.startsWith('00')) {
             tickers.push({ id: code + suffix, code, name });
          }
        }
      });
    } catch (e) {
      console.error(`Failed to fetch mode ${mode}`, e);
    }
  }

  // Deduplicate and merge with CORE_STOCKS if necessary
  const all = [...tickers];
  CORE_STOCKS.forEach(s => {
      if (!all.some(a => a.id === s.id)) all.push(s);
  });
  
  return all.length > 50 ? all : CORE_STOCKS;
}

async function refreshMarkets() {
  const indices = [
    { s: "^TWII", n: "台股" }, { s: "^DJI", n: "道瓊" },
    { s: "^GSPC", n: "S&P500" }, { s: "^SOX", n: "費半" },
    { s: "BTC-USD", n: "BTC" }, { s: "GC=F", n: "黃金" }
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
    status.innerText = '🔍 正在同步全台股清單...';
    let tickers = await getFullMarketTickers();
    const total = tickers.length;
    status.innerText = `📡 取得標的 ${total} 檔，開始 AI 數據分析...`;

    let results = [];
    let completed = 0;
    const startTime = Date.now();
    const batchSize = 15;

    for (let i = 0; i < total; i += batchSize) {
      const batchIds = tickers.slice(i, i + batchSize);
      const promises = batchIds.map(async (s) => {
        try {
          const data = await safeFetch(`${YAHOO_URL}${s.id}?range=150d&interval=1d`);
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
      
      if (i % 30 === 0) await new Promise(r => setTimeout(r, 50));
    }

    state.results = scoreAndRank(results);
    renderResults();
    status.innerText = `✅ 完成！分析 ${results.length} 檔，最優 Top 20 狙擊名單已就緒`;
  } catch (err) {
    status.innerText = '❌ 掃描異常，請重試';
    console.error(err);
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
}

function calculateFeatures(s, c) {
  const n = c.length;
  const cur = c[n-1];
  const ma5 = avg(c.slice(-5)), ma20 = avg(c.slice(-20)), ma60 = avg(c.slice(-60));
  const rets = []; for(let i=1; i<n; i++) rets.push((c[i]-c[i-1])/c[i-1]);
  const vol = stdDev(rets.slice(-20)) * 15.8;
  const std20 = stdDev(c.slice(-20)), up = ma20 + 2 * std20;
  
  return { 
      ...s, 
      id: s.id,
      code: s.code,
      name: s.name,
      close: cur, 
      ma5, ma20, ma60,
      features: [
          vol, 
          ((up - (ma20 - 2 * std20)) / ma20) * 100, 
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
    const pnlPerShare = w.currentPrice - w.entryPrice;
    const pct = (pnlPerShare / w.entryPrice * 100);
    const principal = w.entryPrice * w.shares * 1000;
    const amt = pnlPerShare * w.shares * 1000; 
    
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
            <div class="price-text">${w.currentPrice.toFixed(2)}</div>
            <div style="color:${pct >= 0 ? '#ff4d4d' : '#00ff00'}; font-size: 0.8rem; font-weight: 700;">
                ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%
            </div>
            <div style="font-size:0.7rem; color:${pct >= 0 ? '#ff4d4d' : '#00ff00'}; opacity:0.8;">
                ${amt.toLocaleString()} TWD
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
