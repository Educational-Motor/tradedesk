# TradeDesk

A live market terminal for paper trading. Practice reading charts, reacting to news, and executing trades with $20,000 in virtual money and real risk management.

Built as a learning tool for anyone who wants to develop a trading intuition before putting real money on the line.

> **Live:** [papertradedesk.fly.dev](https://papertradedesk.fly.dev)

---

## Features

**Market Data**
- Real-time stock prices via Finnhub WebSocket — live tick-by-tick updates with price flash animations
- Candlestick charts powered by TradingView Lightweight Charts with EMA 20, SMA 50, SMA 200 overlays
- RSI (14), MACD (12/26/9), and Volume indicators — all calculated client-side
- 4 timeframes: 1D · 5D · 1M · 3M
- Historical OHLCV data from Yahoo Finance (no extra API key needed)

**News & Sentiment**
- Live news feed categorized by: All · Market · Symbol · Geopolitical · Energy · Forex · Crypto · M&A
- AI sentiment scoring on every headline (Bullish / Bearish / Neutral) using keyword analysis
- Breaking news popup with one click buy/sell from the alert
- Scrolling news ticker at the bottom

**Trading**
- Paper trading engine with $20,000 starting balance
- Market and limit orders
- Real-time P&L on open positions
- Full order history with realized P&L tracking
- Portfolio reset with tracked reset count

**Tools**
- **Position Sizer** — enter price, stop loss, and risk % to calculate exact share count and dollar risk
- **Fear & Greed Meter** — composite sentiment index built from VIX, SPY momentum, and RSI-14
- **Price Alerts** — set target prices, get notified when a stock hits them
- **Economic Calendar** — FOMC, CPI, GDP, Jobs reports, and earnings dates

**Platform**
- User accounts — register/login, each user has their own isolated portfolio
- **Leaderboard** — ranked competition with live portfolio values, return %, win rate, trade count, and reset tracking
- Watchlist with live quote updates
- Recommended stocks by sector (Indices · Tech · Energy · Finance)
- Market hours for NYSE, LSE, TSE, SSE
- Resizable panels — drag the column dividers to customize your layout

---

## Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express |
| Real-time | WebSocket (ws) |
| Frontend | Vanilla JS — no framework |
| Charts | TradingView Lightweight Charts v4.1.3 |
| Market data | Finnhub.io (quotes, news, search, earnings) |
| Historical data | Yahoo Finance (candles, VIX — no key needed) |
| Auth | bcryptjs + express-session |
| Storage | SQLite (better-sqlite3) |

---

## Getting Started

### Prerequisites
- Node.js 18+
- Free API key from [finnhub.io](https://finnhub.io) (takes 30 seconds)

### Install

```bash
git clone https://github.com/Educational-Motor/tradedesk.git
cd tradedesk
npm install
cp .env.example .env
```

Edit `.env` with your keys:

```env
FINNHUB_API_KEY=your_key_here
SESSION_SECRET=any_long_random_string
PORT=3000
```

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000)

> **No API key?** Leave `FINNHUB_API_KEY` empty and the app runs in **Demo Mode** with simulated prices and mock news — fully functional for testing.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FINNHUB_API_KEY` | Yes (for live data) | Free key from [finnhub.io](https://finnhub.io) |
| `SESSION_SECRET` | Yes | Random string for session encryption |
| `PORT` | No | Server port (default: `3000`) |

---

## Project Structure

```
tradedesk/
├── server.js          # Express server, API routes, WebSocket proxy
├── Dockerfile
├── fly.toml           # Fly.io deployment config
├── public/
│   ├── index.html     # Main trading terminal
│   ├── app.js         # Frontend logic (charts, trading, UI)
│   ├── style.css      # Terminal styles
│   ├── leaderboard.html
│   ├── leaderboard.css
│   └── leaderboard.js
├── data/              # SQLite databases (gitignored)
├── .env.example
└── package.json
```

---

## Deployment

Deployed on [Fly.io](https://fly.io) (free tier) with persistent SQLite storage.

1. Install the Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Sign up and log in: `flyctl auth signup`
3. Create the app and volume:
```bash
flyctl apps create your-app-name
flyctl volumes create your-app-name_data --size 1 --region iad
```
4. Set secrets:
```bash
flyctl secrets set FINNHUB_API_KEY=your_key SESSION_SECRET=your_secret
```
5. Deploy:
```bash
flyctl deploy
```

Your app will be live at `https://your-app-name.fly.dev`.

**Custom domain** (optional): buy a domain from [Porkbun](https://porkbun.com) (~$1-2/year for `.xyz`), manage DNS on [Cloudflare](https://cloudflare.com) for free, then:
```bash
flyctl certs add yourdomain.xyz
```

---

## License

MIT — use it, fork it, learn from it.

---

*Built by [@Educational-Motor](https://github.com/Educational-Motor) · [@yu.karlandrew](https://instagram.com/yu.karlandrew)*
