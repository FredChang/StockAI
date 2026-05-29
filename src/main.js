// --- Constants & State ---
// 使用 allorigins 穩定版 API 接口
const PROXY_BASE = 'https://api.allorigins.win/get?url=';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TWSE_LIST_URL = 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=';

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
  
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW Failed', err));
    });
  }

  document.getElementById('start-scan').addEventListener('click', runScan);
  document.getElementById('weight-toggle').addEventListener('click', toggleWeights);
  document.querySelector('.close-modal').addEventListener('click', () => {
    document.getElementById('chart-modal').style.display = 'none';
  });
});

window.switchTab = (tab) => {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const targetTab = document.querySelector(`.tab-btn[onclick*="${tab}"]`);
  if (targetTab) targetTab.classList.add('active');
  
  document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
  document.getElementById(`${tab}-section`).classList.add('active');
};

function initWeights() {
  state.weights.forEach((w, i) => {
    const slider = document.getElementById(`w${i+1}`);
    const label = document.getElementById(`v-w${i+1}`);
    if (slider && label) {
      slider.value = w;
      label.innerText = w.toFixed(1);
      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.weights[i] = val;
        label.innerText = val.toFixed(1);
      });
    }
  });
}

function toggleWeights() {
  const controls = document.getElementById('weight-controls');
  if (controls) controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
}

