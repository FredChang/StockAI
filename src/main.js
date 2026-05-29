// --- 全市場精選標的 (嵌入名單以保證穩定) ---
const FULL_MARKET_LIST = [
  {id:"2330.TW",code:"2330",name:"台積電"}, {id:"2317.TW",code:"2317",name:"鴻海"},
  {id:"2454.TW",code:"2454",name:"聯發科"}, {id:"2308.TW",code:"2308",name:"台達電"},
  {id:"2382.TW",code:"2382",name:"廣達"},    {id:"2357.TW",code:"2357",name:"華碩"},
  {id:"3231.TW",code:"3231",name:"緯創"},    {id:"2376.TW",code:"2376",name:"技嘉"},
  {id:"2603.TW",code:"2603",name:"長榮"},    {id:"2609.TW",code:"2609",name:"陽明"},
  {id:"2615.TW",code:"2615",name:"萬海"},    {id:"2610.TW",code:"2610",name:"華航"},
  {id:"2618.TW",code:"2618",name:"長榮航"},  {id:"1513.TW",code:"1513",name:"中興電"},
  {id:"1519.TW",code:"1519",name:"華城"},    {id:"1503.TW",code:"1503",name:"士電"},
  {id:"1514.TW",code:"1514",name:"亞力"},    {id:"2353.TW",code:"2353",name:"宏碁"},
  {id:"2324.TW",code:"2324",name:"仁寶"},    {id:"2301.TW",code:"2301",name:"光寶科"},
  {id:"2345.TW",code:"2345",name:"智邦"},    {id:"3017.TW",code:"3017",name:"奇鋐"},
  {id:"3324.TW",code:"3324",name:"雙鴻"},    {id:"3037.TW",code:"3037",name:"欣興"},
  {id:"3035.TW",code:"3035",name:"智原"},    {id:"3661.TW",code:"3661",name:"世芯-KY"},
  {id:"3443.TW",code:"3443",name:"創意"},    {id:"6669.TW",code:"6669",name:"緯穎"},
  {id:"3533.TW",code:"3533",name:"嘉澤"},    {id:"2049.TW",code:"2049",name:"上銀"},
  {id:"3008.TW",code:"3008",name:"大立光"},  {id:"3406.TW",code:"3406",name:"玉晶光"},
  {id:"2327.TW",code:"2327",name:"國巨"},    {id:"2409.TW",code:"2409",name:"友達"},
  {id:"3481.TW",code:"3481",name:"群創"},    {id:"2881.TW",code:"2881",name:"富邦金"},
  {id:"2882.TW",code:"2882",name:"國泰金"},  {id:"2891.TW",code:"2891",name:"中信金"},
  {id:"2886.TW",code:"2886",name:"兆豐金"},  {id:"2884.TW",code:"2884",name:"玉山金"},
  {id:"5880.TW",code:"5880",name:"合庫金"},  {id:"2885.TW",code:"2885",name:"元大金"},
  {id:"2303.TW",code:"2303",name:"聯電"},    {id:"0050.TW",code:"0050",name:"元大台灣50"}, 
  {id:"0056.TW",code:"0056",name:"元大高股息"}, {id:"00878.TW",code:"00878",name:"國泰永續高股息"},
  {id:"8069.TWO",code:"8069",name:"元太"},   {id:"8299.TWO",code:"8299",name:"群聯"},
  {id:"6488.TWO",code:"6488",name:"環球晶"}, {id:"5483.TWO",code:"5483",name:"中美晶"}
];

const PROXY_URL = 'https://corsproxy.io/?'; 
const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

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
  setTimeout(refreshMarkets, 1000);
  document.getElementById('start-scan').onclick = runScan;
  document.getElementById('weight-toggle').onclick = toggleWeights;
  const cb = document.querySelector('.close-modal');
  if (cb) cb.onclick = () => {
    document.getElementById('chart-modal').style.display='none';
    if(state.currentChart){state.currentChart.destroy(); state.currentChart=null;}
  };
});

async function safeFetch(url) {
  const res = await fetch(PROXY_URL + encodeURIComponent(url));
  if (!res.ok) throw new Error('Fetch Error');
  return await res.json();
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
      const change = price - (meta.chartPreviousClose || price);
      const pct = (change / (meta.chartPreviousClose || price)) * 100;
      const div = document.createElement('div');
      div.className = 'market-item';
      div.innerHTML = `<span>${item.n}</span> <span class="${change>=0?'price-up':'price-down'}">${price.toFixed(0)} (${pct.toFixed(2)}%)</span>`;
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
    let results = [];
    let completed = 0;
    const tickers = FULL_MARKET_LIST;
    const total = tickers.length;
    const startTime = Date.now();

    for (let i = 0; i < total; i++) {
      const s = tickers[i];
      try {
        const data = await safeFetch(`${YAHOO_URL}${s.id}?range=60d&interval=1d`);
        const quotes = data.chart.result[0].indicators.quote[0].close.filter(v => v != null);
        if (quotes.length >= 40) {
          const feat = calculateFeatures(s, quotes);
          if (feat) results.push({ ...feat, history: quotes });
        }
      } catch (e) {}
      
      completed++;
      const pct = (completed / total) * 100;
      fill.style.width = `${pct}%`;
      const elapsed = (Date.now() - startTime) / 1000;
      const rem = Math.round(((total - completed) * (elapsed / completed)));
      status.innerText = `正在分析: ${s.name} [${pct.toFixed(0)}%] (約剩 ${Math.floor(rem/60)}分${rem%60}秒)`;
      if (i % 8 === 0) await new Promise(r => setTimeout(r, 100));
    }

    state.results = scoreAndRank(results);
    renderResults();
    status.innerText = `完成！列出 Top 20 精選名單`;
  } catch (err) {
    status.innerText = '掃描異常，請重試';
  } finally {
    state.isScanning = false;
    btn.disabled = false;
  }
}

