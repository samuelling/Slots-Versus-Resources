// One Durable Object per room code. It owns the whole game: physics, rules, and
// the WebSocket fan-out. Phones only send paddle positions and render snapshots.

const W = 1000;          // arena is a W x W square in logical units
const R = 14;            // ball radius
const MOUTH_LO = 220;    // goal mouth spans u in [LO, HI] along each active side
const MOUTH_HI = 780;
const PAD_HALF = 100;    // paddle half-width
const PAD_D = 44;        // paddle centre distance from the edge
const PAD_HALF_T = 8;    // paddle half-thickness
const PAD_MIN = MOUTH_LO + PAD_HALF;
const PAD_MAX = MOUTH_HI - PAD_HALF;
const POST_R = 8;
const MIN_V = 320;
const SERVE_V = 400;
const MAX_V = 1500;
const LIVES = 3;
const TICK_MS = 16;
const GRACE_MS = 20000;  // how long a dropped player keeps their seat

const BUMPERS = [
  { x: 500, y: 500, r: 52 },
  { x: 330, y: 340, r: 32 },
  { x: 670, y: 340, r: 32 },
  { x: 330, y: 660, r: 32 },
  { x: 670, y: 660, r: 32 },
];

// three chutes, each a different portal type (positions shuffle, types persist by index)
const CHUTE_TYPES = ['warp', 'cannon', 'vault'];
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

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = '';
    this.players = new Map();   // id -> player
    this.hostId = null;
    this.phase = 'lobby';       // lobby | countdown | playing | over
    this.phaseT = 0;
    this.winnerId = null;
    this.sideOwner = {};        // side -> player id
    this.ball = { x: 500, y: 500, vx: 0, vy: 0, mode: 'serve', t: 0, cd: 0, exit: 0 };
    this.lastTouch = null;      // player id
    this.chutes = [];
    this.chuteTimer = 0;
    this.events = [];
    this.timer = null;
    this.last = 0;
    this.frame = 0;
    this.placeChutes();
  }

  // ---------- networking ----------

  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/\/ws\/([A-Za-z0-9]+)/);
    if (m) this.code = m[1].toUpperCase();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    let me = null;
    server.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      me = this.onMessage(server, me, msg) || me;
    });
    const drop = () => { if (me) this.onDisconnect(me, server); };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, me, msg) {
    switch (msg.t) {
      case 'hello': return this.onHello(ws, msg);
      case 'paddle':
        if (me && typeof msg.u === 'number' && me.side >= 0) {
          me.tu = clamp(msg.u, PAD_MIN, PAD_MAX);
        }
        return null;
      case 'start':
        if (me && me.id === this.hostId && this.phase === 'lobby') this.startGame();
        return null;
      case 'again':
        if (me && me.id === this.hostId && this.phase === 'over') this.toLobby();
        return null;
      default:
        return null;
    }
  }

  onHello(ws, msg) {
    const name = String(msg.name || 'Player').replace(/[^\w \-.!?]/g, '').slice(0, 12) || 'Player';
    let p = msg.id && this.players.get(String(msg.id));
    if (p) {
      try { p.ws && p.ws !== ws && p.ws.close(1000, 'replaced'); } catch {}
      p.ws = ws; p.on = true; p.offAt = 0;
      if (msg.name) p.name = name;
    } else {
      p = {
        id: crypto.randomUUID().slice(0, 8), name, ws, on: true, offAt: 0,
        side: -1, lives: LIVES, score: 0, pu: 500, tu: 500, pv: 0, alive: true,
        spectator: this.phase !== 'lobby' || this.lobbyCount() >= 4,
      };
      this.players.set(p.id, p);
    }
    if (!this.hostId || !this.players.get(this.hostId)?.on) this.hostId = p.id;
    this.send(ws, { t: 'welcome', id: p.id, code: this.code });
    this.ensureTimer();
    this.broadcast(true);
    return p;
  }

  onDisconnect(p, ws) {
    if (p.ws !== ws) return;
    p.on = false;
    p.offAt = Date.now();
    if (this.phase === 'lobby') this.players.delete(p.id);
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find((q) => q.on && !q.spectator);
      this.hostId = next ? next.id : null;
    }
    this.broadcast(true);
  }

  lobbyCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.spectator) n++;
    return n;
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  broadcast(force) {
    const payload = JSON.stringify(this.snapshot());
    this.events = [];
    for (const p of this.players.values()) {
      if (p.on && p.ws) { try { p.ws.send(payload); } catch {} }
    }
  }

  snapshot() {
    const b = this.ball;
    const pads = [null, null, null, null];
    const pl = [];
    for (const p of this.players.values()) {
      if (p.side >= 0) pads[p.side] = round1(p.pu);
      pl.push({ id: p.id, n: p.name, s: p.side, l: p.lives, sc: p.score, on: p.on ? 1 : 0, a: p.alive ? 1 : 0, sp: p.spectator ? 1 : 0 });
    }
    return {
      t: 's', code: this.code, ph: this.phase, cd: round1(this.phaseT),
      host: this.hostId, win: this.winnerId, lt: this.lastTouch,
      ball: { x: round1(b.x), y: round1(b.y), vx: round1(b.vx), vy: round1(b.vy), m: b.mode },
      pads, pl,
      ch: this.chutes.map((c) => [Math.round(c.x), Math.round(c.y), CHUTE_TYPES.indexOf(c.type)]),
      warn: this.chuteTimer < 1 && this.phase === 'playing' ? 1 : 0,
      ev: this.events,
    };
  }

  ensureTimer() {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    const anyOn = [...this.players.values()].some((p) => p.on);
    if (!anyOn) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.phase !== 'lobby') this.toLobby();
      return;
    }
    const now = Date.now();
    const dt = clamp((now - this.last) / 1000, 0.001, 0.05);
    this.last = now;
    this.update(dt, now);
    this.frame++;
    if (this.frame % 2 === 0) this.broadcast();
  }

  // ---------- game flow ----------

  startGame() {
    const seated = [...this.players.values()].filter((p) => p.on && !p.spectator);
    if (seated.length < 2) return;
    const sides = SIDE_SETS[Math.min(4, seated.length)];
    this.sideOwner = {};
    seated.slice(0, 4).forEach((p, i) => {
      p.side = sides[i]; p.lives = LIVES; p.score = 0; p.alive = true; p.pu = 500; p.tu = 500; p.pv = 0;
      this.sideOwner[p.side] = p.id;
    });
    for (const p of this.players.values()) if (!seated.includes(p)) { p.spectator = true; p.side = -1; }
    this.winnerId = null;
    this.placeChutes();
    this.resetBall();
    this.phase = 'countdown';
    this.phaseT = 3.5;
  }

  toLobby() {
    this.phase = 'lobby';
    this.winnerId = null;
    this.sideOwner = {};
    this.lastTouch = null;
    for (const [id, p] of [...this.players]) {
      if (!p.on) { this.players.delete(id); continue; }
      p.side = -1; p.lives = LIVES; p.score = 0; p.alive = true; p.spectator = false; p.pv = 0;
    }
    let n = 0;
    for (const p of this.players.values()) { if (++n > 4) p.spectator = true; }
    if (!this.players.get(this.hostId)?.on) {
      const next = [...this.players.values()].find((p) => p.on);
      this.hostId = next ? next.id : null;
    }
    this.resetBall();
    this.broadcast(true);
  }

  alivePlayers() {
    return [...this.players.values()].filter((p) => p.side >= 0 && p.alive);
  }

  resetBall() {
    const b = this.ball;
    b.x = 500; b.y = 500; b.vx = 0; b.vy = 0; b.mode = 'serve'; b.t = 1.6; b.cd = 0;
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

  update(dt, now) {
    // paddles chase their targets at a capped speed; velocity feeds the smash
    for (const p of this.players.values()) {
      if (p.side < 0) continue;
      const old = p.pu;
      const step = clamp(p.tu - p.pu, -3500 * dt, 3500 * dt);
      p.pu += step;
      p.pv = p.pv * 0.6 + 0.4 * ((p.pu - old) / dt);
      if (!p.on && p.offAt && now - p.offAt > GRACE_MS && p.alive && this.phase === 'playing') {
        p.alive = false; p.lives = 0;
        this.checkOver();
      }
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
}
