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

// Migration: add last_active column if missing
try { db.exec("ALTER TABLE users ADD COLUMN last_active TEXT NOT NULL DEFAULT ''"); } catch (_) {}
// Backfill last_active for existing users that don't have it set
try { db.exec("UPDATE users SET last_active = created_at WHERE last_active = ''"); } catch (_) {}

// Migration: reset all portfolios to $20k (from $100k) without counting as a reset
try {
  const needsMigration = db.prepare(
    "SELECT 1 FROM portfolios WHERE starting_balance > 20000 LIMIT 1"
  ).get();
  if (needsMigration) {
    db.exec(`
      UPDATE portfolios
      SET cash = 20000, starting_balance = 20000, positions = '{}', orders = '[]'
    `);
    console.log('✅ Migrated all portfolios to $20,000 starting balance (resets unchanged)');
  }
} catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portfolios (
    user_id          TEXT PRIMARY KEY REFERENCES users(id),
    cash             REAL NOT NULL DEFAULT 20000,
    starting_balance REAL NOT NULL DEFAULT 20000,
    positions        TEXT NOT NULL DEFAULT '{}',
    orders           TEXT NOT NULL DEFAULT '[]',
    resets           INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pending_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id),
    symbol       TEXT NOT NULL,
    side         TEXT NOT NULL CHECK(side IN ('buy','sell')),
    qty          REAL NOT NULL,
    limit_price  REAL NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','filled','cancelled')),
    filled_price REAL,
    filled_at    TEXT,
    seen         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id),
    symbol       TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK(direction IN ('above','below')),
    target_price REAL NOT NULL,
    triggered    INTEGER NOT NULL DEFAULT 0,
    triggered_at TEXT,
    trigger_price REAL,
    seen         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );
