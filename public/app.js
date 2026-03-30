/* ── TradeDesk Frontend ──────────────────────────────────────────────────── */

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  watchlist: JSON.parse(localStorage.getItem('watchlist') || '[]'),
  quotes: {},
  portfolio: null,
  currentSymbol: 'SPY',
  currentSide: 'buy',
  chart: null,
  charts: [],
  candleSeries: null,
  ws: null,
  news: [],
  seenNewsIds: new Set(JSON.parse(localStorage.getItem('seenNews') || '[]')),
  newsTab: 'all',
  currentSector: 'indices',
  demoMode: false,
  popupQueue: [],
  popupShowing: false,
  maEnabled: JSON.parse(localStorage.getItem('maEnabled') || '{"ema20":false,"sma50":false,"sma200":false}'),
  alerts: JSON.parse(localStorage.getItem('alerts') || '[]'),
  alertTriggered: new Set(),
};

const DEFAULT_WATCHLIST = [
  { symbol: 'SPY',  name: 'S&P 500 ETF' },
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.' },
  { symbol: 'MSFT', name: 'Microsoft Corp.' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.' },
  { symbol: 'META', name: 'Meta Platforms' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.' },
];

if (!state.watchlist.length) {
  state.watchlist = DEFAULT_WATCHLIST.map(s => s.symbol);
  saveWatchlist();
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Auth ──────────────────────────────────────────────────────────────────────
let authMode = 'login'; // 'login' | 'register'

function showAuth() {
  $('auth-overlay').classList.remove('hidden');
}
function hideAuth() {
  $('auth-overlay').classList.add('hidden');
}

function setupAuth() {
  // Tab switching
  $$('.auth-tab').forEach(tab => {
    tab.onclick = () => {
      authMode = tab.dataset.tab;
      $$('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === authMode));
      $('auth-submit').textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
      $('auth-confirm-wrap').classList.toggle('hidden', authMode === 'login');
      $('auth-msg').classList.add('hidden');
    };
  });

  // Submit
  $('auth-submit').onclick = submitAuth;
  [$('auth-username'), $('auth-password'), $('auth-confirm')].forEach(el => {
    if (el) el.onkeydown = (e) => { if (e.key === 'Enter') submitAuth(); };
  });
}

async function submitAuth() {
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  const confirm  = $('auth-confirm')?.value;
  const msgEl    = $('auth-msg');
  const btn      = $('auth-submit');

  if (!username || !password) return showAuthMsg('Fill in all fields', 'error');
  if (authMode === 'register' && password !== confirm) return showAuthMsg('Passwords do not match', 'error');

  btn.disabled = true;
  btn.textContent = '…';

  const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  }).then(r => r.json()).catch(() => ({ error: 'Network error' }));

  btn.disabled = false;
  btn.textContent = authMode === 'login' ? 'Sign In' : 'Create Account';

  if (res.error) {
    showAuthMsg(res.error, 'error');
  } else {
    $('header-username').textContent = res.username;
    hideAuth();
    init();
  }
}

function showAuthMsg(msg, type) {
  const el = $('auth-msg');
  el.textContent = msg;
  el.className = `auth-msg ${type}`;
  el.classList.remove('hidden');
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Check auth first
  const me = await fetch('/api/me').then(r => r.json()).catch(() => ({ user: null }));
  if (!me.user) { setupAuth(); showAuth(); return; }
  $('header-username').textContent = me.user.username;
  hideAuth();

  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({ hasFinnhubKey: false }));
  state.demoMode = !cfg.hasFinnhubKey;
  if (state.demoMode) $('demo-badge').classList.remove('hidden');

  setMarketStatus();
  renderMarketHours();
  setInterval(setMarketStatus, 60000);
  setInterval(renderMarketHours, 60000);

  renderWatchlist();
  setupWebSocket();

  // Load everything in parallel for faster startup
  await Promise.all([
    loadPortfolio(),
    refreshAllQuotes(),
    loadChart(state.currentSymbol),
    loadNews(),
  ]);
  // Re-render portfolio now that live quotes are available
  renderPortfolio();
  renderRecommended();

  setInterval(refreshAllQuotes, 15000);
  setInterval(() => renderRecommended(), 15000);
  setInterval(loadNews, 45000);

  fetchAndRenderFearGreed();
  setInterval(fetchAndRenderFearGreed, 5 * 60000);

  renderAlerts();
  setupEventListeners();
  initDragHandles();
  startTicker();
}

// ── Resizable Panels ──────────────────────────────────────────────────────────
function initDragHandles() {
  const main = $('main');

  function drag(handleId, cssVar, minW, maxW, invert = false) {
    const handle = $(handleId);
    let startX = 0, startW = 0;

    handle.addEventListener('pointerdown', e => {
      const cur = parseInt(getComputedStyle(main).getPropertyValue(cssVar)) ||
                  (cssVar === '--lw' ? 220 : 280);
      startX = e.clientX;
      startW = cur;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const dx = invert ? startX - e.clientX : e.clientX - startX;
      const newW = Math.max(minW, Math.min(maxW, startW + dx));
      main.style.setProperty(cssVar, newW + 'px');
    });

    handle.addEventListener('pointerup', e => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
    });
  }

  drag('drag-left',  '--lw', 160, 360);
  drag('drag-right', '--rw', 220, 440, true);
}

// ── Market Hours ──────────────────────────────────────────────────────────────
const EXCHANGES = [
  { name: 'NYSE / NASDAQ', tz: 'America/New_York',  open: [9,30],  close: [16,0],  pre: [4,0] },
  { name: 'LSE London',    tz: 'Europe/London',     open: [8,0],   close: [16,30], pre: [7,0] },
  { name: 'TSE Tokyo',     tz: 'Asia/Tokyo',        open: [9,0],   close: [15,30], pre: [8,0] },
  { name: 'SSE Shanghai',  tz: 'Asia/Shanghai',     open: [9,30],  close: [15,0],  pre: [9,0] },
];

function renderMarketHours() {
  const list = $('market-hours-list');
  if (!list) return;
  const now = new Date();

  list.innerHTML = EXCHANGES.map(ex => {
    const local = new Date(now.toLocaleString('en-US', { timeZone: ex.tz }));
    const h = local.getHours(), m = local.getMinutes(), day = local.getDay();
    const mins = h * 60 + m;
    const openMins  = ex.open[0]  * 60 + ex.open[1];
    const closeMins = ex.close[0] * 60 + ex.close[1];
    const preMins   = ex.pre[0]   * 60 + ex.pre[1];

    let statusCls, statusTxt;
    if (day === 0 || day === 6) {
      statusCls = 'closed'; statusTxt = 'CLOSED';
    } else if (mins >= openMins && mins < closeMins) {
      statusCls = 'open'; statusTxt = 'OPEN';
    } else if (mins >= preMins && mins < openMins) {
      statusCls = 'pre'; statusTxt = 'PRE';
    } else {
      statusCls = 'closed'; statusTxt = 'CLOSED';
    }

    const timeStr = local.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    return `<div class="mh-item">
      <span class="mh-name">${ex.name}</span>
      <span class="mh-time">${timeStr}</span>
      <span class="mh-status ${statusCls}">${statusTxt}</span>
    </div>`;
  }).join('');
}

