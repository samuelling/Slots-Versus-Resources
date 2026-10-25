// Plays a full game against a local `wrangler dev` using simulated phones.
// Usage: node test/bots.mjs [port] [players]
const PORT = process.argv[2] || '8787';
const N = Number(process.argv[3] || 3);
const CODE = 'TEST';
const W = 1000;

const toLocal = (s, x, y) => [[x, W - y], [W - y, W - x], [W - x, y], [y, x]][s];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const stats = { frames: 0, hit: 0, bump: 0, chute: 0, out: 0, goal: 0, shuffle: 0, nan: 0, over: 0, maxSpeed: 0 };
let finalState = null;
const t0 = Date.now();

function bot(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/${CODE}`);
    let id = null, host = false;
    // weaker bots miss more often
    const skill = [0.3, 0.1, 0.2, 0.1][i];
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'Bot' + i }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') { id = m.id; return; }
      if (m.t !== 's') return;
      if (i === 0) {
        stats.frames++;
        const b = m.ball;
        if (![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) stats.nan++;
        stats.maxSpeed = Math.max(stats.maxSpeed, Math.hypot(b.vx, b.vy));
        for (const ev of m.ev) {
          if (ev[0] in stats) stats[ev[0]]++;
          if (ev[0] === 'over') stats.over++;
        }
        finalState = m;
        if (m.ph === 'lobby' && m.pl.length >= N && Date.now() - t0 > 600 && !host) {
          host = true; ws.send(JSON.stringify({ t: 'start' }));
        }
        if (m.ph === 'over') { setTimeout(() => { ws.close(); resolve(); }, 300); }
      }
      if (m.ph === 'over') { if (i !== 0) setTimeout(() => { ws.close(); resolve(); }, 300); return; }
      const me = m.pl.find((p) => p.id === id);
      if (!me || me.s < 0 || !me.a || m.ph === 'lobby') return;
      const b = m.ball;
      const [u] = toLocal(me.s, b.x, b.y);
      const aim = u + (Math.random() - 0.5) * (1 - skill) * 500;
      ws.send(JSON.stringify({ t: 'paddle', u: clamp(aim, 320, 680) }));
    };
    ws.onerror = (e) => { console.error('ws error', e.message || e); resolve(); };
  });
}

const timeout = setTimeout(() => {
  console.log('TIMEOUT after 150s (game may just be long)');
  report(); process.exit(0);
}, 150000);

function report() {
  const s = finalState;
  console.log(JSON.stringify(stats));
  if (s) console.log('final:', s.ph, s.pl.map((p) => `${p.n}:lives=${p.l},pts=${p.sc},alive=${p.a}`).join(' | '), 'winner=', s.win);
}

const bots = [];
for (let i = 0; i < N; i++) { bots.push(bot(i)); await new Promise((r) => setTimeout(r, 120)); }
await Promise.all(bots);
clearTimeout(timeout);
report();
const ok = stats.nan === 0 && stats.goal > 0 && stats.hit > 0 && stats.over === 1;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