function calculateFeatures(s, c) {
  const n = c.length;
  const cur = c[n-1];
  const ma20 = avg(c.slice(-20)), ma60 = avg(c.slice(-60)), ma5 = avg(c.slice(-5));
  const rets = []; for(let i=1; i<n; i++) rets.push((c[i]-c[i-1])/c[i-1]);
  const vol = stdDev(rets.slice(-20)) * 15.8;
  const std20 = stdDev(c.slice(-20)), up = ma20 + 2 * std20;
  return { ...s, close: cur, ma5, features: [vol, ((up-(ma20-2*std20))/ma20)*100, (cur/ma60-1)*100, (ma5/ma60-1)*100, (cur/ma20-1)*100, (cur/up-1)*100, (cur/c[n-11]-1)*100] };
}

function scoreAndRank(recs) {
  const n = recs.length; if (n === 0) return [];
  const prs = recs.map(() => new Array(7).fill(0));
  for (let f = 0; f < 7; f++) {
    const sorted = recs.map((r, i) => ({ v: r.features[f], i })).sort((a,b) => a.v - b.v);
    sorted.forEach((it, ranking) => prs[it.i][f] = (ranking+1)/n);
  }
  recs.forEach((r, i) => {
    let sc = 0; for (let f = 0; f < 7; f++) sc += prs[i][f] * state.weights[f];
    r.aiScore = (sc / state.weights.reduce((a,b)=>a+b,0)) * 100;
  });
  return recs.filter(r => r.close >= r.ma5).sort((a,b) => b.aiScore - a.aiScore).slice(0, 20);
}

function renderResults() {
  const el = document.getElementById('results-list');
  el.innerHTML = state.results.map(r => `
    <div class="stock-card" onclick="showStockDetails('${r.id}')">
      <div class="stock-info"><span>${r.code}</span> <span>${r.name}</span></div>
      <div style="text-align:center"><div class="price-text">${r.close.toFixed(2)}</div></div>
      <div class="score-badge">${r.aiScore.toFixed(2)}</div>
    </div>
  `).join('');
}

window.showStockDetails = (id) => {
  const s = state.results.find(r => r.id === id) || state.watchlist.find(w => w.id === id);
  if (!s || !s.history) return;
  document.getElementById('chart-modal').style.display = 'block';
  document.getElementById('modal-title').innerText = `${s.name} (${s.code})`;
  const opts = {
    series: [{ name: 'Price', data: s.history.slice(-30) }],
    chart: { type: 'area', height: 200, toolbar: { show: false } },
    colors: ['#39d2c0'], theme: { mode: 'dark' },
    xaxis: { labels: { show: false } }
  };
  const el = document.getElementById('chart-container');
  el.innerHTML = '';
  new window.ApexCharts(el, opts).render();
};

function initWeights() {
  state.weights.forEach((w, i) => {
    const s = document.getElementById(`w${i+1}`), l = document.getElementById(`v-w${i+1}`);
    if(s && l){ s.value=w; l.innerText=w.toFixed(1); s.oninput=(e)=>{state.weights[i]=parseFloat(e.target.value); l.innerText=state.weights[i].toFixed(1);}; }
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
  document.getElementById(`${t}-section`).classList.add('active');
};

function updateWatchlistUI() {
  const l = document.getElementById('watchlist-list'), s = document.getElementById('watchlist-summary');
  if (!l || !s) return;
  if (state.watchlist.length === 0) { s.innerText = '尚無追蹤標的'; l.innerHTML = ''; return; }
  let tot = 0;
  l.innerHTML = state.watchlist.map(w => {
    const p = w.currentPrice - w.entryPrice, amt = p * w.shares * 1000; tot += amt;
    return `<div class="stock-card" onclick="showStockDetails('${w.id}')"><div class="stock-info"><span>${w.code}</span> <span>${w.name}</span></div><div style="text-align: right; color:${p>=0?'#ff4d4d':'#00ff00'}">${(p/w.entryPrice*100).toFixed(2)}%</div></div>`;
  }).join('');
  s.innerText = `預估總損益: ${tot.toLocaleString()} TWD`;
}