// ── Market Status ─────────────────────────────────────────────────────────────
function setMarketStatus() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes(), day = et.getDay();
  const mins = h * 60 + m;
  const el = $('market-status');
  if (day === 0 || day === 6) {
    el.textContent = '● CLOSED'; el.className = 'market-badge closed';
  } else if (mins >= 570 && mins < 630) {
    el.textContent = '● PRE-MARKET'; el.className = 'market-badge pre-post';
  } else if (mins >= 630 && mins < 960) {
    el.textContent = '● MARKET OPEN'; el.className = 'market-badge';
  } else if (mins >= 960 && mins < 1020) {
    el.textContent = '● AFTER-HOURS'; el.className = 'market-badge pre-post';
  } else {
    el.textContent = '● CLOSED'; el.className = 'market-badge closed';
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function setupWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    state.watchlist.forEach(sym => ws.send(JSON.stringify({ type: 'subscribe', symbol: sym })));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'trade' && msg.data) {
        msg.data.forEach(trade => updateLivePrice(trade.s, trade.p));
      }
    } catch (_) {}
  };

  ws.onclose = () => setTimeout(setupWebSocket, 3000);
  ws.onerror = () => ws.close();
}

function subscribeWS(symbol) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'subscribe', symbol }));
  }
}

// ── Live Price Updates ────────────────────────────────────────────────────────
function updateLivePrice(symbol, price) {
  if (!state.quotes[symbol]) state.quotes[symbol] = {};
  const prev = state.quotes[symbol].c;
  state.quotes[symbol].c = price;

  // Update watchlist row
  const row = document.querySelector(`.watch-item[data-sym="${symbol}"]`);
  if (row) {
    const priceEl = row.querySelector('.wi-price');
    if (priceEl) {
      priceEl.textContent = formatPrice(price);
      const q = state.quotes[symbol];
      if (q.pc) {
        const chg = price - q.pc;
        const pct = (chg / q.pc) * 100;
        const chgEl = row.querySelector('.wi-chg');
        if (chgEl) {
          chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
          chgEl.className = `wi-chg ${chg >= 0 ? 'pos' : 'neg'}`;
        }
        row.className = `watch-item ${symbol === state.currentSymbol ? 'active' : ''} ${chg >= 0 ? 'up' : 'down'}`;
      }
    }
    if (prev !== undefined) {
      const flashClass = price > prev ? 'flash-green' : price < prev ? 'flash-red' : '';
      if (flashClass) {
        row.classList.add(flashClass);
        setTimeout(() => row.classList.remove(flashClass), 600);
      }
    }
  }

  // Update chart header if current symbol
  if (symbol === state.currentSymbol) {
    $('chart-price').textContent = formatPrice(price);
    const q = state.quotes[symbol];
    if (q?.pc) {
      const chg = price - q.pc;
      const pct = (chg / q.pc) * 100;
      const chgEl = $('chart-change');
      chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      chgEl.className = `chart-chg ${chg >= 0 ? 'pos' : 'neg'}`;
    }
  }

  // Check price alerts
  checkAlerts(symbol, price);

  // Update order estimate
  if ($('order-symbol').value.toUpperCase() === symbol) updateOrderEstimate();

  // Update positions P&L
  refreshPositionPrices();
}

// ── Quotes ────────────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const resp = await fetch(`/api/quote/${symbol}`).catch(() => null);
  if (!resp || !resp.ok) return null;
  const data = await resp.json().catch(() => null);
  if (data && data.c > 0) state.quotes[symbol] = data;
  return data;
}

async function refreshAllQuotes() {
  // Fetch quotes for watchlist AND any held positions
  const positionSymbols = Object.keys(state.portfolio?.positions || {});
  const allSymbols = [...new Set([...state.watchlist, ...positionSymbols])];
  await Promise.all(allSymbols.map(sym => fetchQuote(sym)));
  renderWatchlist();
  renderPortfolio();
  if (state.quotes[state.currentSymbol]) {
    const q = state.quotes[state.currentSymbol];
    $('chart-price').textContent = formatPrice(q.c);
    if (q.c && q.pc) {
      const chg = q.c - q.pc;
      const pct = (chg / q.pc) * 100;
      $('chart-change').textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      $('chart-change').className = `chart-chg ${chg >= 0 ? 'pos' : 'neg'}`;
    } else {
      $('chart-change').textContent = '';
    }
  }
}

// ── Chart ─────────────────────────────────────────────────────────────────────
// ── Indicator Math ────────────────────────────────────────────────────────────
function calcSMA(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    result[i] = sum / period;
  }
  return result;
}

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const ema = [];
  let sum = 0;
  for (let i = 0; i < Math.min(period, values.length); i++) sum += values[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // Signal EMA over macdLine values that exist
  const macdValues = macdLine.filter(v => v != null);
  const sigEMA = calcEMA(macdValues, signal);
  let sigIdx = 0;
  const signalLine = macdLine.map(v => v != null ? (sigEMA[sigIdx++] ?? null) : null);
  const histogram = macdLine.map((v, i) =>
    v != null && signalLine[i] != null ? v - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

// ── Chart ─────────────────────────────────────────────────────────────────────
// Format UTC timestamp → ET label for chart axis
function etTimeFormatter(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function etDateFormatter(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric'
  });
}

const CHART_OPTS = {
  layout: { background: { color: '#0d1117' }, textColor: '#7d8590' },
  grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.1, bottom: 0.1 } },
  leftPriceScale: { visible: false },
  timeScale: {
    borderColor: '#30363d',
    timeVisible: true,
    secondsVisible: false,
    fixLeftEdge: true,
    fixRightEdge: true,
    lockVisibleTimeRangeOnResize: true,
    tickMarkFormatter: (ts, tickType) => {
      const d = new Date(ts * 1000);
      const isIntraday = tickType <= 3;
      return isIntraday ? etTimeFormatter(ts) : etDateFormatter(ts);
    },
  },
  handleScroll: true,
  handleScale: true,
  localization: {
    timeFormatter: (ts) => {
      const d = new Date(ts * 1000);
      return d.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
      }) + ' ET';
    },
  },
};

function makeChart(containerId, height, extraOpts = {}) {
  const el = $(containerId);
  el.innerHTML = '';
  const w = el.offsetWidth || el.parentElement?.offsetWidth || 700;
  // Deep-merge timeScale so fixLeftEdge/fixRightEdge are never lost
  const merged = {
    ...CHART_OPTS,
    ...extraOpts,
    timeScale: { ...CHART_OPTS.timeScale, ...(extraOpts.timeScale || {}) },
  };
  const c = LightweightCharts.createChart(el, { ...merged, width: w, height });
  new ResizeObserver(() => c.resize(el.offsetWidth || w, height)).observe(el);
  return c;
}

function syncTimeScales(...charts) {
  let syncing = false;
  charts.forEach(src => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range) return;
      syncing = true;
      charts.forEach(dst => { if (dst !== src) dst.timeScale().setVisibleLogicalRange(range); });
      syncing = false;
    });
  });
}

