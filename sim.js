// Pinball Party game engine. Pure logic: no networking, no timers, no DOM.
// The host's phone runs one Sim; everyone else just renders its snapshots.

export const W = 1000;          // arena is a W x W square in logical units
const R = 14;                   // ball radius
export const MOUTH_LO = 220;    // goal mouth spans u in [LO, HI] along each active side
export const MOUTH_HI = 780;
export const PAD_HALF = 100;    // paddle half-width
const PAD_D = 44;               // paddle centre distance from the edge
const PAD_HALF_T = 8;           // paddle half-thickness
export const PAD_MIN = MOUTH_LO + PAD_HALF;
export const PAD_MAX = MOUTH_HI - PAD_HALF;
const POST_R = 8;
const MIN_V = 320;
const SERVE_V = 400;
const MAX_V = 1500;
export const LIVES = 3;
export const MAX_PLAYERS = 4;

export const BUMPERS = [
  { x: 500, y: 500, r: 52 },
  { x: 330, y: 340, r: 32 },
  { x: 670, y: 340, r: 32 },
  { x: 330, y: 660, r: 32 },
  { x: 670, y: 660, r: 32 },
];

// three chutes, each a different portal type (positions shuffle, types persist by index)
export const CHUTE_TYPES = ['warp', 'cannon', 'vault'];
const VAULT_POINTS = 25;

// side numbering: 0 bottom, 1 right, 2 top, 3 left
const SIDE_SETS = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };

