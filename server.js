require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

app.set('trust proxy', 1); // needed behind Nginx/Cloudflare
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
// Sessions persisted in SQLite — survives server restarts
const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'tradedesk-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 9e5 } }),
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Data Storage (SQLite) ─────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tradedesk.db'));
db.pragma('journal_mode = WAL');   // better concurrent performance
db.pragma('foreign_keys = ON');

// Migration: add resets column if missing
try { db.exec('ALTER TABLE portfolios ADD COLUMN resets INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portfolios (
    user_id          TEXT PRIMARY KEY REFERENCES users(id),
    cash             REAL NOT NULL DEFAULT 100000,
    starting_balance REAL NOT NULL DEFAULT 100000,
    positions        TEXT NOT NULL DEFAULT '{}',
    orders           TEXT NOT NULL DEFAULT '[]',
    resets           INTEGER NOT NULL DEFAULT 0
  );
`);

// ── DB Helpers ────────────────────────────────────────────────────────────────
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser(id, username, passwordHash) {
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(id, username, passwordHash, new Date().toISOString());
  // Create a fresh portfolio row for this user
  db.prepare('INSERT INTO portfolios (user_id) VALUES (?)').run(id);
}

function defaultPortfolio() {
  return { cash: 100000, positions: {}, orders: [], startingBalance: 100000, resets: 0 };
}

function loadUserPortfolio(userId) {
  const row = db.prepare('SELECT * FROM portfolios WHERE user_id = ?').get(userId);
  if (!row) return defaultPortfolio();
  return {
    cash:            row.cash,
    startingBalance: row.starting_balance,
    positions:       JSON.parse(row.positions),
    orders:          JSON.parse(row.orders),
    resets:          row.resets || 0,
  };
}

function saveUserPortfolio(userId, portfolio) {
  db.prepare(`
    INSERT INTO portfolios (user_id, cash, starting_balance, positions, orders, resets)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      cash             = excluded.cash,
      starting_balance = excluded.starting_balance,
      positions        = excluded.positions,
      orders           = excluded.orders,
      resets           = excluded.resets
  `).run(
    userId,
    portfolio.cash,
    portfolio.startingBalance ?? 100000,
    JSON.stringify(portfolio.positions),
    JSON.stringify(portfolio.orders),
    portfolio.resets ?? 0,
  );
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 attempts per IP per window
  message: { error: 'Too many attempts, please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,            // 300 requests/min per IP — app fetches many quotes on load
  message: { error: 'Too many requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// ── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  if (getUserByUsername(username)) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  createUser(id, username, passwordHash);

  req.session.userId = id;
  req.session.username = username;
  res.json({ success: true, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = getUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── Inject config to frontend ───────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ hasFinnhubKey: !!FINNHUB_KEY });
});

// ── Market Data Routes ──────────────────────────────────────────────────────
app.get('/api/quote/:symbol', async (req, res) => {
  if (!FINNHUB_KEY) return res.json(mockQuote(req.params.symbol));
  try {
    const r = await axios.get('https://finnhub.io/api/v1/quote', {
      params: { symbol: req.params.symbol.toUpperCase(), token: FINNHUB_KEY }
    });
    const q = r.data;
    // Finnhub returns all zeros for unsupported symbols — treat as unavailable
    if (!q || (q.c === 0 && q.pc === 0 && q.h === 0 && q.l === 0)) {
      return res.status(404).json({ error: 'No data available for this symbol' });
    }
    res.json(q);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch quote' }); }
});

app.get('/api/candles/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const { resolution = '60', days = 5 } = req.query;

  // Map our resolution/days to Yahoo Finance interval/range
  const d = parseInt(days);
  let interval, range;
  if (d <= 1)  { interval = '5m';  range = '1d'; }
  else if (d <= 5)  { interval = '60m'; range = '5d'; }
  else if (d <= 30) { interval = '1d';  range = '1mo'; }
  else              { interval = '1d';  range = '3mo'; }

  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${sym}`,
      { params: { interval, range }, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const result = r.data?.chart?.result?.[0];
    if (!result) return res.json(mockCandles(sym, d));

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    res.json({
      s: 'ok',
      t: timestamps,
      o: q.open  || [],
      h: q.high  || [],
      l: q.low   || [],
      c: q.close || [],
      v: q.volume|| [],
    });
  } catch (e) {
    res.json(mockCandles(sym, d));
  }
});