async function loadChart(symbol, resolution = '5', days = 1) {
  state.currentSymbol = symbol;
  $('chart-symbol').textContent = symbol;
  $$('.watch-item').forEach(el => el.classList.toggle('active', el.dataset.sym === symbol));

  // Destroy previous charts
  if (state.charts) { state.charts.forEach(c => c.remove()); }
  state.charts = [];

  const data = await fetch(`/api/candles/${symbol}?resolution=${resolution}&days=${days}`)
    .then(r => r.json()).catch(() => null);

  if (!data || data.s === 'no_data' || !data.t?.length) return;

  // Filter out nulls and align all arrays
  const valid = data.t.map((ts, i) => ({
    ts, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v[i]
  })).filter(d => d.c != null && d.c > 0);

  if (!valid.length) return;

  const timestamps = valid.map(d => d.ts);
  const closes    = valid.map(d => d.c);

  // ── Main candlestick chart ──────────────────────────────────────────────
  const mainChart = makeChart('chart-main', 220);
  state.charts.push(mainChart);

  const candleSeries = mainChart.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor: '#3fb950', wickDownColor: '#f85149',
  });
  candleSeries.setData(valid.map(d => ({ time: d.ts, open: d.o, high: d.h, low: d.l, close: d.c })));

  // Volume histogram overlaid on main chart with separate scale
  const volSeries = mainChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
  });
  mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  volSeries.setData(valid.map(d => ({
    time: d.ts,
    value: d.v,
    color: d.c >= d.o ? 'rgba(63,185,80,0.4)' : 'rgba(248,81,73,0.4)',
  })));

  // ── Moving Average overlays ─────────────────────────────────────────────
  const MA_CONFIG = {
    ema20:  { color: '#e3b341', period: 20, type: 'ema' },
    sma50:  { color: '#58a6ff', period: 50, type: 'sma' },
    sma200: { color: '#f78166', period: 200, type: 'sma' },
  };
  Object.entries(MA_CONFIG).forEach(([key, cfg]) => {
    if (!state.maEnabled[key]) return;
    const vals = cfg.type === 'ema' ? calcEMA(closes, cfg.period) : calcSMA(closes, cfg.period);
    const maSeries = mainChart.addLineSeries({
      color: cfg.color, lineWidth: 1, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false,
    });
    maSeries.setData(vals.map((v, i) => v != null ? { time: timestamps[i], value: v } : null).filter(Boolean));
  });

  mainChart.timeScale().fitContent();
  state.chart = mainChart;
  state.candleSeries = candleSeries;

  // ── RSI chart ───────────────────────────────────────────────────────────
  const rsiChart = makeChart('chart-rsi', 80, {
    timeScale: { borderColor: '#30363d', timeVisible: false },
    rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.1, bottom: 0.1 } },
  });
  state.charts.push(rsiChart);

  const rsiValues = calcRSI(closes);
  const rsiSeries = rsiChart.addLineSeries({ color: '#e3b341', lineWidth: 1, priceLineVisible: false });
  rsiSeries.setData(rsiValues.map((v, i) => v != null ? { time: timestamps[i], value: v } : null).filter(Boolean));

  // Overbought / oversold lines
  const ob = rsiChart.addLineSeries({ color: 'rgba(248,81,73,0.4)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false });
  const os = rsiChart.addLineSeries({ color: 'rgba(63,185,80,0.4)',  lineWidth: 1, lineStyle: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false });
  const tFirst = timestamps[0], tLast = timestamps[timestamps.length - 1];
  ob.setData([{ time: tFirst, value: 70 }, { time: tLast, value: 70 }]);
  os.setData([{ time: tFirst, value: 30 }, { time: tLast, value: 30 }]);
  rsiChart.timeScale().fitContent();

  // Live RSI readout
  const lastRSI = [...rsiValues].reverse().find(v => v != null);
  if (lastRSI != null) {
    const el = $('rsi-value');
    el.textContent = lastRSI.toFixed(1);
    el.style.color = lastRSI > 70 ? '#f85149' : lastRSI < 30 ? '#3fb950' : '#e3b341';
  }

  // ── MACD chart ──────────────────────────────────────────────────────────
  const macdChart = makeChart('chart-macd', 80, {
    timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: '#30363d', scaleMargins: { top: 0.1, bottom: 0.1 } },
  });
  state.charts.push(macdChart);

  const { macdLine, signalLine, histogram } = calcMACD(closes);

  const macdSeries   = macdChart.addLineSeries({ color: '#58a6ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const sigSeries    = macdChart.addLineSeries({ color: '#e3b341', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  const histSeries   = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });

  macdSeries.setData(macdLine.map((v, i) => v != null ? { time: timestamps[i], value: v } : null).filter(Boolean));
  sigSeries.setData(signalLine.map((v, i) => v != null ? { time: timestamps[i], value: v } : null).filter(Boolean));
  histSeries.setData(histogram.map((v, i) => v != null ? { time: timestamps[i], value: v, color: v >= 0 ? 'rgba(63,185,80,0.6)' : 'rgba(248,81,73,0.6)' } : null).filter(Boolean));
  macdChart.timeScale().fitContent();

  // Live MACD readout
  const lastMACD = [...macdLine].reverse().find(v => v != null);
  const lastSig  = [...signalLine].reverse().find(v => v != null);
  if (lastMACD != null) { $('macd-value').textContent = lastMACD.toFixed(3); $('macd-value').style.color = lastMACD >= 0 ? '#3fb950' : '#f85149'; }
  if (lastSig  != null) { $('signal-value').textContent = lastSig.toFixed(3); }

  // ── Sync all three time scales ──────────────────────────────────────────
  syncTimeScales(mainChart, rsiChart, macdChart);

  // ── Update header ───────────────────────────────────────────────────────
  const q = state.quotes[symbol];
  if (q) {
    $('chart-price').textContent = formatPrice(q.c);
    if (q.c > 0 && q.pc > 0) {
      const chg = q.c - q.pc;
      const pct = (chg / q.pc) * 100;
      $('chart-change').textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      $('chart-change').className = `chart-chg ${chg >= 0 ? 'pos' : 'neg'}`;
    } else {
      $('chart-change').textContent = '';
    }
  }

  $('order-symbol').value = symbol;
  updateOrderEstimate();
}

// ── AI Sentiment Scorer ───────────────────────────────────────────────────────
const BULLISH_KW = ['surge','rally','beat','record','growth','profit','upgrade','strong','gain','rise','soar','jump','exceed','outperform','bullish','positive','revenue','recovery','expansion','optimis','boost','momentum','breakthrough','partnership','dividend','buyback','top','upbeat','robust','accelerat','all-time high','raises guidance','raises forecast'];
const BEARISH_KW = ['crash','fall','drop','miss','loss','decline','downgrade','weak','cut','recession','layoff','risk','concern','warn','bearish','negative','default','investigation','lawsuit','fraud','recall','shortage','inflation','rate hike','slowdown','plunge','tumble','selloff','below expect','disappoints','lowers guidance','profit warning','bankruptcy','debt','crisis','tension','sanction','tariff','fears'];

function scoreSentiment(text) {
  const t = (text || '').toLowerCase();
  let score = 0;
  BULLISH_KW.forEach(kw => { if (t.includes(kw)) score++; });
  BEARISH_KW.forEach(kw => { if (t.includes(kw)) score--; });
  if (score >= 2)  return { label: 'BULLISH',  cls: 'sent-bull', score };
  if (score <= -2) return { label: 'BEARISH',  cls: 'sent-bear', score };
  if (score === 1) return { label: 'LEANING↑', cls: 'sent-lean-bull', score };
  if (score === -1)return { label: 'LEANING↓', cls: 'sent-lean-bear', score };
  return { label: 'NEUTRAL', cls: 'sent-neutral', score };
}

// ── News ──────────────────────────────────────────────────────────────────────
async function loadNews(tab = state.newsTab) {
  state.newsTab = tab;

  if (tab === 'calendar') {
    renderCalendar();
    return;
  }

  const url = tab === 'symbol'
    ? `/api/news/${state.currentSymbol}`
    : `/api/news/market?tab=${tab}`;

  const data = await fetch(url).then(r => r.json()).catch(() => []);
  if (!Array.isArray(data)) return;

  state.news = data;

  // Check for new (unseen) news items and queue popups
  data.forEach(item => {
    const id = item.id || `${item.datetime}-${item.headline?.slice(0, 20)}`;
    if (!state.seenNewsIds.has(id) && item.datetime > (Date.now() / 1000 - 3600)) {
      state.seenNewsIds.add(id);
      state.popupQueue.push(item);
    }
  });
  saveSeenNews();

  if (!state.popupShowing && state.popupQueue.length) showNextPopup();

  renderNews();
  updateTicker(data);
}

function renderNews() {
  const feed = $('news-feed');
  if (!state.news.length) {
    feed.innerHTML = '<div class="empty-state">No news available</div>';
    return;
  }
  feed.innerHTML = state.news.map(item => {
    const id = item.id || `${item.datetime}-${item.headline?.slice(0,20)}`;
    const isNew = !state.seenNewsIds.has(id);
    const relSym = item.related || item.symbol || '';
    const timeAgo = formatTimeAgo(item.datetime * 1000);
    const href = item.url && item.url !== '#' ? escHtml(item.url) : null;
    const sent = scoreSentiment((item.headline || '') + ' ' + (item.summary || ''));
    return `
      <a class="news-card ${isNew ? 'unread' : ''}" ${href ? `href="${href}"` : ''} target="_blank" rel="noopener noreferrer">
        <div class="nc-header">
          <span class="nc-source">${escHtml(item.source || '')}</span>
          <span class="nc-time">${timeAgo}</span>
          ${relSym ? `<span class="nc-sym">${escHtml(relSym)}</span>` : ''}
          <span class="sentiment-badge ${sent.cls}">${sent.label}</span>
        </div>
        <div class="nc-headline">${escHtml(item.headline || '')}</div>
        <div class="nc-summary">${escHtml(item.summary || '')}</div>
      </a>
    `;
  }).join('');
}

async function renderCalendar() {
  const feed = $('news-feed');
  feed.innerHTML = '<div class="empty-state">Loading calendar…</div>';
  const data = await fetch('/api/calendar').then(r => r.json()).catch(() => ({ macro: [], earnings: [] }));
  const all = [
    ...data.macro.map(e => ({ ...e, sortDate: e.date })),
    ...data.earnings.map(e => ({ ...e, sortDate: e.date })),
  ].sort((a, b) => a.sortDate.localeCompare(b.sortDate));

  if (!all.length) { feed.innerHTML = '<div class="empty-state">No upcoming events</div>'; return; }

  let lastDate = '';
  feed.innerHTML = all.map(ev => {
    const dateLabel = ev.date !== lastDate ? (() => { lastDate = ev.date; return `<div class="cal-date-header">${formatCalDate(ev.date)}</div>`; })() : '';
    return `${dateLabel}<div class="cal-event">
      <div class="cal-date">${ev.symbol ? `<span class="nc-sym">${ev.symbol}</span>` : ''}</div>
      <div class="cal-body">
        <div class="cal-title">${escHtml(ev.title)}<span class="cal-type ${ev.type}">${ev.type}</span></div>
        ${ev.desc ? `<div class="cal-desc">${escHtml(ev.desc)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function formatCalDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Ticker (JS-driven, never resets) ─────────────────────────────────────────
let tickerRAF = null;
let tickerPos = 0;
let tickerPaused = false;
let tickerSpeed = 0.4; // px per frame

function updateTicker(news) {
  const content = $('ticker-content');
  const items = news.slice(0, 10).map(n =>
    `<a class="ticker-item" href="${n.url && n.url !== '#' ? escHtml(n.url) : '#'}" target="_blank" rel="noopener">${escHtml(n.headline || '')}</a><span class="ticker-sep">•</span>`
  ).join('');
  // Only rebuild content if news actually changed (avoids reset)
  const newHtml = items || 'Loading market news…';
  if (content.dataset.lastHtml === newHtml) return;
  content.dataset.lastHtml = newHtml;
  // Double the content so it loops seamlessly
  content.innerHTML = newHtml + newHtml;
  // Don't reset position — let it keep scrolling from where it is
}

function startTicker() {
  const content = $('ticker-content');
  const track = content.parentElement;

  content.addEventListener('mouseenter', () => { tickerPaused = true; });
  content.addEventListener('mouseleave', () => { tickerPaused = false; });

  function tick() {
    if (!tickerPaused) {
      tickerPos -= tickerSpeed;
      const halfWidth = content.scrollWidth / 2;
      if (Math.abs(tickerPos) >= halfWidth) tickerPos = 0;
      content.style.transform = `translateX(${tickerPos}px)`;
    }
    tickerRAF = requestAnimationFrame(tick);
  }
  tickerRAF = requestAnimationFrame(tick);
}

// ── News Popup ─────────────────────────────────────────────────────────────────
function showNextPopup() {
  if (!state.popupQueue.length) { state.popupShowing = false; return; }
  state.popupShowing = true;
  const item = state.popupQueue.shift();

  const sym = item.related || item.symbol || state.currentSymbol;
  $('popup-source').textContent = (item.source || '').toUpperCase();
  $('popup-headline').textContent = item.headline || '';
  $('popup-summary').textContent = (item.summary || '').slice(0, 160) + '…';
  $('popup-symbol').textContent = sym;

  $('popup-buy').onclick = () => {
    $('order-symbol').value = sym;
    activateSide('buy');
    $('news-popup').classList.add('hidden');
    state.popupShowing = false;
    showNextPopup();
  };
  $('popup-sell').onclick = () => {
    $('order-symbol').value = sym;
    activateSide('sell');
    $('news-popup').classList.add('hidden');
    state.popupShowing = false;
    showNextPopup();
  };

  $('news-popup').classList.remove('hidden');

  // Auto-dismiss after 12s
  setTimeout(() => {
    $('news-popup').classList.add('hidden');
    state.popupShowing = false;
    if (state.popupQueue.length) setTimeout(showNextPopup, 2000);
  }, 12000);
}

// ── Portfolio ─────────────────────────────────────────────────────────────────
async function loadPortfolio() {
  const data = await fetch('/api/portfolio').then(r => r.json()).catch(() => null);
  if (data) { state.portfolio = data; renderPortfolio(); }
}

function renderPortfolio() {
  const p = state.portfolio;
  if (!p) return;

  let positionsValue = 0;
  Object.entries(p.positions || {}).forEach(([sym, pos]) => {
    const price = state.quotes[sym]?.c || pos.avgCost;
    positionsValue += pos.qty * price;
  });
  const totalValue = p.cash + positionsValue;
  const pnl = totalValue - p.startingBalance;
  const pnlPct = (pnl / p.startingBalance) * 100;

  $('header-balance').textContent = formatDollar(totalValue);
  const pnlEl = $('header-pnl');
  const pnlPctSafe = isFinite(pnlPct) ? pnlPct.toFixed(2) : '0.00';
  pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${formatDollar(pnl)} (${pnl >= 0 ? '+' : ''}${pnlPctSafe}%)`;
  pnlEl.className = `acct-pnl ${pnl >= 0 ? 'pos' : 'neg'}`;

  $('order-avail-cash').textContent = formatDollar(p.cash);

  // Positions
  const posList = $('positions-list');
  const positions = Object.entries(p.positions || {});
  $('positions-count').textContent = positions.length;

  if (!positions.length) {
    posList.innerHTML = '<div class="empty-state">No open positions</div>';
  } else {
    posList.innerHTML = positions.map(([sym, pos]) => {
      const price = state.quotes[sym]?.c || pos.avgCost;
      const pnlPos = (price - pos.avgCost) * pos.qty;
      const pnlPosStr = `${pnlPos >= 0 ? '+' : ''}$${Math.abs(pnlPos).toFixed(2)}`;
      return `
        <div class="pos-item" onclick="selectSymbol('${sym}')">
          <span class="pos-sym">${sym}</span>
          <span class="pos-qty">${pos.qty} @ ${formatPrice(pos.avgCost)}</span>
          <span class="pos-pnl ${pnlPos >= 0 ? 'pos' : 'neg'}">${pnlPosStr}</span>
        </div>
      `;
    }).join('');
  }

  renderPortfolioStats();
  syncSizerBalance();

  // Order history
  const histList = $('history-list');
  const orders = p.orders || [];
  $('history-count').textContent = orders.length;

  if (!orders.length) {
    histList.innerHTML = '<div class="empty-state">No orders yet</div>';
  } else {
    histList.innerHTML = orders.slice(0, 20).map(o => `
      <div class="hist-item">
        <div class="hist-left">
          <span class="hist-sym">${o.symbol}<span>${o.qty} shares @ ${formatPrice(o.price)}</span></span>
          <span class="hist-time">${formatTimeAgo(new Date(o.timestamp).getTime())}</span>
        </div>
        <div class="hist-right">
          <span class="hist-total">${formatDollar(o.total)}</span>
          <span class="hist-side ${o.side}">${o.side.toUpperCase()}</span>
        </div>
      </div>
    `).join('');
  }
}

// Debounced portfolio re-render for live price updates — avoids thrashing DOM on rapid WS ticks
let _posRenderTimer = null;
function refreshPositionPrices() {
  if (!state.portfolio) return;
  if (_posRenderTimer) return; // already scheduled
  _posRenderTimer = setTimeout(() => {
    _posRenderTimer = null;
    renderPortfolio();
  }, 250);
}

// ── Portfolio Stats ───────────────────────────────────────────────────────────
function renderPortfolioStats() {
  const el = $('stats-content');
  if (!el) return;
  const orders = state.portfolio?.orders || [];
  const sells = orders.filter(o => o.side === 'sell' && o.realizedPnl != null);
  const wins = sells.filter(o => o.realizedPnl > 0);
  const losses = sells.filter(o => o.realizedPnl < 0);

  const winRate = sells.length ? (wins.length / sells.length * 100).toFixed(0) + '%' : '—';
  const totalPnl = sells.reduce((s, o) => s + o.realizedPnl, 0);
  const grossWin  = wins.reduce((s, o) => s + o.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + o.realizedPnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '—');
  const bestTrade  = sells.length ? Math.max(...sells.map(o => o.realizedPnl)) : null;
  const worstTrade = sells.length ? Math.min(...sells.map(o => o.realizedPnl)) : null;

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-cell">
        <div class="stat-label">Win Rate</div>
        <div class="stat-val ${sells.length ? (parseFloat(winRate) >= 50 ? 'pos' : 'neg') : ''}">${winRate}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Total Trades</div>
        <div class="stat-val">${orders.length}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Realized P&L</div>
        <div class="stat-val ${sells.length ? (totalPnl >= 0 ? 'pos' : 'neg') : ''}">
          ${sells.length ? (totalPnl >= 0 ? '+' : '') + '$' + Math.abs(totalPnl).toFixed(0) : '—'}
        </div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Profit Factor</div>
        <div class="stat-val ${pf !== '—' ? (pf === '∞' || parseFloat(pf) >= 1 ? 'pos' : 'neg') : ''}">${pf}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Best Trade</div>
        <div class="stat-val pos">${bestTrade != null ? '+$' + bestTrade.toFixed(0) : '—'}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">Worst Trade</div>
        <div class="stat-val neg">${worstTrade != null ? (worstTrade >= 0 ? '+' : '-') + '$' + Math.abs(worstTrade).toFixed(0) : '—'}</div>
      </div>
    </div>
  `;
}

// ── Position Sizer ────────────────────────────────────────────────────────────
function syncSizerBalance() {
  const el = $('sizer-balance');
  if (el && state.portfolio) el.value = Math.round(state.portfolio.cash);
  updatePositionSizer();
}

function updatePositionSizer() {
  const entry = parseFloat($('sizer-entry')?.value) || 0;
  const stop  = parseFloat($('sizer-stop')?.value) || 0;
  const risk  = parseFloat($('sizer-risk')?.value) || 1;
  const balance = parseFloat($('sizer-balance')?.value) || state.portfolio?.cash || 0;
  const out = $('sizer-output');
  if (!out) return;

  if (!entry || !stop || stop >= entry || balance <= 0) {
    out.innerHTML = `
      <div class="sizer-out-cell"><div class="sizer-out-label">SHARES</div><div class="sizer-out-val">—</div></div>
      <div class="sizer-out-cell"><div class="sizer-out-label">$ RISK</div><div class="sizer-out-val">—</div></div>
      <div class="sizer-out-cell"><div class="sizer-out-label">POS SIZE</div><div class="sizer-out-val">—</div></div>
    `;
    return;
  }

  const dollarRisk   = balance * (risk / 100);
  const riskPerShare = entry - stop;
  const shares       = Math.floor(dollarRisk / riskPerShare);
  const posSize      = shares * entry;
  const posSizeStr   = posSize >= 1000 ? '$' + (posSize / 1000).toFixed(1) + 'k' : '$' + posSize.toFixed(0);

  out.innerHTML = `
    <div class="sizer-out-cell"><div class="sizer-out-label">SHARES</div><div class="sizer-out-val">${shares}</div></div>
    <div class="sizer-out-cell"><div class="sizer-out-label">$ RISK</div><div class="sizer-out-val">$${dollarRisk.toFixed(0)}</div></div>
    <div class="sizer-out-cell"><div class="sizer-out-label">POS SIZE</div><div class="sizer-out-val">${posSizeStr}</div></div>
  `;
}

// ── Fear & Greed ──────────────────────────────────────────────────────────────
async function fetchAndRenderFearGreed() {
  const el = $('fg-content');
  if (!el) return;

  const data = await fetch('/api/fear-greed').then(r => r.json()).catch(() => null);
  if (!data) { el.innerHTML = '<div class="empty-state" style="font-size:11px;">Unavailable</div>'; return; }

  const { score, vix, vixScore, momentumScore, rsiScore } = data;

  let color, label;
  if (score <= 25)      { color = '#f85149'; label = 'EXTREME FEAR'; }
  else if (score <= 45) { color = '#e3b341'; label = 'FEAR'; }
  else if (score <= 55) { color = '#7d8590'; label = 'NEUTRAL'; }
  else if (score <= 75) { color = '#3fb950'; label = 'GREED'; }
  else                  { color = '#58a6ff'; label = 'EXTREME GREED'; }

  // Arc endpoint helper: maps 0-100 score to x,y on semicircle
  function pt(s) {
    const r = (s / 100) * Math.PI;
    return `${(60 - 48 * Math.cos(r)).toFixed(1)},${(52 - 48 * Math.sin(r)).toFixed(1)}`;
  }

  // Needle endpoint
  const nr = (score / 100) * Math.PI;
  const nx = (60 - 42 * Math.cos(nr)).toFixed(1);
  const ny = (52 - 42 * Math.sin(nr)).toFixed(1);

  const gauge = `<svg width="120" height="70" viewBox="0 0 120 70" style="overflow:visible">
    <path d="M 12,52 A 48,48 0 0,1 ${pt(25)}" fill="none" stroke="#f85149" stroke-width="7" opacity="0.4" stroke-linecap="butt"/>
    <path d="M ${pt(25)} A 48,48 0 0,1 ${pt(45)}" fill="none" stroke="#e3b341" stroke-width="7" opacity="0.4" stroke-linecap="butt"/>
    <path d="M ${pt(45)} A 48,48 0 0,1 ${pt(55)}" fill="none" stroke="#7d8590" stroke-width="7" opacity="0.4" stroke-linecap="butt"/>
    <path d="M ${pt(55)} A 48,48 0 0,1 ${pt(75)}" fill="none" stroke="#3fb950" stroke-width="7" opacity="0.4" stroke-linecap="butt"/>
    <path d="M ${pt(75)} A 48,48 0 0,1 108,52"   fill="none" stroke="#58a6ff" stroke-width="7" opacity="0.4" stroke-linecap="butt"/>
    <line x1="60" y1="52" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="60" cy="52" r="3.5" fill="${color}"/>
    <text x="4"  y="67" font-size="8" fill="#7d8590" font-family="monospace">FEAR</text>
    <text x="82" y="67" font-size="8" fill="#7d8590" font-family="monospace">GREED</text>
  </svg>`;

  el.innerHTML = `
    <div class="fg-gauge">
      ${gauge}
      <div class="fg-score" style="color:${color}">${score}</div>
      <div class="fg-label" style="color:${color}">${label}</div>
    </div>
    <div class="fg-components">
      <div class="fg-comp"><span>VIX (${vix})</span><span class="fg-comp-val">${vixScore}</span></div>
      <div class="fg-comp"><span>SPY Momentum</span><span class="fg-comp-val">${momentumScore}</span></div>
      <div class="fg-comp"><span>SPY RSI-14</span><span class="fg-comp-val">${rsiScore}</span></div>
    </div>
  `;
}

// ── Watchlist ─────────────────────────────────────────────────────────────────
function renderWatchlist() {
  const container = $('watchlist');
  if (!state.watchlist.length) {
    container.innerHTML = '<div class="empty-state">Add symbols to watch</div>';
    return;
  }
  container.innerHTML = state.watchlist.map(sym => {
    const q = state.quotes[sym] || {};
    const price = q.c > 0 ? q.c : 0;
    const pc = q.pc > 0 ? q.pc : price;
    const chg = price - pc;
    const pct = pc > 0 ? (chg / pc) * 100 : 0;
    const dir = chg >= 0 ? 'up' : 'down';
    const name = DEFAULT_WATCHLIST.find(d => d.symbol === sym)?.name || sym;
    return `
      <div class="watch-item ${dir} ${sym === state.currentSymbol ? 'active' : ''}" data-sym="${sym}" onclick="selectSymbol('${sym}')">
        <div class="wi-left">
          <span class="wi-sym">${sym}</span>
          <span class="wi-name">${escHtml(name)}</span>
        </div>
        <div class="wi-right">
          <span class="wi-price">${price ? formatPrice(price) : '—'}</span>
          <span class="wi-chg ${chg >= 0 ? 'pos' : 'neg'}">${price ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` : '—'}</span>
        </div>
        <button class="wi-remove" onclick="removeFromWatchlist(event,'${sym}')" title="Remove">✕</button>
      </div>
    `;
  }).join('');
}

// ── Recommended Section ───────────────────────────────────────────────────────
const SECTORS = {
  indices: [
    { symbol: 'SPY',  name: 'S&P 500' },
    { symbol: 'QQQ',  name: 'NASDAQ 100' },
    { symbol: 'DIA',  name: 'Dow Jones' },
    { symbol: 'IWM',  name: 'Russell 2000' },
    { symbol: 'VIX',  name: 'Volatility' },
  ],
  tech: [
    { symbol: 'AAPL', name: 'Apple' },
    { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'GOOGL', name: 'Alphabet' },
    { symbol: 'META', name: 'Meta' },
    { symbol: 'AMD',  name: 'AMD' },
    { symbol: 'TSLA', name: 'Tesla' },
  ],
  energy: [
    { symbol: 'XOM',  name: 'ExxonMobil' },
    { symbol: 'CVX',  name: 'Chevron' },
    { symbol: 'COP',  name: 'ConocoPhillips' },
    { symbol: 'XLE',  name: 'Energy ETF' },
    { symbol: 'USO',  name: 'Oil ETF' },
    { symbol: 'SLB',  name: 'Schlumberger' },
  ],
  finance: [
    { symbol: 'JPM',  name: 'JPMorgan' },
    { symbol: 'BAC',  name: 'Bank of America' },
    { symbol: 'GS',   name: 'Goldman Sachs' },
    { symbol: 'MS',   name: 'Morgan Stanley' },
    { symbol: 'BRK.B',name: 'Berkshire' },
    { symbol: 'XLF',  name: 'Finance ETF' },
  ],
};

async function renderRecommended(sector = state.currentSector) {
  state.currentSector = sector;
  $$('.rec-tab').forEach(t => t.classList.toggle('active', t.dataset.sector === sector));

  const stocks = SECTORS[sector] || [];
  // Fetch quotes for any we don't have yet
  const missing = stocks.filter(s => !state.quotes[s.symbol]);
  if (missing.length) await Promise.all(missing.map(s => fetchQuote(s.symbol)));

  const list = $('recommended-list');
  list.innerHTML = stocks.map(({ symbol, name }) => {
    const q = state.quotes[symbol] || {};
    const price = q.c > 0 ? q.c : 0;
    const chg = price - (q.pc > 0 ? q.pc : price);
    const pct = q.pc > 0 ? (chg / q.pc) * 100 : 0;
    const inWatchlist = state.watchlist.includes(symbol);
    return `
      <div class="rec-item" onclick="selectSymbol('${symbol}')">
        <div class="wi-left">
          <span class="wi-sym">${symbol}</span>
          <span class="wi-name">${escHtml(name)}</span>
        </div>
        <div class="wi-right">
          <span class="wi-price ${chg >= 0 ? 'pos' : 'neg'}">${price ? formatPrice(price) : '—'}</span>
          <span class="wi-chg ${chg >= 0 ? 'pos' : 'neg'}">${price ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}</span>
        </div>
        <button class="rec-add ${inWatchlist ? 'added' : ''}"
          onclick="event.stopPropagation(); toggleWatchlist('${symbol}', '${escHtml(name)}')"
          title="${inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}">
          ${inWatchlist ? '✓' : '+'}
        </button>
      </div>
    `;
  }).join('');
}

async function toggleWatchlist(symbol, name) {
  if (state.watchlist.includes(symbol)) {
    state.watchlist = state.watchlist.filter(s => s !== symbol);
    saveWatchlist();
    renderWatchlist();
  } else {
    await addToWatchlist(symbol);
  }
  renderRecommended();
}

function saveWatchlist() {
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
}

// ── Price Alerts ──────────────────────────────────────────────────────────────
function saveAlerts() { localStorage.setItem('alerts', JSON.stringify(state.alerts)); }

function addAlert(symbol, direction, targetPrice) {
  const sym = symbol.toUpperCase().trim();
  if (!sym || !targetPrice || targetPrice <= 0) return;
  state.alerts.push({ id: Date.now(), symbol: sym, direction, targetPrice: parseFloat(targetPrice) });
  saveAlerts();
  renderAlerts();
}

function removeAlert(id) {
  state.alerts = state.alerts.filter(a => a.id !== id);
  state.alertTriggered.delete(id);
  saveAlerts();
  renderAlerts();
}

function renderAlerts() {
  const list = $('alerts-list');
  if (!state.alerts.length) {
    list.innerHTML = '<div class="empty-state" style="font-size:11px;">No alerts set</div>';
    return;
  }
  list.innerHTML = state.alerts.map(a => `
    <div class="alert-item ${state.alertTriggered.has(a.id) ? 'triggered' : ''}">
      <span class="alert-sym">${a.symbol}</span>
      <span class="alert-dir ${a.direction}">${a.direction === 'above' ? '↑' : '↓'}</span>
      <span class="alert-tgt">${formatPrice(a.targetPrice)}</span>
      <button class="alert-del" onclick="removeAlert(${a.id})" title="Remove">✕</button>
    </div>
  `).join('');
}

function checkAlerts(symbol, price) {
  state.alerts.forEach(a => {
    if (a.symbol !== symbol || state.alertTriggered.has(a.id)) return;
    const hit = (a.direction === 'above' && price >= a.targetPrice) ||
                (a.direction === 'below' && price <= a.targetPrice);
    if (!hit) return;
    state.alertTriggered.add(a.id);
    renderAlerts();
    // Re-use the news popup for alert notification
    const popup = $('news-popup');
    $('popup-source').textContent = '🔔 PRICE ALERT';
    $('popup-headline').textContent = `${symbol} hit ${formatPrice(a.targetPrice)}`;
    $('popup-summary').textContent = `Current price: ${formatPrice(price)} — Alert triggered ${a.direction} ${formatPrice(a.targetPrice)}`;
    $('popup-symbol').textContent = symbol;
    $('popup-buy').onclick = () => { $('order-symbol').value = symbol; activateSide('buy'); popup.classList.add('hidden'); };
    $('popup-sell').onclick = () => { $('order-symbol').value = symbol; activateSide('sell'); popup.classList.add('hidden'); };
    popup.classList.remove('hidden');
    popup.style.borderLeftColor = a.direction === 'above' ? 'var(--green)' : 'var(--red)';
    setTimeout(() => { popup.classList.add('hidden'); popup.style.borderLeftColor = ''; }, 10000);
  });
}

function removeFromWatchlist(e, symbol) {
  e.stopPropagation();
  state.watchlist = state.watchlist.filter(s => s !== symbol);
  saveWatchlist();
  renderWatchlist();
}

async function addToWatchlist(symbol) {
  const sym = symbol.toUpperCase().trim();
  if (!sym || state.watchlist.includes(sym)) return;
  state.watchlist.push(sym);
  saveWatchlist();
  subscribeWS(sym);
  await fetchQuote(sym);
  renderWatchlist();
  selectSymbol(sym);
}

async function selectSymbol(symbol) {
  state.currentSymbol = symbol;
  $('order-symbol').value = symbol;
  const active = document.querySelector('.tf-btn.active');
  const res = active?.dataset.resolution || '5';
  const days = active?.dataset.days || 1;
  await loadChart(symbol, res, days);
  if (state.newsTab === 'symbol') await loadNews('symbol');
  updateOrderEstimate();

  // Auto-fill position sizer entry
  const sizerEntry = $('sizer-entry');
  if (sizerEntry) {
    const price = state.quotes[symbol]?.c;
    if (price) { sizerEntry.value = price.toFixed(2); updatePositionSizer(); }
  }
}

// ── Order Entry ───────────────────────────────────────────────────────────────
function activateSide(side) {
  state.currentSide = side;
  $$('.order-tab').forEach(t => t.classList.toggle('active', t.dataset.side === side));
  const btn = $('submit-order');
  btn.textContent = side.toUpperCase();
  btn.className = side === 'buy' ? 'btn-buy-full' : 'btn-sell-full';
  btn.id = 'submit-order';
}

async function updateOrderEstimate() {
  const sym = $('order-symbol').value.toUpperCase();
  const qty = parseFloat($('order-qty').value) || 0;
  const orderType = $('order-type').value;
  const limitPrice = parseFloat($('order-limit-price').value) || 0;

  let price = state.quotes[sym]?.c;
  if (!price && sym) {
    const q = await fetchQuote(sym);
    price = q?.c;
  }

  const estPrice = orderType === 'limit' ? limitPrice : (price || 0);
  const est = estPrice * qty;
  $('order-est-total').textContent = est ? formatDollar(est) : '—';
  $('order-avail-cash').textContent = state.portfolio ? formatDollar(state.portfolio.cash) : '—';
}

async function submitOrder() {
  const symbol = $('order-symbol').value.toUpperCase().trim();
  const qty = parseFloat($('order-qty').value);
  const orderType = $('order-type').value;
  const limitPrice = parseFloat($('order-limit-price').value);
  const side = state.currentSide;

  if (!symbol || !qty || qty <= 0) {
    showOrderMsg('Enter symbol and quantity', 'error');
    return;
  }

  const btn = $('submit-order');
  btn.disabled = true;
  btn.textContent = 'Placing…';

  const body = { symbol, side, qty, orderType };
  if (orderType === 'limit') body.limitPrice = limitPrice;

  const res = await fetch('/api/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json()).catch(() => ({ error: 'Network error' }));

  btn.disabled = false;
  activateSide(side);

  if (res.error) {
    showOrderMsg(res.error, 'error');
  } else {
    const o = res.order;
    const priceStr = o.type === 'market' ? 'market' : formatPrice(o.limit_price || o.price);
    showOrderMsg(`✓ ${side.toUpperCase()} ${o.qty || qty} ${o.symbol || symbol} @ ${priceStr}`, 'success');
    if (res.portfolio) { state.portfolio = res.portfolio; renderPortfolio(); }
    $('order-qty').value = '';
    updateOrderEstimate();
  }
}

function showOrderMsg(msg, type) {
  const el = $('order-msg');
  el.textContent = msg;
  el.className = `order-msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Search ─────────────────────────────────────────────────────────────────────
let searchTimeout = null;
async function handleSearch(query) {
  if (!query.trim()) { $('search-results').classList.add('hidden'); return; }
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const data = await fetch(`/api/search/${encodeURIComponent(query)}`).then(r => r.json()).catch(() => ({ result: [] }));
    const results = (data.result || []).slice(0, 8);
    const drop = $('search-results');
    if (!results.length) { drop.classList.add('hidden'); return; }
    drop.innerHTML = results.map(r => `
      <div class="search-item" onclick="pickSearch('${r.symbol}','${escHtml(r.description || '')}')">
        <span class="sym">${escHtml(r.symbol)}</span>
        <span class="name">${escHtml((r.description || '').slice(0, 40))}</span>
      </div>
    `).join('');
    drop.classList.remove('hidden');
  }, 350);
}

async function pickSearch(symbol, name) {
  $('search-input').value = '';
  $('search-results').classList.add('hidden');
  if (!state.watchlist.includes(symbol)) await addToWatchlist(symbol);
  else await selectSymbol(symbol);
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Watchlist add
  $('add-symbol-btn').onclick = () => {
    $('modal-overlay').classList.remove('hidden');
    $('modal-input').focus();
  };
  $('modal-close').onclick = () => $('modal-overlay').classList.add('hidden');
  $('modal-add').onclick = async () => {
    const sym = $('modal-input').value.toUpperCase().trim();
    if (sym) { await addToWatchlist(sym); $('modal-input').value = ''; $('modal-overlay').classList.add('hidden'); }
  };
  $('modal-input').onkeydown = (e) => { if (e.key === 'Enter') $('modal-add').click(); };
  $('modal-overlay').onclick = (e) => { if (e.target === $('modal-overlay')) $('modal-overlay').classList.add('hidden'); };

  // Order tabs
  $$('.order-tab').forEach(tab => {
    tab.onclick = () => activateSide(tab.dataset.side);
  });

  // Order type
  $('order-type').onchange = () => {
    $('limit-price-wrap').classList.toggle('hidden', $('order-type').value !== 'limit');
    updateOrderEstimate();
  };

  // Order fields
  $('order-qty').oninput = updateOrderEstimate;
  $('order-limit-price').oninput = updateOrderEstimate;
  $('order-symbol').oninput = updateOrderEstimate;
  $('order-symbol').onkeydown = (e) => { if (e.key === 'Enter') submitOrder(); };

  // Submit
  $('submit-order').onclick = submitOrder;

  // Chart timeframes
  $$('.tf-btn').forEach(btn => {
    btn.onclick = () => {
      $$('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadChart(state.currentSymbol, btn.dataset.resolution, btn.dataset.days);
    };
  });

  // News tabs
  $$('.news-tab').forEach(tab => {
    tab.onclick = () => {
      $$('.news-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadNews(tab.dataset.tab);
    };
  });

  // Recommended sector tabs
  $$('.rec-tab').forEach(tab => {
    tab.onclick = () => renderRecommended(tab.dataset.sector);
  });

  // MA toggles
  $$('.ma-btn').forEach(btn => {
    const key = btn.dataset.ma;
    btn.classList.toggle('active', !!state.maEnabled[key]);
    btn.onclick = () => {
      state.maEnabled[key] = !state.maEnabled[key];
      btn.classList.toggle('active', state.maEnabled[key]);
      localStorage.setItem('maEnabled', JSON.stringify(state.maEnabled));
      // Reload chart to apply/remove MA
      const active = document.querySelector('.tf-btn.active');
      loadChart(state.currentSymbol, active?.dataset.resolution || '5', active?.dataset.days || 1);
    };
  });

  // Price alerts
  $('add-alert-btn').onclick = () => {
    $('alert-symbol').value = state.currentSymbol;
    const q = state.quotes[state.currentSymbol];
    if (q) $('alert-price').value = q.c.toFixed(2);
    $('alert-overlay').classList.remove('hidden');
    $('alert-price').focus();
  };
  $('alert-modal-close').onclick = () => $('alert-overlay').classList.add('hidden');
  $('alert-add-btn').onclick = () => {
    addAlert($('alert-symbol').value, $('alert-direction').value, $('alert-price').value);
    $('alert-overlay').classList.add('hidden');
  };
  $('alert-overlay').onclick = e => { if (e.target === $('alert-overlay')) $('alert-overlay').classList.add('hidden'); };

  // Popup
  $('popup-close').onclick = $('popup-dismiss').onclick = () => {
    $('news-popup').classList.add('hidden');
    state.popupShowing = false;
    if (state.popupQueue.length) setTimeout(showNextPopup, 1500);
  };

  // Logout
  $('logout-btn').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  };

  // Share profile link
  $('share-btn').onclick = () => {
    const username = $('header-username').textContent.trim();
    if (!username) return;
    const url = `${location.origin}/user/${encodeURIComponent(username)}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = $('share-btn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = '⎘ Share'; }, 2000);
    });
  };

  // Mobile tab bar
  document.querySelectorAll('.mob-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const panel = tab.dataset.panel;
      // Update active tab
      document.querySelectorAll('.mob-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // Show the selected panel, hide others
      const panels = { center: 'center-panel', right: 'right-panel', watchlist: 'watchlist-panel' };
      Object.entries(panels).forEach(([key, id]) => {
        document.getElementById(id).classList.toggle('mob-hidden', key !== panel);
      });
      // Resize chart if switching to it
      if (panel === 'center') {
        setTimeout(() => { if (state.chart) state.chart.timeScale().fitContent(); }, 50);
      }
    });
  });

  // Reset
  $('reset-btn').onclick = () => $('reset-overlay').classList.remove('hidden');
  $('reset-cancel').onclick = () => $('reset-overlay').classList.add('hidden');
  $('reset-confirm').onclick = async () => {
    await fetch('/api/portfolio/reset', { method: 'POST' });
    await loadPortfolio();
    $('reset-overlay').classList.add('hidden');
  };

  // Position sizer
  ['sizer-entry', 'sizer-stop', 'sizer-risk'].forEach(id => {
    const el = $(id);
    if (el) el.oninput = updatePositionSizer;
  });

  // Fear & Greed refresh
  const fgRefresh = $('fg-refresh');
  if (fgRefresh) fgRefresh.onclick = fetchAndRenderFearGreed;

  // Search
  $('search-input').oninput = (e) => handleSearch(e.target.value);
  $('search-input').onkeydown = (e) => {
    if (e.key === 'Escape') $('search-results').classList.add('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) $('search-results').classList.add('hidden');
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function formatPrice(p) {
  if (!p && p !== 0) return '—';
  return '$' + Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDollar(n) {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-$' : '$') + str;
}

function formatTimeAgo(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function saveSeenNews() {
  const arr = Array.from(state.seenNewsIds).slice(-200);
  localStorage.setItem('seenNews', JSON.stringify(arr));
}

// expose for inline handlers
window.selectSymbol = selectSymbol;
window.removeFromWatchlist = removeFromWatchlist;
window.toggleWatchlist = toggleWatchlist;
window.removeAlert = removeAlert;

// ── Go ────────────────────────────────────────────────────────────────────────
init();