// world <-> side-local. u runs along the edge, d is distance inward from the edge.
function toLocal(s, x, y) {
  switch (s) {
    case 0: return [x, W - y];
    case 1: return [W - y, W - x];
    case 2: return [W - x, y];
    default: return [y, x];
  }
}
function toWorld(s, u, d) {
  switch (s) {
    case 0: return [u, W - d];
    case 1: return [W - d, W - u];
    case 2: return [W - u, d];
    default: return [d, u];
  }
}
function velToLocal(s, vx, vy) {
  switch (s) {
    case 0: return [vx, -vy];
    case 1: return [-vy, -vx];
    case 2: return [-vx, vy];
    default: return [vy, vx];
  }
}
function velToWorld(s, vu, vd) {
  switch (s) {
    case 0: return [vu, -vd];
    case 1: return [-vd, -vu];
    case 2: return [-vu, vd];
    default: return [vd, vu];
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const round1 = (v) => Math.round(v * 10) / 10;

export class Sim {
  constructor() {
    this.players = new Map();   // id -> player
    this.phase = 'lobby';       // lobby | countdown | playing | over
    this.phaseT = 0;
    this.winnerId = null;
    this.sideOwner = {};        // side -> player id
    this.ball = { x: 500, y: 500, vx: 0, vy: 0, mode: 'serve', t: 0, cd: 0, exit: 0 };
    this.lastTouch = null;      // player id
    this.chutes = [];
    this.chuteTimer = 0;
    this.events = [];
    this.placeChutes();
  }

  // ---------- roster ----------

  lobbyCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.spectator) n++;
    return n;
  }

  join(id, name) {
    if (this.players.has(id)) { this.players.get(id).name = name; return; }
    this.players.set(id, {
      id, name: String(name || 'Player').slice(0, 12) || 'Player',
      side: -1, lives: LIVES, score: 0, pu: 500, tu: 500, pv: 0, alive: true, gone: false,
      spectator: this.phase !== 'lobby' || this.lobbyCount() >= MAX_PLAYERS,
    });
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby' || p.side < 0) { this.players.delete(id); return; }
    // mid-game: their goal becomes a wall
    p.gone = true;
    if (p.alive) { p.alive = false; p.lives = 0; }
    if (this.phase === 'playing') this.checkOver();
  }

  setPaddle(id, u) {
    const p = this.players.get(id);
    if (p && p.side >= 0 && typeof u === 'number' && Number.isFinite(u)) p.tu = clamp(u, PAD_MIN, PAD_MAX);
  }

  // ---------- game flow ----------

  canStart() {
    return this.phase === 'lobby' && this.lobbyCount() >= 2;
  }

  start() {
    if (!this.canStart()) return false;
    const seated = [...this.players.values()].filter((p) => !p.spectator).slice(0, MAX_PLAYERS);
    const sides = SIDE_SETS[seated.length];
    this.sideOwner = {};
    seated.forEach((p, i) => {
      p.side = sides[i]; p.lives = LIVES; p.score = 0; p.alive = true; p.pu = 500; p.tu = 500; p.pv = 0;
      this.sideOwner[p.side] = p.id;
    });
    for (const p of this.players.values()) if (!seated.includes(p)) { p.spectator = true; p.side = -1; }
    this.winnerId = null;
    this.placeChutes();
    this.resetBall();
    this.phase = 'countdown';
    this.phaseT = 3.5;
    return true;
  }

  toLobby() {
    this.phase = 'lobby';
    this.winnerId = null;
    this.sideOwner = {};
    this.lastTouch = null;
    for (const [id, p] of [...this.players]) {
      if (p.gone) { this.players.delete(id); continue; }
      p.side = -1; p.lives = LIVES; p.score = 0; p.alive = true; p.spectator = false; p.pv = 0;
    }
    let n = 0;
    for (const p of this.players.values()) { if (++n > MAX_PLAYERS) p.spectator = true; }
    this.resetBall();
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.side >= 0 && p.alive);
  }

  resetBall() {
    const b = this.ball;
    // serve from just above or below the centre bumper (alternating), never from inside it
    this.serveFlip = !this.serveFlip;
    b.x = 500; b.y = this.serveFlip ? 380 : 620; b.vx = 0; b.vy = 0; b.mode = 'serve'; b.t = 1.6; b.cd = 0;
    this.lastTouch = null;
  }

  launch() {
    const b = this.ball;
    const alive = this.alivePlayers();
    let ang = rnd(0, Math.PI * 2);
    if (alive.length) {
      const target = alive[Math.floor(Math.random() * alive.length)];
      const [tx, ty] = toWorld(target.side, 500, 0);
      ang = Math.atan2(ty - b.y, tx - b.x) + rnd(-0.6, 0.6);
    }
    b.vx = Math.cos(ang) * SERVE_V;
    b.vy = Math.sin(ang) * SERVE_V;
    b.mode = 'live';
  }

  update(dt) {
    // paddles chase their targets at a capped speed; velocity feeds the smash
    for (const p of this.players.values()) {
      if (p.side < 0) continue;
      const old = p.pu;
      const step = clamp(p.tu - p.pu, -3500 * dt, 3500 * dt);
      p.pu += step;
      p.pv = p.pv * 0.6 + 0.4 * ((p.pu - old) / dt);
    }
    if (this.phase === 'countdown') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.phase = 'playing'; this.phaseT = 0; this.chuteTimer = 9; }
      return;
    }
    if (this.phase !== 'playing') return;

    this.chuteTimer -= dt;
    if (this.chuteTimer <= 0 && this.ball.mode !== 'tube') {
      this.placeChutes();
      this.chuteTimer = 9;
      this.events.push(['shuffle']);
    }
    this.stepBallFrame(dt);
  }

  placeChutes() {
    const out = [];
    let tries = 0;
    while (out.length < 3 && tries++ < 400) {
      const x = rnd(170, 830), y = rnd(170, 830);
      if (BUMPERS.some((b) => Math.hypot(x - b.x, y - b.y) < b.r + 70)) continue;
      if (out.some((c) => Math.hypot(x - c.x, y - c.y) < 190)) continue;
      out.push({ x, y, type: CHUTE_TYPES[out.length] });
    }
    const fallback = [{ x: 200, y: 500 }, { x: 800, y: 500 }, { x: 500, y: 210 }];
    while (out.length < 3) out.push({ ...fallback[out.length], type: CHUTE_TYPES[out.length] });
    this.chutes = out;
  }

  // ---------- physics ----------

  stepBallFrame(dt) {
    const b = this.ball;
    if (b.cd > 0) b.cd -= dt;
    if (b.mode === 'serve') {
      b.t -= dt;
      if (b.t <= 0) this.launch();
      return;
    }
    if (b.mode === 'tube') {
      b.t -= dt;
      if (b.t <= 0) this.exitChute();
      return;
    }
    const sp = Math.hypot(b.vx, b.vy);
    const n = Math.max(1, Math.ceil((sp * dt) / 7));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (!this.stepBall(h)) break;
    }
    // keep it lively
    const s2 = Math.hypot(b.vx, b.vy);
    if (b.mode === 'live' && s2 > 0 && s2 < MIN_V) {
      b.vx *= MIN_V / s2; b.vy *= MIN_V / s2;
    }
  }

  // returns false if the step ended the rally (goal) or sent the ball into a tube
  stepBall(h) {
    const b = this.ball;
    b.x += b.vx * h;
    b.y += b.vy * h;

    // bumpers
    for (const bm of BUMPERS) {
      const dx = b.x - bm.x, dy = b.y - bm.y;
      const dist = Math.hypot(dx, dy);
      const min = R + bm.r;
      if (dist < min && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        b.x = bm.x + nx * min; b.y = bm.y + ny * min;
        const dot = b.vx * nx + b.vy * ny;
        if (dot < 0) {
          b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny;
          const sp = Math.min(MAX_V, Math.hypot(b.vx, b.vy) * 1.04 + 40);
          const cur = Math.hypot(b.vx, b.vy) || 1;
          b.vx *= sp / cur; b.vy *= sp / cur;
          const lt = this.lastTouch && this.players.get(this.lastTouch);
          if (lt) lt.score += 1;
          this.events.push(['bump', Math.round(bm.x), Math.round(bm.y)]);
        }
      }
    }

    // chutes
    if (b.cd <= 0) {
      for (let i = 0; i < this.chutes.length; i++) {
        const c = this.chutes[i];
        if (Math.hypot(b.x - c.x, b.y - c.y) < 24) {
          b.mode = 'tube'; b.exit = i;
          b.t = c.type === 'cannon' ? 0.6 : c.type === 'vault' ? 1.0 : rnd(0.35, 0.8);
          b.x = c.x; b.y = c.y;
          if (c.type === 'vault') {
            const lt = this.lastTouch && this.players.get(this.lastTouch);
            if (lt) lt.score += VAULT_POINTS;
            this.events.push(['vault', VAULT_POINTS, lt ? lt.side : -1]);
          }
          this.events.push(['chute', i, c.type]);
          return false;
        }
      }
    }

    // walls, goal mouths, posts, paddles
    for (let s = 0; s < 4; s++) {
      const ownerId = this.sideOwner[s];
      const owner = ownerId && this.players.get(ownerId);
      const open = !!(owner && owner.alive);
      let [u, d] = toLocal(s, b.x, b.y);
      let [vu, vd] = velToLocal(s, b.vx, b.vy);
      let changed = false;

      if (d < R) {
        if (open && u >= MOUTH_LO && u <= MOUTH_HI) {
          if (d < -R * 0.5) { this.goal(owner); return false; }
        } else {
          d = R; if (vd < 0) vd = -vd; changed = true;
        }
      }

      if (open) {
        // posts at the edges of the mouth
        for (const pu of [MOUTH_LO, MOUTH_HI]) {
          const dx = u - pu, dy = d;
          const dist = Math.hypot(dx, dy);
          const min = R + POST_R;
          if (dist < min && dist > 0.001) {
            const nx = dx / dist, ny = dy / dist;
            u = pu + nx * min; d = ny * min;
            const dot = vu * nx + vd * ny;
            if (dot < 0) { vu -= 2 * dot * nx; vd -= 2 * dot * ny; }
            changed = true;
          }
        }
        // paddle
        if (vd < 0 && d - R < PAD_D + PAD_HALF_T && d > PAD_D - PAD_HALF_T && Math.abs(u - owner.pu) <= PAD_HALF + R * 0.6) {
          const hit = clamp((u - owner.pu) / PAD_HALF, -1, 1);
          let sp = Math.hypot(vu, vd);
          sp = Math.min(MAX_V, Math.max(SERVE_V, sp * 1.03) + Math.min(Math.abs(owner.pv) * 0.12, 220));
          const ang = clamp(hit * 0.9 + owner.pv / 8000, -1.1, 1.1);
          vu = Math.sin(ang) * sp;
          vd = Math.cos(ang) * sp;
          d = PAD_D + PAD_HALF_T + R;
          this.lastTouch = owner.id;
          this.events.push(['hit', s]);
          changed = true;
        }
      }

      if (changed) {
        [b.x, b.y] = toWorld(s, u, d);
        [b.vx, b.vy] = velToWorld(s, vu, vd);
      }
    }
    return true;
  }

  exitChute() {
    const b = this.ball;
    const i = b.exit || 0;
    const c = this.chutes[i] || this.chutes[0];
    const cur = Math.hypot(b.vx, b.vy);
    let x = c.x, y = c.y, ang = rnd(0, Math.PI * 2), sp;
    if (c.type === 'warp') {
      // wormhole: pop out of a different chute in a random direction
      let j = Math.floor(Math.random() * (this.chutes.length - 1));
      if (j >= i) j++;
      x = this.chutes[j].x; y = this.chutes[j].y;
      sp = clamp(cur * 1.05, MIN_V, MAX_V);
    } else if (c.type === 'cannon') {
      // cannon: fire at a random opponent of whoever hit it last
      const alive = this.alivePlayers();
      let pool = alive.filter((p) => p.id !== this.lastTouch);
      if (!pool.length) pool = alive;
      if (pool.length) {
        const t = pool[Math.floor(Math.random() * pool.length)];
        const [tx, ty] = toWorld(t.side, 500, 0);
        ang = Math.atan2(ty - c.y, tx - c.x) + rnd(-0.12, 0.12);
      }
      sp = clamp(Math.max(cur * 1.25, 850), MIN_V, 1200);
    } else {
      // vault: gentle release at serve speed (also tames a runaway ball)
      sp = SERVE_V;
    }
    b.x = x + Math.cos(ang) * 30;
    b.y = y + Math.sin(ang) * 30;
    b.vx = Math.cos(ang) * sp;
    b.vy = Math.sin(ang) * sp;
    b.mode = 'live';
    b.cd = 0.4;
    this.events.push(['out', Math.round(x), Math.round(y), c.type]);
  }

  goal(victim) {
    victim.lives -= 1;
    const scorer = this.lastTouch && this.players.get(this.lastTouch);
    if (scorer && scorer.id !== victim.id) scorer.score += 10;
    this.events.push(['goal', victim.side]);
    if (victim.lives <= 0) { victim.alive = false; victim.lives = 0; }
    if (!this.checkOver()) this.resetBall();
  }

  checkOver() {
    if (this.phase !== 'playing') return this.phase === 'over';
    const alive = this.alivePlayers();
    if (alive.length > 1) return false;
    const everyone = [...this.players.values()].filter((p) => p.side >= 0);
    const winner = alive[0] || everyone.sort((a, b) => b.score - a.score)[0] || null;
    this.winnerId = winner ? winner.id : null;
    this.phase = 'over';
    this.ball.mode = 'serve'; this.ball.vx = 0; this.ball.vy = 0;
    this.events.push(['over']);
    return true;
  }

  // ---------- snapshots (what the host broadcasts) ----------

  snapshot(hostId) {
    const b = this.ball;
    const pads = [null, null, null, null];
    const pl = [];
    for (const p of this.players.values()) {
      if (p.side >= 0) pads[p.side] = round1(p.pu);
      pl.push({ id: p.id, n: p.name, s: p.side, l: p.lives, sc: p.score, a: p.alive ? 1 : 0, sp: p.spectator ? 1 : 0, g: p.gone ? 1 : 0 });
    }
    const snap = {
      ph: this.phase, cd: round1(this.phaseT),
      host: hostId, win: this.winnerId, lt: this.lastTouch,
      ball: { x: round1(b.x), y: round1(b.y), vx: round1(b.vx), vy: round1(b.vy), m: b.mode },
      pads, pl,
      ch: this.chutes.map((c) => [Math.round(c.x), Math.round(c.y), CHUTE_TYPES.indexOf(c.type)]),
      warn: this.chuteTimer < 1 && this.phase === 'playing' ? 1 : 0,
      ev: this.events,
    };
    this.events = [];
    return snap;
  }

  // Rebuild the game from the last snapshot, so a new host can carry on seamlessly
  restore(snap) {
    if (!snap) return;
    this.phase = snap.ph; this.phaseT = snap.cd || 0;
    this.winnerId = snap.win || null; this.lastTouch = snap.lt || null;
    const b = this.ball;
    b.x = snap.ball.x; b.y = snap.ball.y; b.vx = snap.ball.vx; b.vy = snap.ball.vy;
    b.mode = snap.ball.m === 'tube' ? 'live' : snap.ball.m; b.t = 1.0; b.cd = 0.4; b.exit = 0;
    this.chutes = snap.ch.map(([x, y, t]) => ({ x, y, type: CHUTE_TYPES[t] || 'warp' }));
    this.chuteTimer = 9;
    this.players.clear(); this.sideOwner = {};
    for (const p of snap.pl) {
      const pu = p.s >= 0 && snap.pads[p.s] != null ? snap.pads[p.s] : 500;
      this.players.set(p.id, { id: p.id, name: p.n, side: p.s, lives: p.l, score: p.sc, pu, tu: pu, pv: 0, alive: !!p.a, spectator: !!p.sp, gone: !!p.g });
      if (p.s >= 0) this.sideOwner[p.s] = p.id;
    }
  }
}