// Keywords for filtering general news into subcategories
const NEWS_FILTERS = {
  geopolitical: ['war','sanction','tariff','trade war','nato','military','geopolit','conflict','diplomacy','ukraine','russia','china','taiwan','middle east','israel','iran','north korea','opec','g7','g20','un '],
  energy:       ['oil','crude','natural gas','opec','energy','pipeline','refin','petroleum','brent','wti','lng','offshore','rig','exxon','chevron','shell','bp ','conoco','renewabl','solar','wind power','battery'],
};

async function fetchFinnhubCategory(category) {
  const r = await axios.get('https://finnhub.io/api/v1/news', {
    params: { category, token: FINNHUB_KEY }
  });
  return r.data || [];
}

app.get('/api/news/market', async (req, res) => {
  const { tab = 'market' } = req.query;
  if (!FINNHUB_KEY) return res.json(mockNews());
  try {
    let articles = [];

    if (tab === 'all') {
      const [general, forex, crypto, merger] = await Promise.all([
        fetchFinnhubCategory('general'),
        fetchFinnhubCategory('forex'),
        fetchFinnhubCategory('crypto'),
        fetchFinnhubCategory('merger'),
      ]);
      articles = [...general, ...forex, ...crypto, ...merger]
        .sort((a, b) => b.datetime - a.datetime);

    } else if (tab === 'forex') {
      articles = await fetchFinnhubCategory('forex');

    } else if (tab === 'crypto') {
      articles = await fetchFinnhubCategory('crypto');

    } else if (tab === 'merger') {
      articles = await fetchFinnhubCategory('merger');

    } else if (tab === 'geopolitical' || tab === 'energy') {
      const general = await fetchFinnhubCategory('general');
      const keywords = NEWS_FILTERS[tab];
      articles = general.filter(a => {
        const text = ((a.headline || '') + ' ' + (a.summary || '')).toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });

    } else {
      // 'market' default
      articles = await fetchFinnhubCategory('general');
    }

    res.json(articles.slice(0, 30));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch news' }); }
});

app.get('/api/news/:symbol', async (req, res) => {
  if (!FINNHUB_KEY) return res.json(mockNews(req.params.symbol));
  try {
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 7 * 864e5).toISOString().split('T')[0];
    const r = await axios.get('https://finnhub.io/api/v1/company-news', {
      params: { symbol: req.params.symbol.toUpperCase(), from, to, token: FINNHUB_KEY }
    });
    res.json((r.data || []).slice(0, 15));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch news' }); }
});

app.get('/api/search/:query', async (req, res) => {
  if (!FINNHUB_KEY) return res.json({ result: [] });
  try {
    const r = await axios.get('https://finnhub.io/api/v1/search', {
      params: { q: req.params.query, token: FINNHUB_KEY }
    });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

// ── Economic Calendar ────────────────────────────────────────────────────────
const MACRO_EVENTS = [
  { type:'FOMC', date:'2026-03-19', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision + press conference' },
  { type:'FOMC', date:'2026-05-07', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision' },
  { type:'FOMC', date:'2026-06-18', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision + press conference' },
  { type:'FOMC', date:'2026-07-30', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision' },
  { type:'FOMC', date:'2026-09-17', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision + press conference' },
  { type:'FOMC', date:'2026-10-29', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision' },
  { type:'FOMC', date:'2026-12-10', title:'FOMC Rate Decision',    desc:'Federal Reserve interest rate decision + press conference' },
  { type:'CPI',  date:'2026-04-10', title:'CPI Inflation Report',  desc:'Consumer Price Index — March 2026' },
  { type:'CPI',  date:'2026-05-13', title:'CPI Inflation Report',  desc:'Consumer Price Index — April 2026' },
  { type:'CPI',  date:'2026-06-11', title:'CPI Inflation Report',  desc:'Consumer Price Index — May 2026' },
  { type:'CPI',  date:'2026-07-14', title:'CPI Inflation Report',  desc:'Consumer Price Index — June 2026' },
  { type:'GDP',  date:'2026-04-29', title:'GDP Q1 2026 (Advance)', desc:'First estimate of Q1 2026 GDP growth' },
  { type:'GDP',  date:'2026-07-29', title:'GDP Q2 2026 (Advance)', desc:'First estimate of Q2 2026 GDP growth' },
  { type:'JOBS', date:'2026-04-03', title:'Non-Farm Payrolls',     desc:'March 2026 jobs report + unemployment rate' },
  { type:'JOBS', date:'2026-05-01', title:'Non-Farm Payrolls',     desc:'April 2026 jobs report + unemployment rate' },
  { type:'JOBS', date:'2026-06-05', title:'Non-Farm Payrolls',     desc:'May 2026 jobs report + unemployment rate' },
  { type:'JOBS', date:'2026-07-02', title:'Non-Farm Payrolls',     desc:'June 2026 jobs report + unemployment rate' },
];

app.get('/api/calendar', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().split('T')[0];
  const macro = MACRO_EVENTS.filter(e => e.date >= today).slice(0, 20);

  if (!FINNHUB_KEY) return res.json({ macro, earnings: [] });

  try {
    const r = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
      params: { from: today, to: in30, token: FINNHUB_KEY }
    });
    const earnings = (r.data?.earningsCalendar || [])
      .filter(e => e.symbol && e.date)
      .slice(0, 60)
      .map(e => ({
        type: 'EARNINGS',
        date: e.date,
        symbol: e.symbol,
        title: `${e.symbol} Earnings`,
        desc: [
          e.hour === 'BMO' ? '📅 Before Open' : e.hour === 'AMC' ? '📅 After Close' : '',
          e.epsEstimate != null ? `EPS Est: $${e.epsEstimate}` : '',
        ].filter(Boolean).join('  ·  '),
        hour: e.hour,
      }));
    res.json({ macro, earnings });
  } catch (e) {
    res.json({ macro, earnings: [] });
  }
});

// ── Paper Trading Routes ────────────────────────────────────────────────────
app.get('/api/portfolio', requireAuth, (req, res) => {
  res.json(loadUserPortfolio(req.session.userId));
});

app.post('/api/trade', requireAuth, async (req, res) => {
  const { symbol, side, qty, orderType, limitPrice } = req.body;
  if (!symbol || !side || !qty || qty <= 0) {
    return res.status(400).json({ error: 'Invalid order parameters' });
  }
  const portfolio = loadUserPortfolio(req.session.userId);

  let execPrice;
  try {
    if (FINNHUB_KEY) {
      const r = await axios.get('https://finnhub.io/api/v1/quote', {
        params: { symbol: symbol.toUpperCase(), token: FINNHUB_KEY },
        timeout: 8000
      });
      const q = r.data;
      const marketPrice = (q.c > 0 ? q.c : null) || (q.pc > 0 ? q.pc : null);
      if (orderType === 'limit') {
        execPrice = parseFloat(limitPrice);
      } else if (marketPrice) {
        execPrice = marketPrice;
      }
    } else {
      execPrice = orderType === 'limit' ? parseFloat(limitPrice) : mockQuote(symbol).c;
    }
  } catch (_) {
    return res.status(500).json({ error: 'Could not get current price — try again in a moment' });
  }

  if (!execPrice || execPrice <= 0) return res.status(400).json({ error: 'Price unavailable for this symbol' });

  const shares = parseFloat(qty);
  const totalCost = execPrice * shares;
  const sym = symbol.toUpperCase();
  let realizedPnl = null;

  if (side === 'buy') {
    if (portfolio.cash < totalCost) return res.status(400).json({ error: `Insufficient funds. Need $${totalCost.toFixed(2)}, have $${portfolio.cash.toFixed(2)}` });
    portfolio.cash -= totalCost;
    if (!portfolio.positions[sym]) portfolio.positions[sym] = { qty: 0, avgCost: 0 };
    const pos = portfolio.positions[sym];
    const newQty = pos.qty + shares;
    pos.avgCost = ((pos.qty * pos.avgCost) + totalCost) / newQty;
    pos.qty = newQty;
  } else if (side === 'sell') {
    const pos = portfolio.positions[sym];
    if (!pos || pos.qty < shares) return res.status(400).json({ error: `Insufficient shares. Have ${pos?.qty ?? 0}, need ${shares}` });
    realizedPnl = +((execPrice - pos.avgCost) * shares).toFixed(2);
    portfolio.cash += totalCost;
    pos.qty -= shares;
    if (pos.qty <= 0) delete portfolio.positions[sym];
  }

  const order = {
    id: Date.now(), symbol: sym, side, qty: shares, price: execPrice,
    total: totalCost, type: orderType || 'market',
    timestamp: new Date().toISOString(), status: 'filled',
    ...(realizedPnl !== null ? { realizedPnl } : {})
  };
  portfolio.orders.unshift(order);
  portfolio.orders = portfolio.orders.slice(0, 100);
  saveUserPortfolio(req.session.userId, portfolio);
  res.json({ success: true, order, portfolio });
});

app.post('/api/portfolio/reset', requireAuth, (req, res) => {
  const current = loadUserPortfolio(req.session.userId);
  const portfolio = defaultPortfolio();
  portfolio.resets = (current.resets || 0) + 1;
  saveUserPortfolio(req.session.userId, portfolio);
  res.json({ success: true, portfolio });
});

// ── Profile page route ───────────────────────────────────────────────────────
app.get('/user/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// ── Public Profile ────────────────────────────────────────────────────────────
app.get('/api/profile/:username', async (req, res) => {
  const row = db.prepare(`
    SELECT u.username, u.created_at, p.cash, p.starting_balance, p.positions, p.orders
    FROM users u
    JOIN portfolios p ON p.user_id = u.id
    WHERE u.username = ? COLLATE NOCASE
  `).get(req.params.username);

  if (!row) return res.status(404).json({ error: 'User not found' });

  const positions  = JSON.parse(row.positions);
  const orders     = JSON.parse(row.orders);

  // Fetch live prices for positions
  const symbols = Object.keys(positions);
  const prices = {};
  await Promise.all(symbols.map(async sym => {
    prices[sym] = await getCachedQuote(sym);
  }));

  const posValue   = Object.entries(positions).reduce((sum, [sym, p]) => {
    const livePrice = prices[sym] || p.avgCost;
    return sum + p.qty * livePrice;
  }, 0);
  const totalValue = row.cash + posValue;
  const start      = row.starting_balance || 100000;
  const returnPct  = +((totalValue - start) / start * 100).toFixed(2);
  const sells      = orders.filter(o => o.side === 'sell' && o.realizedPnl != null);
  const wins       = sells.filter(o => o.realizedPnl > 0);
  const realizedPnl = +sells.reduce((s, o) => s + o.realizedPnl, 0).toFixed(2);

  res.json({
    username:    row.username,
    memberSince: row.created_at,
    totalValue:  +totalValue.toFixed(2),
    cash:        +row.cash.toFixed(2),
    returnPct,
    totalReturn: +(totalValue - start).toFixed(2),
    realizedPnl,
    totalTrades: orders.length,
    winRate:     sells.length ? +(wins.length / sells.length * 100).toFixed(0) : null,
    positions:   Object.entries(positions).map(([sym, p]) => ({
      symbol: sym, qty: p.qty, avgCost: +p.avgCost.toFixed(2),
      marketValue: +((prices[sym] || p.avgCost) * p.qty).toFixed(2),
    })),
    recentTrades: orders.slice(0, 20),
  });
});

// ── Leaderboard ──────────────────────────────────────────────────────────────
// Cache live quotes briefly so the leaderboard doesn't hammer Finnhub
const quoteCache = {};
const QUOTE_CACHE_MS = 30000;

async function getCachedQuote(symbol) {
  const cached = quoteCache[symbol];
  if (cached && Date.now() - cached.time < QUOTE_CACHE_MS) return cached.price;
  try {
    if (!FINNHUB_KEY) return null;
    const r = await axios.get('https://finnhub.io/api/v1/quote', {
      params: { symbol, token: FINNHUB_KEY }, timeout: 5000
    });
    const price = r.data.c > 0 ? r.data.c : null;
    if (price) quoteCache[symbol] = { price, time: Date.now() };
    return price;
  } catch (_) { return null; }
}

app.get('/api/leaderboard', async (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, p.cash, p.starting_balance, p.positions, p.orders, p.resets
    FROM users u
    JOIN portfolios p ON p.user_id = u.id
  `).all();

  // Collect all unique symbols across all portfolios
  const allSymbols = new Set();
  const parsed = rows.map(row => {
    const positions = JSON.parse(row.positions);
    Object.keys(positions).forEach(sym => allSymbols.add(sym));
    return { ...row, positions, orders: JSON.parse(row.orders) };
  });

  // Fetch live prices for all symbols in parallel
  const prices = {};
  await Promise.all([...allSymbols].map(async sym => {
    prices[sym] = await getCachedQuote(sym);
  }));

  const entries = parsed.map(row => {
    const { positions, orders } = row;
    const posValue = Object.entries(positions).reduce((sum, [sym, pos]) => {
      const livePrice = prices[sym] || pos.avgCost;
      return sum + pos.qty * livePrice;
    }, 0);
    const totalValue = row.cash + posValue;
    const start      = row.starting_balance || 100000;
    const totalReturn = totalValue - start;
    const returnPct   = +(totalReturn / start * 100).toFixed(2);
    const sells = orders.filter(o => o.side === 'sell' && o.realizedPnl != null);
    const wins  = sells.filter(o => o.realizedPnl > 0);
    return {
      username:    row.username,
      totalValue:  +totalValue.toFixed(2),
      totalReturn: +totalReturn.toFixed(2),
      returnPct,
      totalTrades: orders.length,
      winRate: sells.length ? +(wins.length / sells.length * 100).toFixed(0) : null,
      resets: row.resets || 0,
    };
  }).sort((a, b) => b.returnPct - a.returnPct);

  res.json(entries);
});

// ── Fear & Greed Index ───────────────────────────────────────────────────────
app.get('/api/fear-greed', async (req, res) => {
  try {
    const [vixResp, spyResp] = await Promise.all([
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX', {
        params: { interval: '1d', range: '5d' },
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }).catch(() => null),
      axios.get('https://query1.finance.yahoo.com/v8/finance/chart/SPY', {
        params: { interval: '1d', range: '1mo' },
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }).catch(() => null)
    ]);

    // VIX score — inverse: higher VIX = more fear
    const vixMeta = vixResp?.data?.chart?.result?.[0]?.meta;
    const vixPrice = vixMeta?.regularMarketPrice ?? 20;
    const vixScore = Math.max(0, Math.min(100, Math.round(110 - vixPrice * 3)));

    // SPY momentum vs 30-day SMA
    const spyResult = spyResp?.data?.chart?.result?.[0];
    const spyCloses = (spyResult?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
    const spyCurrent = spyResult?.meta?.regularMarketPrice ?? (spyCloses[spyCloses.length - 1] ?? 500);

    let momentumScore = 50;
    if (spyCloses.length >= 5) {
      const sma = spyCloses.reduce((a, b) => a + b, 0) / spyCloses.length;
      const pctFromSma = (spyCurrent - sma) / sma * 100;
      momentumScore = Math.max(0, Math.min(100, Math.round(50 + pctFromSma * 10)));
    }

    // SPY RSI-14
    let rsiScore = 50;
    if (spyCloses.length >= 16) {
      const period = 14;
      const n = spyCloses.length;
      let gains = 0, losses = 0;
      for (let i = n - period; i < n; i++) {
        const d = spyCloses[i] - spyCloses[i - 1];
        if (d > 0) gains += d; else losses -= d;
      }
      const ag = gains / period, al = losses / period;
      rsiScore = Math.round(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
    }

    const score = Math.max(0, Math.min(100, Math.round(vixScore * 0.4 + momentumScore * 0.3 + rsiScore * 0.3)));
    res.json({ score, vix: +vixPrice.toFixed(1), vixScore, momentumScore, rsiScore });
  } catch (e) {
    res.json({ score: 45, vix: 21.5, vixScore: 44, momentumScore: 48, rsiScore: 43 });
  }
});

// ── WebSocket Proxy for Finnhub Live Prices ─────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();
const subscribedSymbols = new Set();
let finnhubWs = null;

// Mock price broadcaster for when no API key is set
let mockInterval = null;
function startMockPrices() {
  if (mockInterval) return;
  const basePrices = {
    AAPL: 182, TSLA: 248, NVDA: 875, MSFT: 415, AMZN: 190,
    META: 510, GOOGL: 175, SPY: 510, QQQ: 435, AMD: 165
  };
  mockInterval = setInterval(() => {
    subscribedSymbols.forEach(sym => {
      const base = basePrices[sym] || 100;
      const price = +(base + (Math.random() - 0.5) * base * 0.003).toFixed(2);
      basePrices[sym] = price;
      const msg = JSON.stringify({ type: 'trade', data: [{ s: sym, p: price, t: Date.now(), v: Math.floor(Math.random() * 500) + 100 }] });
      clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    });
  }, 1500);
}

function connectFinnhub() {
  if (!FINNHUB_KEY) { startMockPrices(); return; }
  finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  finnhubWs.on('open', () => {
    console.log('✅ Connected to Finnhub WebSocket');
    subscribedSymbols.forEach(s => finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: s })));
  });
  finnhubWs.on('message', data => {
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data.toString()); });
  });
  finnhubWs.on('close', () => { console.log('Finnhub WS closed, reconnecting…'); setTimeout(connectFinnhub, 5000); });
  finnhubWs.on('error', err => console.error('Finnhub WS error:', err.message));
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && msg.symbol) {
        const sym = msg.symbol.toUpperCase();
        subscribedSymbols.add(sym);
        if (finnhubWs?.readyState === WebSocket.OPEN) {
          finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
        }
      }
    } catch (_) {}
  });
  ws.on('close', () => clients.delete(ws));
});

// ── Mock Data Helpers ───────────────────────────────────────────────────────
function mockQuote(symbol) {
  const prices = { AAPL:182.3, TSLA:248.4, NVDA:875.2, MSFT:415.1, AMZN:190.5, META:510.3, GOOGL:175.8, SPY:510.2, QQQ:435.6, AMD:165.4 };
  const p = prices[symbol?.toUpperCase()] || 100;
  const pc = +(p * 0.992).toFixed(2);
  return { c: p, pc, h: +(p*1.01).toFixed(2), l: +(p*0.985).toFixed(2), o: pc, dp: +((p-pc)/pc*100).toFixed(2), d: +(p-pc).toFixed(2) };
}

function mockCandles(symbol, days = 5) {
  const base = mockQuote(symbol).c;
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let price = base * 0.95;
  const now = Math.floor(Date.now() / 1000);
  const step = 3600;
  const count = days * 8;
  for (let i = count; i >= 0; i--) {
    const ts = now - i * step;
    const change = (Math.random() - 0.48) * price * 0.008;
    const open = price;
    price = Math.max(price + change, 1);
    const high = Math.max(open, price) * (1 + Math.random() * 0.003);
    const low = Math.min(open, price) * (1 - Math.random() * 0.003);
    t.push(ts); o.push(+open.toFixed(2)); h.push(+high.toFixed(2));
    l.push(+low.toFixed(2)); c.push(+price.toFixed(2));
    v.push(Math.floor(Math.random() * 5e6 + 1e6));
  }
  return { s: 'ok', t, o, h, l, c, v };
}

function mockNews(symbol) {
  const headlines = [
    { headline: `${symbol || 'Markets'} shows strong momentum as investors weigh Fed outlook`, summary: 'Analysts remain cautious but bullish on near-term prospects.', source: 'Reuters', url: '#', datetime: Math.floor(Date.now()/1000) - 600, related: symbol || 'SPY', image: '' },
    { headline: 'Tech sector rallies on AI optimism and solid earnings beats', summary: 'Major technology companies outperform expectations this quarter.', source: 'Bloomberg', url: '#', datetime: Math.floor(Date.now()/1000) - 1800, related: symbol || 'QQQ', image: '' },
    { headline: 'Fed minutes signal potential rate cuts on the horizon', summary: 'Markets surge after Federal Reserve hints at policy pivot.', source: 'CNBC', url: '#', datetime: Math.floor(Date.now()/1000) - 3600, related: 'SPY', image: '' },
    { headline: 'Energy stocks climb as oil tops $85 per barrel', summary: 'Supply concerns push crude prices higher amid geopolitical tensions.', source: 'WSJ', url: '#', datetime: Math.floor(Date.now()/1000) - 7200, related: 'XLE', image: '' },
    { headline: 'Retail sales beat estimates, consumer spending holds firm', summary: 'Economic resilience continues to surprise to the upside.', source: 'MarketWatch', url: '#', datetime: Math.floor(Date.now()/1000) - 10800, related: 'XRT', image: '' },
  ];
  return headlines;
}

// ── Start Server ────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🚀 TradeDesk running at http://localhost:${PORT}`);
  if (!FINNHUB_KEY) {
    console.log('📌 Running in DEMO mode with simulated data.');
    console.log('   Get a free API key at https://finnhub.io to enable live data.\n');
  } else {
    console.log('✅ Finnhub API key loaded — live data enabled.\n');
  }
  connectFinnhub();
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