`);

// ── Prepared Statements ──────────────────────────────────────────────────────
const stmts = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  insertPortfolio: db.prepare('INSERT INTO portfolios (user_id, cash, starting_balance) VALUES (?, 20000, 20000)'),
  loadPortfolio: db.prepare('SELECT * FROM portfolios WHERE user_id = ?'),
  upsertPortfolio: db.prepare(`
    INSERT INTO portfolios (user_id, cash, starting_balance, positions, orders, resets)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      cash = excluded.cash, starting_balance = excluded.starting_balance,
      positions = excluded.positions, orders = excluded.orders, resets = excluded.resets
  `),
  getProfile: db.prepare(`
    SELECT u.username, u.created_at, p.cash, p.starting_balance, p.positions, p.orders
    FROM users u JOIN portfolios p ON p.user_id = u.id
    WHERE u.username = ? COLLATE NOCASE
  `),
  getAllLeaderboard: db.prepare(`
    SELECT u.username, p.cash, p.starting_balance, p.positions, p.orders, p.resets
    FROM users u JOIN portfolios p ON p.user_id = u.id
  `),
  // Pending orders
  insertPending: db.prepare('INSERT INTO pending_orders (user_id, symbol, side, qty, limit_price, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  getPending: db.prepare('SELECT * FROM pending_orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC'),
  getActivePending: db.prepare('SELECT * FROM pending_orders WHERE status = ?'),
  cancelPending: db.prepare('UPDATE pending_orders SET status = ? WHERE id = ? AND user_id = ? AND status = ?'),
  fillPending: db.prepare('UPDATE pending_orders SET status = ?, filled_price = ?, filled_at = ? WHERE id = ?'),
  getFilledUnseen: db.prepare("SELECT * FROM pending_orders WHERE user_id = ? AND status = 'filled' AND seen = 0"),
  markPendingSeen: db.prepare("UPDATE pending_orders SET seen = 1 WHERE user_id = ? AND status = 'filled' AND seen = 0"),
  // Alerts
  insertAlert: db.prepare('INSERT INTO alerts (user_id, symbol, direction, target_price, created_at) VALUES (?, ?, ?, ?, ?)'),
  getAlerts: db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC'),
  deleteAlert: db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?'),
  getActiveAlerts: db.prepare('SELECT * FROM alerts WHERE triggered = 0'),
  triggerAlert: db.prepare('UPDATE alerts SET triggered = 1, triggered_at = ?, trigger_price = ? WHERE id = ?'),
  getUnseen: db.prepare('SELECT * FROM alerts WHERE user_id = ? AND triggered = 1 AND seen = 0'),
  markSeen: db.prepare('UPDATE alerts SET seen = 1 WHERE user_id = ? AND triggered = 1 AND seen = 0'),
  // Activity tracking
  updateLastActive: db.prepare('UPDATE users SET last_active = ? WHERE id = ?'),
  // Inactive account cleanup
  getInactiveUsers: db.prepare("SELECT id FROM users WHERE last_active < ?"),
  deletePortfolio: db.prepare('DELETE FROM portfolios WHERE user_id = ?'),
  deletePendingOrders: db.prepare('DELETE FROM pending_orders WHERE user_id = ?'),
  deleteAlerts: db.prepare('DELETE FROM alerts WHERE user_id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
};

function getUserByUsername(username) {
  return stmts.getUserByUsername.get(username);
}

function createUser(id, username, passwordHash) {
  stmts.insertUser.run(id, username, passwordHash, new Date().toISOString());
  stmts.insertPortfolio.run(id);
}

function defaultPortfolio() {
  return { cash: 20000, positions: {}, orders: [], startingBalance: 20000, resets: 0 };
}

function calcPortfolioStats(cash, positions, orders, start, prices = {}) {
  const posValue = Object.entries(positions).reduce((sum, [sym, pos]) => {
    return sum + pos.qty * (prices[sym] || pos.avgCost);
  }, 0);
  const totalValue = cash + posValue;
  const totalReturn = totalValue - start;
  const returnPct = +(totalReturn / start * 100).toFixed(2);
  const sells = orders.filter(o => o.side === 'sell' && o.realizedPnl != null);
  const wins = sells.filter(o => o.realizedPnl > 0);
  return {
    totalValue: +totalValue.toFixed(2),
    totalReturn: +totalReturn.toFixed(2),
    returnPct,
    totalTrades: orders.length,
    winRate: sells.length ? +(wins.length / sells.length * 100).toFixed(0) : null,
    realizedPnl: +sells.reduce((s, o) => s + o.realizedPnl, 0).toFixed(2),
  };
}

function loadUserPortfolio(userId) {
  const row = stmts.loadPortfolio.get(userId);
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
  stmts.upsertPortfolio.run(
    userId,
    portfolio.cash,
    portfolio.startingBalance ?? 20000,
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
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  // Track last activity (throttled to once per minute to avoid excess writes)
  const now = Date.now();
  if (!req.session._lastActiveUpdate || now - req.session._lastActiveUpdate > 60000) {
    req.session._lastActiveUpdate = now;
    stmts.updateLastActive.run(new Date().toISOString(), req.session.userId);
  }
  next();
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
  res.json({ success: true, username, isNewUser: true });
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
  stmts.updateLastActive.run(new Date().toISOString(), user.id);
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

const DIRECT_CATEGORIES = { crypto: 'crypto', merger: 'merger' };

app.get('/api/news/market', async (req, res) => {
  const { tab = 'market' } = req.query;
  if (!FINNHUB_KEY) return res.json(mockNews());
  try {
    let articles;

    if (tab === 'all') {
      const results = await Promise.all(
        ['general', 'crypto', 'merger'].map(fetchFinnhubCategory)
      );
      articles = results.flat().sort((a, b) => b.datetime - a.datetime);
    } else if (DIRECT_CATEGORIES[tab]) {
      articles = await fetchFinnhubCategory(DIRECT_CATEGORIES[tab]);
    } else if (NEWS_FILTERS[tab]) {
      const general = await fetchFinnhubCategory('general');
      const keywords = NEWS_FILTERS[tab];
      articles = general.filter(a => {
        const text = ((a.headline || '') + ' ' + (a.summary || '')).toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
    } else {
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
app.get('/api/portfolio', requireAuth, async (req, res) => {
  const portfolio = loadUserPortfolio(req.session.userId);
  // Calculate buying power = cash + net unrealized gains
  let unrealizedGains = 0;
  for (const [sym, pos] of Object.entries(portfolio.positions)) {
    const price = FINNHUB_KEY ? await getCachedQuote(sym) : mockQuote(sym).c;
    if (price) unrealizedGains += (price - pos.avgCost) * pos.qty;
  }
  portfolio.buyingPower = Math.max(0, portfolio.cash + unrealizedGains);
  res.json(portfolio);
});

app.post('/api/trade', requireAuth, async (req, res) => {
  const { symbol, side, qty, orderType, limitPrice } = req.body;
  if (!symbol || !side || !qty || qty <= 0) {
    return res.status(400).json({ error: 'Invalid order parameters' });
  }
  const portfolio = loadUserPortfolio(req.session.userId);

  const sym = symbol.toUpperCase();
  const marketPrice = FINNHUB_KEY ? await getCachedQuote(sym) : mockQuote(symbol).c;
  if (!marketPrice || marketPrice <= 0) return res.status(400).json({ error: 'Price unavailable for this symbol' });

  // Limit orders: check if condition is met now, otherwise store as pending
  if (orderType === 'limit') {
    const limit = parseFloat(limitPrice);
    if (!limit || limit <= 0) return res.status(400).json({ error: 'Invalid limit price' });
    const conditionMet = (side === 'buy' && marketPrice <= limit) ||
                         (side === 'sell' && marketPrice >= limit);
    if (!conditionMet) {
      // Validate the user can afford it before queuing
      const shares = parseFloat(qty);
      if (side === 'buy') {
        let unrealizedGains = 0;
        for (const [posSym, pos] of Object.entries(portfolio.positions)) {
          const livePrice = await getCachedQuote(posSym);
          if (livePrice) unrealizedGains += (livePrice - pos.avgCost) * pos.qty;
        }
        const buyingPower = Math.max(0, portfolio.cash + unrealizedGains);
        if (buyingPower < limit * shares) {
          return res.status(400).json({ error: `Insufficient buying power. Need $${(limit * shares).toFixed(2)}, have $${buyingPower.toFixed(2)}` });
        }
      }
      if (side === 'sell') {
        const pos = portfolio.positions[sym];
        if (!pos || pos.qty < shares) {
          return res.status(400).json({ error: `Insufficient shares. Have ${pos?.qty ?? 0}, need ${shares}` });
        }
      }
      stmts.insertPending.run(req.session.userId, sym, side, shares, limit, new Date().toISOString());
      return res.json({
        success: true,
        pending: true,
        message: `Limit order queued: ${side.toUpperCase()} ${shares} ${sym} @ $${limit.toFixed(2)}. Will fill when market price ${side === 'buy' ? 'drops to' : 'rises to'} $${limit.toFixed(2)}.`
      });
    }
  }

  // Execute at the real market price
  const execPrice = marketPrice;

  const shares = parseFloat(qty);
  const totalCost = execPrice * shares;
  let realizedPnl = null;

  if (side === 'buy') {
    // Buying power = cash + net unrealized gains from held positions
    let unrealizedGains = 0;
    for (const [posSym, pos] of Object.entries(portfolio.positions)) {
      const livePrice = await getCachedQuote(posSym);
      if (livePrice) unrealizedGains += (livePrice - pos.avgCost) * pos.qty;
    }
    const buyingPower = Math.max(0, portfolio.cash + unrealizedGains);
    if (buyingPower < totalCost) return res.status(400).json({ error: `Insufficient buying power. Need $${totalCost.toFixed(2)}, have $${buyingPower.toFixed(2)}` });
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

  // Recalculate buying power for the response
  let postGains = 0;
  for (const [posSym, pos] of Object.entries(portfolio.positions)) {
    const livePrice = await getCachedQuote(posSym);
    if (livePrice) postGains += (livePrice - pos.avgCost) * pos.qty;
  }
  portfolio.buyingPower = Math.max(0, portfolio.cash + postGains);

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
  const row = stmts.getProfile.get(req.params.username);

  if (!row) return res.status(404).json({ error: 'User not found' });

  const positions = JSON.parse(row.positions);
  const orders = JSON.parse(row.orders);
  const start = row.starting_balance || 20000;

  const prices = {};
  await Promise.all(Object.keys(positions).map(async sym => {
    prices[sym] = await getCachedQuote(sym);
  }));

  const stats = calcPortfolioStats(row.cash, positions, orders, start, prices);

  res.json({
    username: row.username,
    memberSince: row.created_at,
    cash: +row.cash.toFixed(2),
    ...stats,
    positions: Object.entries(positions).map(([sym, p]) => ({
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
    if (!FINNHUB_KEY) return cached?.price || null;
    const r = await axios.get('https://finnhub.io/api/v1/quote', {
      params: { symbol, token: FINNHUB_KEY }, timeout: 5000
    });
    const price = r.data.c > 0 ? r.data.c : null;
    if (price) quoteCache[symbol] = { price, time: Date.now() };
    return price || cached?.price || null;
  } catch (_) { return cached?.price || null; }
}

app.get('/api/leaderboard', async (req, res) => {
  const rows = stmts.getAllLeaderboard.all();

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
    const start = row.starting_balance || 20000;
    const stats = calcPortfolioStats(row.cash, row.positions, row.orders, start, prices);
    return { username: row.username, ...stats, resets: row.resets || 0 };
  }).sort((a, b) => b.returnPct - a.returnPct);

  res.json(entries);
});

// ── Pending Orders API ──────────────────────────────────────────────────
app.get('/api/orders/pending', requireAuth, (req, res) => {
  res.json(stmts.getPending.all(req.session.userId, 'pending'));
});

app.delete('/api/orders/pending/:id', requireAuth, (req, res) => {
  stmts.cancelPending.run('cancelled', req.params.id, req.session.userId, 'pending');
  res.json({ success: true });
});

// Return filled orders the user hasn't seen yet, then mark them seen
app.get('/api/orders/filled', requireAuth, (req, res) => {
  const unseen = stmts.getFilledUnseen.all(req.session.userId);
  stmts.markPendingSeen.run(req.session.userId);
  res.json(unseen);
});

// ── Price Alerts API ────────────────────────────────────────────────────
app.get('/api/alerts', requireAuth, (req, res) => {
  const alerts = stmts.getAlerts.all(req.session.userId);
  res.json(alerts);
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { symbol, direction, targetPrice } = req.body;
  if (!symbol || !direction || !targetPrice || targetPrice <= 0) {
    return res.status(400).json({ error: 'Invalid alert parameters' });
  }
  if (!['above', 'below'].includes(direction)) {
    return res.status(400).json({ error: 'Direction must be "above" or "below"' });
  }
  stmts.insertAlert.run(req.session.userId, symbol.toUpperCase(), direction, parseFloat(targetPrice), new Date().toISOString());
  res.json({ success: true });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  stmts.deleteAlert.run(req.params.id, req.session.userId);
  res.json({ success: true });
});

// Return triggered-but-unseen alerts, then mark them seen
app.get('/api/alerts/triggered', requireAuth, (req, res) => {
  const unseen = stmts.getUnseen.all(req.session.userId);
  stmts.markSeen.run(req.session.userId);
  res.json(unseen);
});

// ── Server-side Alert & Pending Order Checker ───────────────────────────
async function checkServerAlertsAndOrders() {
  const activeAlerts = stmts.getActiveAlerts.all();
  const pendingOrders = stmts.getActivePending.all('pending');
  if (!activeAlerts.length && !pendingOrders.length) return;

  // Collect all symbols we need prices for
  const allSymbols = new Set();
  for (const a of activeAlerts) allSymbols.add(a.symbol);
  for (const o of pendingOrders) allSymbols.add(o.symbol);

  // Fetch prices for all symbols
  const prices = {};
  for (const symbol of allSymbols) {
    try {
      if (FINNHUB_KEY) {
        const r = await axios.get('https://finnhub.io/api/v1/quote', {
          params: { symbol, token: FINNHUB_KEY }, timeout: 5000
        });
        prices[symbol] = r.data.c > 0 ? r.data.c : null;
      } else {
        prices[symbol] = mockQuote(symbol).c;
      }
    } catch (_) { /* skip */ }
  }

  const now = new Date().toISOString();

  // Check alerts
  for (const a of activeAlerts) {
    const price = prices[a.symbol];
    if (!price) continue;
    const hit = (a.direction === 'above' && price >= a.target_price) ||
                (a.direction === 'below' && price <= a.target_price);
    if (hit) stmts.triggerAlert.run(now, price, a.id);
  }

  // Fill pending orders
  for (const o of pendingOrders) {
    const price = prices[o.symbol];
    if (!price) continue;
    const conditionMet = (o.side === 'buy' && price <= o.limit_price) ||
                         (o.side === 'sell' && price >= o.limit_price);
    if (!conditionMet) continue;

    // Execute the trade against the user's portfolio
    const portfolio = loadUserPortfolio(o.user_id);
    const totalCost = price * o.qty;
    let realizedPnl = null;

    if (o.side === 'buy') {
      if (portfolio.cash < totalCost) continue; // can't afford anymore, skip
      portfolio.cash -= totalCost;
      if (!portfolio.positions[o.symbol]) portfolio.positions[o.symbol] = { qty: 0, avgCost: 0 };
      const pos = portfolio.positions[o.symbol];
      const newQty = pos.qty + o.qty;
      pos.avgCost = ((pos.qty * pos.avgCost) + totalCost) / newQty;
      pos.qty = newQty;
    } else {
      const pos = portfolio.positions[o.symbol];
      if (!pos || pos.qty < o.qty) continue; // not enough shares anymore, skip
      realizedPnl = +((price - pos.avgCost) * o.qty).toFixed(2);
      portfolio.cash += totalCost;
      pos.qty -= o.qty;
      if (pos.qty <= 0) delete portfolio.positions[o.symbol];
    }

    // Record as filled order in portfolio history
    const order = {
      id: Date.now(), symbol: o.symbol, side: o.side, qty: o.qty, price,
      total: totalCost, type: 'limit', limitPrice: o.limit_price,
      timestamp: now, status: 'filled',
      ...(realizedPnl !== null ? { realizedPnl } : {})
    };
    portfolio.orders.unshift(order);
    portfolio.orders = portfolio.orders.slice(0, 100);
    saveUserPortfolio(o.user_id, portfolio);

    // Mark the pending order as filled
    stmts.fillPending.run('filled', price, now, o.id);
  }
}

// Check alerts & pending orders every 60 seconds (and once on startup)
setTimeout(checkServerAlertsAndOrders, 5000);
setInterval(checkServerAlertsAndOrders, 60000);

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

// ── Inactive Account Cleanup (45 days) ──────────────────────────────────────
const deleteInactiveUser = db.transaction((userId) => {
  stmts.deletePendingOrders.run(userId);
  stmts.deleteAlerts.run(userId);
  stmts.deletePortfolio.run(userId);
  stmts.deleteUser.run(userId);
});

function cleanupInactiveAccounts() {
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  const inactive = stmts.getInactiveUsers.all(cutoff);
  for (const { id } of inactive) {
    deleteInactiveUser(id);
  }
  if (inactive.length) console.log(`🧹 Cleaned up ${inactive.length} inactive account(s)`);
}

// Run cleanup on startup and then once daily
cleanupInactiveAccounts();
setInterval(cleanupInactiveAccounts, 24 * 60 * 60 * 1000);

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