// --- 通用 Fetch 函式 (處理 Proxy) ---
async function proxyFetch(targetUrl, isJson = true) {
  const url = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Proxy Error: ${res.status}`);
  const data = await res.json(); // allorigins /get 回傳格式一定是 JSON
  const content = data.contents; // 真正的內容在 contents 裡面
  
  if (isJson) {
    return JSON.parse(content);
  }
  return content;
}

// --- Market Ticker ---
async function refreshMarkets() {
  const symbols = [
    { s: "^TWII", f: "🇹🇼", n: "台股" },
    { s: "^GSPC", f: "🇺🇸", n: "S&P500" },
    { s: "^IXIC", f: "🇺🇸", n: "Nasdaq" },
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
      const prev = meta.chartPreviousClose || price;
      const change = price - prev;
      const pct = (change / prev) * 100;
      
      const div = document.createElement('div');
      div.className = 'market-item';
      div.innerHTML = `
        <span>${item.f} ${item.n}</span>
        <span class="price-text ${change >= 0 ? 'price-up' : 'price-down'}">
          ${price.toLocaleString()} (${change >= 0 ? '+' : ''}${pct.toFixed(2)}%)
        </span>
      `;
      tickerEl.appendChild(div);
    } catch (e) {
      console.error(e);
      const div = document.createElement('div');
      div.className = 'market-item';
      div.innerText = `${item.n} 載入中...`;
      tickerEl.appendChild(div);
    }
  }
  const timeEl = document.getElementById('update-time');
  if (timeEl) timeEl.innerText = `更新於: ${new Date().toLocaleTimeString()}`;
}

// --- Scanning Logic ---
async function runScan() {
  if (state.isScanning) return;
  state.isScanning = true;
  const btn = document.getElementById('start-scan');
  btn.disabled = true;
  btn.innerText = '掃描中...';
  
  const progressContainer = document.getElementById('progress-container');
  const progressFill = document.getElementById('progress-fill');
  const progressStatus = document.getElementById('progress-status');
  progressContainer.style.display = 'block';
  
  try {
    progressStatus.innerText = '正在抓取台股標的名單...';
    const tickers = await getStockList();
    if (tickers.length === 0) throw new Error('未能取得股票清單');
    
    progressStatus.innerText = `取得 ${tickers.length} 檔標的，開始下載歷史數據...`;
    
    let results = [];
    let completed = 0;
    const batchSize = 5; // 降低批次量以提高穩定性
    
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      await Promise.all(batch.map(async (stock) => {
        try {
          const data = await getHistoricalData(stock.id);
          if (data && data.length >= 60) {
            const features = calculateFeatures(stock, data);
            if (features) results.push(features);
          }
        } catch (e) {}
        completed++;
      }));
      
      const pct = (completed / tickers.length) * 100;
      progressFill.style.width = `${pct}%`;
      progressStatus.innerText = `分析中: ${completed}/${tickers.length} (${pct.toFixed(0)}%)`;
      
      // 每處理一小部分休息一下，避免 Proxy 封鎖
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 200));
    }
    
    progressStatus.innerText = '正在進行 AI 權重排名...';
    state.results = scoreAndRank(results);
    renderResults();
    progressStatus.innerText = `掃描完成！篩選出 ${state.results.length} 檔強勢股`;
    
  } catch (err) {
    console.error(err);
    progressStatus.innerText = '❌ 掃描發生錯誤: ' + err.message;
    alert('掃描發生錯誤: ' + err.message);
  } finally {
    state.isScanning = false;
    btn.disabled = false;
    btn.innerText = '開始全市場掃描';
  }
}

async function getStockList() {
  let list = [];
  try {
    for (const mode of [2, 4]) {
      const html = await proxyFetch(TWSE_LIST_URL + mode, false);
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const rows = doc.querySelectorAll('tr');
      
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 5) {
          const cell0 = cells[0].textContent.trim();
          const cat = cells[4].textContent.trim();
          
          // 移除所有不可見字元與全形空白
          const cleanText = cell0.replace(/[\s\u3000\u00A0]+/g, ' ');
          const parts = cleanText.split(' ');
          
          if (parts.length >= 2 && /^\d{4}$/.test(parts[0])) {
            if (!cat.includes('權證') && !cat.includes('ETF') && !cat.includes('受益證券')) {
              list.push({ 
                id: parts[0] + (mode === 2 ? '.TW' : '.TWO'), 
                code: parts[0], 
                name: parts[1], 
                industry: cat 
              });
            }
          }
        }
      });
      console.log(`Mode ${mode} loaded: ${list.length} stocks`);
    }
  } catch (e) { 
    console.error('Stock List Error:', e); 
    throw new Error('存取證交所清單失敗，請稍後再試');
  }
  return list;
}

async function getHistoricalData(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (120 * 86400); // 抓 120 天確保有足夠交易日
  const data = await proxyFetch(`${YAHOO_BASE}${ticker}?period1=${start}&period2=${now}&interval=1d`);
  const result = data.chart.result[0];
  const closes = result.indicators.quote[0].close;
  return closes.filter(v => v !== null);
}

function calculateFeatures(stock, closes) {
  const n = closes.length;
  if (n < 60) return null;
  const cur = closes[n - 1];
  const ma5 = avg(closes.slice(-5));
  const ma20 = avg(closes.slice(-20));
  const ma60 = avg(closes.slice(-60));
  
  const returns = [];
  for (let i = 1; i < n; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  
  const histVol = stdDev(returns.slice(-20)) * Math.sqrt(252) * 100;
  const std20 = stdDev(closes.slice(-20));
  const bbUpper = ma20 + 2 * std20;
  const bbWidth = ((bbUpper - (ma20 - 2 * std20)) / ma20) * 100;
  
  const pToMA60 = ((cur / ma60) - 1) * 100;
  const trendStr = ((ma5 / ma60) - 1) * 100;
  const pToMA20 = ((cur / ma20) - 1) * 100;
  const pToBBUp = ((cur / bbUpper) - 1) * 100;
  const roc10 = ((cur / closes[n - 11]) - 1) * 100;

  return {
    ...stock,
    close: cur, ma5,
    features: [histVol, bbWidth, pToMA60, trendStr, pToMA20, pToBBUp, roc10]
  };
}

function scoreAndRank(records) {
  const n = records.length;
  if (n === 0) return [];
  const prs = records.map(() => new Array(7).fill(0));
  for (let f = 0; f < 7; f++) {
    const sorted = records.map((r, i) => ({ v: r.features[f], i })).sort((a, b) => a.v - b.v);
    sorted.forEach((item, rank) => { prs[item.i][f] = (rank + 1) / n; });
  }
  const weightSum = state.weights.reduce((a, b) => a + b, 0);
  records.forEach((r, i) => {
    let score = 0;
    for (let f = 0; f < 7; f++) score += prs[i][f] * state.weights[f];
    r.aiScore = (score / weightSum) * 100;
  });
  return records.filter(r => r.close >= r.ma5).sort((a, b) => b.aiScore - a.aiScore).slice(0, 20);
}

function renderResults() {
  const list = document.getElementById('results-list');
  if (!list) return;
  list.innerHTML = state.results.map(r => `
    <div class="stock-card" onclick="showStockDetails('${r.id}')">
      <div class="stock-info">
        <span class="stock-id">${r.code}</span>
        <span class="stock-name">${r.name}</span>
        <span style="font-size: 0.7rem; color: var(--text-secondary)">${r.industry}</span>
      </div>
      <div style="text-align: center">
        <div class="price-text">${r.close.toFixed(2)}</div>
        <div style="font-size: 0.7rem; color: var(--text-secondary)">位階: ${r.features[2].toFixed(1)}%</div>
      </div>
      <div class="stock-score">
        <div class="score-badge">${r.aiScore.toFixed(1)}</div>
        <button class="btn-add" onclick="addToWatchlist(event, '${r.id}')">➕</button>
      </div>
    </div>
  `).join('');
}

window.addToWatchlist = (e, id) => {
  e.stopPropagation();
  const stock = state.results.find(r => r.id === id);
  if (!stock) return;
  if (state.watchlist.find(w => w.id === id)) { alert('已在監控清單中'); return; }
  state.watchlist.push({ ...stock, entryPrice: stock.close, currentPrice: stock.close, shares: 1, date: new Date().toLocaleDateString() });
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
  updateWatchlistUI();
  alert(`已將 ${stock.name} 加入監控`);
};

function updateWatchlistUI() {
  const list = document.getElementById('watchlist-list');
  const summary = document.getElementById('watchlist-summary');
  if (!list || !summary) return;
  if (state.watchlist.length === 0) { summary.innerText = '尚無監控股票'; list.innerHTML = ''; return; }
  let totalPnL = 0;
  list.innerHTML = state.watchlist.map(w => {
    const pnl = w.currentPrice - w.entryPrice;
    const pnlPct = (pnl / w.entryPrice) * 100;
    const pnlAmt = pnl * w.shares * 1000;
    totalPnL += pnlAmt;
    return `
      <div class="stock-card">
        <div class="stock-info"><span class="stock-id">${w.code}</span><span class="stock-name">${w.name}</span></div>
        <div style="text-align: right">
          <div class="price-text ${pnl >= 0 ? 'price-up' : 'price-down'}">${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</div>
          <div style="font-size: 0.8rem;">${pnlAmt.toLocaleString()} TWD</div>
        </div>
        <button onclick="removeFromWatchlist('${w.id}')" style="background:none; border:none; color:var(--text-secondary); font-size: 1.2rem; margin-left:1rem;">🗑️</button>
      </div>
    `;
  }).join('');
  summary.innerHTML = `<div style="display:flex; justify-content:space-between;"><span>共 ${state.watchlist.length} 檔</span><span class="${totalPnL >= 0 ? 'price-up' : 'price-down'}" style="font-weight:800;">總盈虧: ${totalPnL.toLocaleString()} TWD</span></div>`;
}

window.removeFromWatchlist = (id) => {
  state.watchlist = state.watchlist.filter(w => w.id !== id);
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
  updateWatchlistUI();
};

window.showStockDetails = (id) => {
  document.getElementById('chart-modal').style.display = 'block';
  const stock = state.results.find(r => r.id === id) || state.watchlist.find(w => w.id === id);
  document.getElementById('modal-title').innerText = `${stock.name} (${stock.code}) 詳情`;
};

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdDev(arr) {
  const mu = avg(arr);
  return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mu, 2), 0) / arr.length);
}
