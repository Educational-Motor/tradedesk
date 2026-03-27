let countdown = 30;
let countdownInterval = null;

async function loadLeaderboard() {
  const data = await fetch('/api/leaderboard').then(r => r.json()).catch(() => []);
  render(data);
  resetCountdown();
}

function render(entries) {
  const now = new Date();
  document.getElementById('stat-traders').textContent = entries.length;
  document.getElementById('stat-updated').textContent =
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  renderPodium(entries);
  renderTable(entries);
}

function renderPodium(entries) {
  const podium = document.getElementById('podium');
  // Visual order: 2nd (left), 1st (center), 3rd (right)
  const slots = [
    { entry: entries[1], rank: 2, cls: 'second', medal: '🥈', rankCls: 'silver' },
    { entry: entries[0], rank: 1, cls: 'first',  medal: '🥇', rankCls: 'gold'   },
    { entry: entries[2], rank: 3, cls: 'third',  medal: '🥉', rankCls: 'bronze' },
  ];

  podium.innerHTML = slots.map(({ entry, rank, cls, medal, rankCls }) => {
    if (!entry) {
      return `<div class="podium-card ${cls} podium-empty">
        <div class="podium-medal">${medal}</div>
        <div class="podium-rank ${rankCls}">#${rank}</div>
        <div class="podium-name">—</div>
      </div>`;
    }
    const pos = entry.returnPct >= 0;
    return `<div class="podium-card ${cls}">
      <div class="podium-medal">${medal}</div>
      <div class="podium-rank ${rankCls}">#${rank}</div>
      <div class="podium-name">${esc(entry.username)}</div>
      <div class="podium-return ${pos ? 'pos' : 'neg'}">${fmtPct(entry.returnPct)}</div>
      <div class="podium-value">${fmt(entry.totalValue)}</div>
      <div class="podium-meta">
        <span>${entry.totalTrades} trade${entry.totalTrades !== 1 ? 's' : ''}</span>
        ${entry.winRate != null ? `<span>${entry.winRate}% win rate</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderTable(entries) {
  const tbody = document.getElementById('lb-body');
  const empty = document.getElementById('lb-empty');

  if (!entries.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = entries.map((e, i) => {
    const rank = i + 1;
    const pos = e.returnPct >= 0;
    return `<tr class="${rank <= 3 ? 'rank-' + rank : ''}">
      <td class="td-rank">${rank}</td>
      <td class="td-name">${esc(e.username)}</td>
      <td class="td-value">${fmt(e.totalValue)}</td>
      <td class="td-return ${pos ? 'pos' : 'neg'}">${fmtPct(e.returnPct)}</td>
      <td class="td-winrate">${e.winRate != null ? e.winRate + '%' : '—'}</td>
      <td class="td-trades">${e.totalTrades}</td>
    </tr>`;
  }).join('');
}

function resetCountdown() {
  countdown = 30;
  clearInterval(countdownInterval);
  const label = document.getElementById('refresh-label');
  countdownInterval = setInterval(() => {
    countdown--;
    label.textContent = countdown > 0 ? `Refreshes in ${countdown}s` : 'Refreshing…';
    if (countdown <= 0) { clearInterval(countdownInterval); loadLeaderboard(); }
  }, 1000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
}
function fmtPct(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadLeaderboard();
