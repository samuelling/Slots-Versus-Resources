// Engine checks: full games to a winner for 2-4 players, and each portal type.
import { Sim } from '../sim.js';

let failed = false;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed = true; };

const mk = (n) => {
  const r = new Sim();
  for (let i = 0; i < n; i++) r.join('p' + i, 'P' + i);
  r.start();
  return r;
};

for (const n of [2, 3, 4]) {
  const r = mk(n);
  let t = 0, nan = false;
  while (r.phase !== 'over' && t < 3600) {
    r.update(1 / 60);
    const b = r.ball;
    if (![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) { nan = true; break; }
    t += 1 / 60;
  }
  const alive = [...r.players.values()].filter((p) => p.alive).length;
  check(r.phase === 'over' && !nan && alive === 1 && r.winnerId, `${n} players play to a single winner (${t.toFixed(0)}s)`);
}

// portals
const portalGame = () => {
  const r = mk(3);
  r.phase = 'playing'; r.phaseT = 0;
  r.chutes = [{ x: 200, y: 200, type: 'warp' }, { x: 800, y: 200, type: 'cannon' }, { x: 500, y: 800, type: 'vault' }];
  r.chuteTimer = 999;
  return r;
};
const through = (r, i) => {
  const c = r.chutes[i], b = r.ball;
  r.lastTouch = 'p0'; b.mode = 'live'; b.x = c.x; b.y = c.y; b.vx = 300; b.vy = 100; b.cd = 0;
  r.events = [];
  let out = null;
  for (let t = 0; t < 180 && !out; t++) { r.update(1 / 60); out = r.events.find((e) => e[0] === 'out'); }
  return { out, sp: Math.hypot(b.vx, b.vy), ang: Math.atan2(b.vy, b.vx) * 180 / Math.PI, score: r.players.get('p0').score };
};
let r = portalGame(); let res = through(r, 0);
check(res.out && res.out[3] === 'warp' && Math.abs(res.out[1] - 200) + Math.abs(res.out[2] - 200) > 100, 'wormhole exits from a different chute');
let atToucher = 0;
for (let k = 0; k < 100; k++) { r = portalGame(); res = through(r, 1); if (Math.abs(res.ang - Math.atan2(800, -300) * 180 / Math.PI) < 12) atToucher++; }
check(atToucher === 0, 'cannon never aims at the player who hit it last');
r = portalGame(); res = through(r, 1);
check(res.sp >= 800, 'cannon fires hard');
r = portalGame(); res = through(r, 2);
check(res.score === 25 && Math.round(res.sp) === 400, 'vault awards 25 and releases at calm speed');

// snapshot / restore round trip (used when a new host takes over)
r = mk(3);
for (let i = 0; i < 300; i++) r.update(1 / 60);
const snap = JSON.parse(JSON.stringify(r.snapshot('p0')));
const r2 = new Sim(); r2.restore(snap);
check(r2.phase === r.phase && r2.players.size === 3 && Math.abs(r2.ball.x - r.ball.x) < 0.2, 'a snapshot restores into a new Sim');
check(JSON.stringify(snap).length < 1500, `snapshot is small (${JSON.stringify(snap).length} bytes)`);

process.exit(failed ? 1 : 0);
