// --- 穩定版連線引擎 (採用更強大的 CORS Proxy) ---
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

// --- 精選台股清單 (作為分析基底，數據維持即時抓取) ---
const CORE_LIST = [
    {id:"2330.TW",code:"2330",name:"台積電"}, {id:"2317.TW",code:"2317",name:"鴻海"},
    {id:"2454.TW",code:"2454",name:"聯發科"}, {id:"2308.TW",code:"2308",name:"台達電"},
    {id:"2382.TW",code:"2382",name:"廣達"},    {id:"3231.TW",code:"3231",name:"緯創"},
    {id:"2357.TW",code:"2357",name:"華碩"},    {id:"2376.TW",code:"2376",name:"技嘉"},
    {id:"2603.TW",code:"2603",name:"長榮"},    {id:"2609.TW",code:"2609",name:"陽明"},
    {id:"1513.TW",code:"1513",name:"中興電"},  {id:"1519.TW",code:"1519",name:"華城"},
    {id:"2618.TW",code:"2618",name:"長榮航"},  {id:"2610.TW",code:"2610",name:"華航"},
    {id:"2353.TW",code:"2353",name:"宏碁"},    {id:"2324.TW",code:"2324",name:"仁寶"},
    {id:"3037.TW",code:"3037",name:"欣興"},    {id:"3017.TW",code:"3017",name:"奇鋐"},
    {id:"3324.TW",code:"3324",name:"雙鴻"},    {id:"3533.TW",code:"3533",name:"嘉澤"}
    // ... 後續可再擴展
];

document.addEventListener('DOMContentLoaded', () => {
    initWeights();
    updateWatchlistUI();
    setTimeout(refreshMarkets, 1000);
    document.getElementById('start-scan').onclick = runScan;
    document.getElementById('weight-toggle').onclick = toggleWeights;
});

async function safeFetch(url) {
    const res = await fetch(PROXY_URL + encodeURIComponent(url));
    if (!res.ok) throw new Error('連線失敗');
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
        const tickers = CORE_LIST;
        const total = tickers.length;
        const startTime = Date.now();

        for (let i = 0; i < total; i++) {
            const s = tickers[i];
            try {
                // 即時從 Yahoo 抓取資料
                const data = await safeFetch(`${YAHOO_URL}${s.id}?range=60d&interval=1d`);
                const quotes = data.chart.result[0].indicators.quote[0].close.filter(v => v != null);
                if (quotes.length >= 40) {
                    const feat = calculateFeatures(s, quotes);
                    results.push({ ...feat, history: quotes });
                }
            } catch (e) {
                console.error(`Skip ${s.code}`);
            }
            
            completed++;
            const pct = (completed / total) * 100;
            fill.style.width = `${pct}%`;
            status.innerText = `正在分析: ${s.name} (${completed}/${total})`;
            
            // 避免頻繁請求被擋
            if (i % 5 === 0) await new Promise(r => setTimeout(r, 100));
        }

        state.results = scoreAndRank(results);
        renderResults();
        status.innerText = `完成！成功掃描並回報 Top 20`;
    } catch (err) {
        status.innerText = '連線異常，請重試';
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
    const vol = stdDev(rets.slice(-20)) * 15.8; // 年化
    return { ...s, close: cur, ma5, features: [vol, 1.5, (cur/ma60-1)*100, (ma5/ma60-1)*100, (cur/ma20-1)*100, 1.0, (cur/c[n-11]-1)*100] };
}

function scoreAndRank(recs) {
    const n = recs.length; if (n === 0) return [];
    recs.forEach(r => {
        let sc = 0; r.features.forEach((f, i) => sc += f * state.weights[i]);
        r.aiScore = sc / 7;
    });
    return recs.filter(r => r.close >= r.ma5).sort((a,b) => b.aiScore - a.aiScore).slice(0, 20);
}

function renderResults() {
    const el = document.getElementById('results-list');
    el.innerHTML = state.results.map(r => `
        <div class="stock-card" onclick="showStockDetails('${r.id}')">
            <div class="stock-info"><span>${r.code}</span> <span>${r.name}</span></div>
            <div class="price-text">${r.close.toFixed(2)}</div>
            <div class="score-badge">${r.aiScore.toFixed(1)}</div>
        </div>
    `).join('');
}

window.showStockDetails = (id) => {
    const s = state.results.find(r => r.id === id);
    if (!s) return;
    document.getElementById('chart-modal').style.display = 'block';
    const opts = {
        series: [{ name: 'Price', data: s.history.slice(-30) }],
        chart: { type: 'area', height: 200, toolbar: { show: false } },
        colors: ['#39d2c0'], theme: { mode: 'dark' }
    };
    const el = document.getElementById('chart-container');
    el.innerHTML = '';
    new window.ApexCharts(el, opts).render();
};

function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function stdDev(a) { const m = avg(a); return Math.sqrt(a.reduce((x,y)=>x+Math.pow(y-m,2),0)/a.length); }
