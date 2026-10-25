// Pinball Party game engine. Pure logic: no networking, no timers, no DOM.
// The host's phone runs one Sim; everyone else just renders its snapshots.
//
// Every player has their own pinball TABLE (a portrait playfield with two flippers).
// Between the tables is the NULL ZONE: a shared virtual arena the ball is sent into
// when you shoot it out of the top of your table. In the null zone every player's
// phone controls a different weird gadget (a dog, a fan, a zapper, a bumper, or the
// tilt of the whole arena). What happens to the ball there carries into the next
// table: a manhandled ball arrives hot and fast and wobbly, a zapped ball arrives
// as slow goo that is easy to save.

// ---------- null zone ----------
export const W = 1000;            // the null zone is a W x W square in logical units
const R = 14;                     // ball radius (null zone and tables)
export const GATE_LO = 330;       // each player's gate spans u in [LO, HI] along their side
export const GATE_HI = 670;
const POST_R = 8;
const NZ_MIN_V = 240;
const SERVE_V = 430;
const MAX_V = 1500;

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

// roles: what each phone controls while the ball is in the null zone
export const ROLES = ['none', 'dog', 'fan', 'zap', 'tilt', 'bump'];
const BUMP_R = 38;
const DOG_LEN = 560, DOG_W = 48, DOG_A = 1500;
const FAN_LEN = 720, FAN_CONE = 0.5, FAN_A = 2300;
const TILT_G = 950;
const ZAP_CD = 6, GOO_TIME = 6;
const ROLE_SHUFFLE = 8;

// ---------- tables ----------
export const T = {
  W: 500, H: 1000,
  exitLo: 170, exitHi: 330,        // opening at the top that leads to the null zone
  // wall segments [x1, y1, x2, y2]: side walls, a dome that funnels to the exit, and rails to the flippers
  walls: [
    [0, 170, 0, 770], [500, 170, 500, 770],
    [0, 170, 40, 95], [40, 95, 110, 35], [110, 35, 170, 0],
    [500, 170, 460, 95], [460, 95, 390, 35], [390, 35, 330, 0],
    [0, 770, 122, 893], [500, 770, 378, 893],
  ],
  bumpers: [
    { x: 105, y: 340, r: 26 }, { x: 395, y: 340, r: 26 },
    { x: 170, y: 570, r: 20 }, { x: 330, y: 570, r: 20 },
  ],
  flippers: [
    { px: 130, py: 900, len: 100, rest: 0.55, up: -0.5 },
    { px: 370, py: 900, len: 100, rest: Math.PI - 0.55, up: Math.PI + 0.5 },
  ],
  flipR: 10,
};
const TABLE_G = 600;
const FLIP_W = 16;                 // flipper angular speed, rad/s
const TABLE_MAX_V = 1800;

// the null zone is painted in a random art style, re-rolled on every visit
export const STYLES = ['neon', 'pointillist', 'impressionist', 'medieval', 'pixel', 'comic'];

export const LIVES = 3;
export const MAX_PLAYERS = 4;

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
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// closest point on segment (x1,y1)-(x2,y2) to (px,py)
function closest(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
  return [x1 + dx * t, y1 + dy * t];
}

export class Sim {
  constructor() {
    this.players = new Map();   // id -> player
    this.phase = 'lobby';       // lobby | countdown | playing | over
    this.phaseT = 0;
    this.winnerId = null;
    this.sideOwner = {};        // side -> player id
    // w: 'n' ball flying in the null zone, 't' on a table, 's' waiting to be served, 'u' inside a chute
    this.ball = { w: 's', x: 500, y: 500, vx: 0, vy: 0, t: 0, cd: 0, exit: 0, goo: 0, heat: 0, o: null };
    this.sender = null;         // who last shot the ball out of their table
    this.chutes = [];
    this.chuteTimer = 0;
    this.rolesT = 0;
    this.tilt = [0, 0];
    this.stall = 0;
    this.serveFlip = false;
    this.style = 0;
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
      side: -1, lives: LIVES, score: 0, alive: true, gone: false,
      spectator: this.phase !== 'lobby' || this.lobbyCount() >= MAX_PLAYERS,
      fa: [T.flippers[0].rest, T.flippers[1].rest], fw: [0, 0],
      ctl: { l: 0, r: 0, x: 0.5, y: 0.5, d: 0, tx: 0, ty: 0 },
      role: 0, aim: 0, zapCd: 0, tap: false, bx: 500, by: 500,
    });
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby' || p.side < 0) { this.players.delete(id); return; }
    // mid-game: their gate becomes a wall
    p.gone = true; p.role = 0;
    if (p.alive) { p.alive = false; p.lives = 0; }
    if (this.phase === 'playing') {
      if (this.ball.w === 't' && this.ball.o === id) this.resetBall();
      this.checkOver();
    }
  }

  setControl(id, c) {
    const p = this.players.get(id);
    if (!p || p.side < 0 || !c) return;
    const d = c.d ? 1 : 0;
    if (d && !p.ctl.d) p.tap = true;
    p.ctl = {
      l: c.l ? 1 : 0, r: c.r ? 1 : 0, d,
      x: clamp(num(c.x, 0.5), 0, 1), y: clamp(num(c.y, 0.5), 0, 1),
      tx: clamp(num(c.tx), -1, 1), ty: clamp(num(c.ty), -1, 1),
    };
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
      p.side = sides[i]; p.lives = LIVES; p.score = 0; p.alive = true; p.role = 0;
      p.fa = [T.flippers[0].rest, T.flippers[1].rest]; p.fw = [0, 0];
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
    this.sender = null;
    for (const [id, p] of [...this.players]) {
      if (p.gone) { this.players.delete(id); continue; }
      p.side = -1; p.lives = LIVES; p.score = 0; p.alive = true; p.spectator = false; p.role = 0;
    }
    let n = 0;
    for (const p of this.players.values()) { if (++n > MAX_PLAYERS) p.spectator = true; }
    this.resetBall();
  }

  seated() {
    return [...this.players.values()].filter((p) => p.side >= 0 && !p.gone);
  }
  alivePlayers() {
    return [...this.players.values()].filter((p) => p.side >= 0 && p.alive);
  }

  rollStyle() {
    this.style = (this.style + 1 + Math.floor(Math.random() * (STYLES.length - 1))) % STYLES.length;
  }

  resetBall() {
    this.rollStyle();
    const b = this.ball;
    // serve from just above or below the centre bumper (alternating), never from inside it
    this.serveFlip = !this.serveFlip;
    Object.assign(b, { w: 's', x: 500, y: this.serveFlip ? 380 : 620, vx: 0, vy: 0, t: 1.6, cd: 0, goo: 0, heat: 0, o: null });
    this.sender = null;
    this.tilt = [0, 0];
    this.assignRoles();
  }

  launch() {
    const b = this.ball;
    const alive = this.alivePlayers();
    let ang = rnd(0, Math.PI * 2);
    if (alive.length) {
      const target = alive[Math.floor(Math.random() * alive.length)];
      const [tx, ty] = toWorld(target.side, 500, 0);
      ang = Math.atan2(ty - b.y, tx - b.x) + rnd(-0.7, 0.7);
    }
    b.vx = Math.cos(ang) * SERVE_V;
    b.vy = Math.sin(ang) * SERVE_V;
    b.w = 'n';
  }

  // Everybody (even knocked-out players: they become meddling ghosts) gets something odd to control.
  assignRoles() {
    this.rolesT = ROLE_SHUFFLE;
    const ps = this.seated();
    let zap = 0, tilt = 0;
    const tiltOk = Math.random() < 0.45;
    for (const p of ps) {
      const pool = [['dog', 3], ['fan', 3], ['bump', 2.5]];
      if (!zap) pool.push(['zap', 2]);
      if (!tilt && tiltOk) pool.push(['tilt', 2.5]);
      let r = Math.random() * pool.reduce((a, q) => a + q[1], 0), pick = pool[0][0];
      for (const q of pool) { if ((r -= q[1]) <= 0) { pick = q[0]; break; } }
      if (pick === 'zap') zap++;
      if (pick === 'tilt') tilt++;
      p.role = ROLES.indexOf(pick);
      p.aim = 0; p.zapCd = Math.min(p.zapCd, 1.5); p.tap = false;
      [p.bx, p.by] = toWorld(p.side, 500, 260);
    }
    this.events.push(['roles']);
  }

  update(dt) {
    const onTable = this.ball.w === 't' ? this.ball.o : null;
    for (const p of this.players.values()) {
      if (p.zapCd > 0) p.zapCd = Math.max(0, p.zapCd - dt);
      if (p.side >= 0 && p.id !== onTable) this.flipStep(p, dt);
    }
    if (this.phase === 'countdown') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.phase = 'playing'; this.phaseT = 0; this.chuteTimer = 9; }
      return;
    }
    if (this.phase !== 'playing') return;

    const nz = this.ball.w !== 't';
    if (nz) {
      this.rolesT -= dt;
      if (this.rolesT <= 0) { this.assignRoles(); }
      this.chuteTimer -= dt;
      if (this.chuteTimer <= 0 && this.ball.w !== 'u') {
        this.placeChutes();
        this.chuteTimer = 9;
        this.events.push(['shuffle']);
      }
      this.updateGadgets(dt);
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

  // ---------- null zone: gadgets ----------

  updateGadgets(dt) {
    let gx = 0, gy = 0;
    for (const p of this.seated()) {
      const role = ROLES[p.role];
      if (role === 'dog' || role === 'fan') {
        const target = (p.ctl.x - 0.5) * 2 * 1.05;
        p.aim += (target - p.aim) * Math.min(1, dt * 12);
      } else if (role === 'bump') {
        const [tx, ty] = toWorld(p.side, p.ctl.x * W, (1 - p.ctl.y) * W);
        const k = Math.min(1, dt * 16);
        p.bx = clamp(p.bx + (clamp(tx, 70, 930) - p.bx) * k, 70, 930);
        p.by = clamp(p.by + (clamp(ty, 70, 930) - p.by) * k, 70, 930);
      } else if (role === 'zap') {
        if (p.tap && p.zapCd <= 0 && this.ball.w !== 't' && this.ball.w !== 's') {
          this.ball.goo = GOO_TIME; this.ball.heat = 0;
          p.zapCd = ZAP_CD;
          this.events.push(['zap', p.side]);
        }
      } else if (role === 'tilt') {
        const [wx, wy] = velToWorld(p.side, p.ctl.tx, -p.ctl.ty);
        gx += wx * TILT_G; gy += wy * TILT_G;
      }
      p.tap = false;
    }
    this.tilt = [round1(gx / TILT_G), round1(gy / TILT_G)];
    this.gravity = [gx, gy];
  }

  // forces on the null-zone ball from dogs, fans and tilt
  forces(b) {
    let ax = this.gravity ? this.gravity[0] : 0, ay = this.gravity ? this.gravity[1] : 0;
    let exposed = 0;
    for (const p of this.seated()) {
      const role = ROLES[p.role];
      if (role !== 'dog' && role !== 'fan') continue;
      const [ox, oy] = toWorld(p.side, 500, 90);
      const [dx, dy] = velToWorld(p.side, Math.sin(p.aim), Math.cos(p.aim));
      const rx = b.x - ox, ry = b.y - oy;
      const along = rx * dx + ry * dy;
      if (role === 'dog') {
        if (along > 0 && along < DOG_LEN) {
          const perp = Math.abs(rx * dy - ry * dx);
          if (perp < DOG_W) { ax += dx * DOG_A; ay += dy * DOG_A; exposed = 1; }
        }
      } else {
        const dist = Math.hypot(rx, ry);
        if (dist > 1 && dist < FAN_LEN && along / dist > Math.cos(FAN_CONE)) {
          const k = (p.ctl.d ? 1 : 0.4) * FAN_A * (1 - dist / FAN_LEN);
          ax += (rx / dist) * k; ay += (ry / dist) * k; exposed = 1;
        }
      }
    }
    return [ax, ay, exposed];
  }

  // ---------- ball stepping ----------

  stepBallFrame(dt) {
    const b = this.ball;
    if (b.cd > 0) b.cd -= dt;
    if (b.goo > 0) b.goo = Math.max(0, b.goo - dt);
    if (b.w === 's') {
      b.t -= dt;
      if (b.t <= 0) this.launch();
    } else if (b.w === 'u') {
      b.t -= dt;
      if (b.t <= 0) this.exitChute();
    } else if (b.w === 't') {
      this.stepTable(dt);
    } else {
      this.stepNull(dt);
    }
  }

  stepNull(dt) {
    const b = this.ball;
    const [ax, ay, exposed] = this.forces(b);
    b.vx += ax * dt; b.vy += ay * dt;
    if (exposed) b.heat = Math.min(1, b.heat + 0.5 * dt);
    b.heat = Math.max(0, b.heat - 0.05 * dt);
    if (b.goo > 0) {
      const k = Math.exp(-2.2 * dt);
      b.vx *= k; b.vy *= k;
      const s = Math.hypot(b.vx, b.vy);
      if (s > 260) { b.vx *= 260 / s; b.vy *= 260 / s; }
    }
    const sp = Math.hypot(b.vx, b.vy);
    const n = Math.max(1, Math.ceil((sp * dt) / 7));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (!this.stepNullBall(h)) return;
    }
    const s2 = Math.hypot(b.vx, b.vy);
    const lim = b.goo > 0 ? 70 : NZ_MIN_V;
    if (s2 < lim) {
      if (s2 < 1) { const a = rnd(0, 6.28); b.vx = Math.cos(a) * lim; b.vy = Math.sin(a) * lim; }
      else { b.vx *= lim / s2; b.vy *= lim / s2; }
    }
    if (s2 > MAX_V) { b.vx *= MAX_V / s2; b.vy *= MAX_V / s2; }
  }

  // returns false if the ball left the null zone (gate or chute)
  stepNullBall(h) {
    const b = this.ball;
    b.x += b.vx * h;
    b.y += b.vy * h;

    // bumpers: fixed ones plus the ones people are steering around
    const bumpers = BUMPERS.slice();
    for (const p of this.seated()) if (ROLES[p.role] === 'bump') bumpers.push({ x: p.bx, y: p.by, r: BUMP_R, owner: p });
    for (const bm of bumpers) {
      const dx = b.x - bm.x, dy = b.y - bm.y;
      const dist = Math.hypot(dx, dy);
      const min = R + bm.r;
      if (dist < min && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        b.x = bm.x + nx * min; b.y = bm.y + ny * min;
        const dot = b.vx * nx + b.vy * ny;
        if (dot < 0) {
          b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny;
          const cur = Math.hypot(b.vx, b.vy) || 1;
          const sp = Math.min(MAX_V, cur * 1.04 + (b.goo > 0 ? 0 : 40));
          b.vx *= sp / cur; b.vy *= sp / cur;
          if (b.goo <= 0) b.heat = Math.min(1, b.heat + (bm.owner ? 0.2 : 0.1));
          const who = bm.owner || (this.sender && this.players.get(this.sender));
          if (who) who.score += 1;
          this.events.push(['bump', Math.round(bm.x), Math.round(bm.y)]);
        }
      }
    }

    // chutes
    if (b.cd <= 0) {
      for (let i = 0; i < this.chutes.length; i++) {
        const c = this.chutes[i];
        if (Math.hypot(b.x - c.x, b.y - c.y) < 24) {
          b.w = 'u'; b.exit = i;
          b.t = c.type === 'cannon' ? 0.6 : c.type === 'vault' ? 1.0 : rnd(0.35, 0.8);
          b.x = c.x; b.y = c.y;
          if (c.type === 'vault') {
            const lt = this.sender && this.players.get(this.sender);
            if (lt) lt.score += VAULT_POINTS;
            this.events.push(['vault', VAULT_POINTS, lt ? lt.side : -1]);
          }
          this.events.push(['chute', i, c.type]);
          return false;
        }
      }
    }

    // walls, gates, gate posts
    for (let s = 0; s < 4; s++) {
      const ownerId = this.sideOwner[s];
      const owner = ownerId && this.players.get(ownerId);
      const open = !!(owner && owner.alive);
      let [u, d] = toLocal(s, b.x, b.y);
      let [vu, vd] = velToLocal(s, b.vx, b.vy);
      let changed = false;

      if (d < R) {
        if (open && u >= GATE_LO && u <= GATE_HI) {
          if (d < -R * 0.5) { this.enterTable(owner, u, vu, vd); return false; }
        } else {
          d = R; if (vd < 0) vd = -vd; changed = true;
        }
      }
      if (open) {
        for (const pu of [GATE_LO, GATE_HI]) {
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
      sp = clamp(cur * 1.05, NZ_MIN_V, MAX_V);
      b.heat = Math.min(1, b.heat + 0.2);
    } else if (c.type === 'cannon') {
      // cannon: fire at a random opponent of whoever shot the ball here
      const alive = this.alivePlayers();
      let pool = alive.filter((p) => p.id !== this.sender);
      if (!pool.length) pool = alive;
      if (pool.length) {
        const t = pool[Math.floor(Math.random() * pool.length)];
        const [tx, ty] = toWorld(t.side, 500, 0);
        ang = Math.atan2(ty - c.y, tx - c.x) + rnd(-0.12, 0.12);
      }
      sp = clamp(Math.max(cur * 1.25, 850), NZ_MIN_V, 1200);
      b.heat = Math.min(1, b.heat + 0.5);
    } else {
      // vault: gentle release at serve speed (also tames a runaway ball)
      sp = SERVE_V;
      b.heat = Math.max(0, b.heat - 0.3);
    }
    b.x = x + Math.cos(ang) * 30;
    b.y = y + Math.sin(ang) * 30;
    b.vx = Math.cos(ang) * sp;
    b.vy = Math.sin(ang) * sp;
    b.w = 'n';
    b.cd = 0.4;
    this.events.push(['out', Math.round(x), Math.round(y), c.type]);
  }

  // ---------- tables ----------

  // The ball has gone through someone's gate. How it arrives depends on what happened in the null zone.
  enterTable(owner, u, vu, vd) {
    const b = this.ball;
    const goo = b.goo > 0;
    const mult = goo ? 0.55 : 0.85 + 0.75 * b.heat;          // hot balls come in fast, goo comes in slow
    b.w = 't'; b.o = owner.id; b.cd = 0;
    b.x = clamp(T.exitLo + ((u - GATE_LO) / (GATE_HI - GATE_LO)) * (T.exitHi - T.exitLo), T.exitLo + 25, T.exitHi - 25);
    b.y = 18;
    b.vx = clamp(vu * 0.5 * mult, -500, 500);
    b.vy = clamp(-vd * mult, goo ? 200 : 330, 1500);
    this.stall = 0; b.tt = 0;
    this.events.push(['enter', owner.side]);
  }

  exitTable(owner) {
    const b = this.ball;
    const u = GATE_LO + ((clamp(b.x, T.exitLo, T.exitHi) - T.exitLo) / (T.exitHi - T.exitLo)) * (GATE_HI - GATE_LO);
    const vd = clamp(-b.vy, 450, 1300);
    const vu = clamp(b.vx * 1.2, -0.8 * vd, 0.8 * vd);
    [b.x, b.y] = toWorld(owner.side, u, 50);
    [b.vx, b.vy] = velToWorld(owner.side, vu, vd);
    b.w = 'n'; b.o = null; b.cd = 0;
    b.heat = Math.max(b.heat, 0.15);
    this.sender = owner.id;
    this.rollStyle();
    this.assignRoles();
    this.events.push(['exit', owner.side]);
  }

  drain(owner) {
    owner.lives -= 1;
    const sender = this.sender && this.players.get(this.sender);
    if (sender && sender.id !== owner.id) sender.score += 10 + (this.ball.heat > 0.6 ? 5 : 0);
    this.events.push(['drain', owner.side]);
    if (owner.lives <= 0) { owner.alive = false; owner.lives = 0; }
    if (!this.checkOver()) this.resetBall();
  }

  // advance one player's flippers toward their button state
  flipStep(p, h) {
    for (let i = 0; i < 2; i++) {
      const f = T.flippers[i];
      const target = (i === 0 ? p.ctl.l : p.ctl.r) ? f.up : f.rest;
      const step = clamp(target - p.fa[i], -FLIP_W * h, FLIP_W * h);
      p.fa[i] += step;
      p.fw[i] = step / h;
    }
  }

  hitSeg(b, x1, y1, x2, y2, rad, e, svx = 0, svy = 0) {
    const [cx, cy] = closest(b.x, b.y, x1, y1, x2, y2);
    const dx = b.x - cx, dy = b.y - cy;
    const dist = Math.hypot(dx, dy);
    const min = R + rad;
    if (dist >= min) return false;
    let nx, ny;
    if (dist > 0.0001) { nx = dx / dist; ny = dy / dist; }
    else { nx = 0; ny = -1; }
    b.x = cx + nx * min; b.y = cy + ny * min;
    const rvx = b.vx - svx, rvy = b.vy - svy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      b.vx = svx + rvx - (1 + e) * vn * nx;
      b.vy = svy + rvy - (1 + e) * vn * ny;
    }
    return true;
  }

  stepTable(dt) {
    const b = this.ball;
    const owner = this.players.get(b.o);
    if (!owner || !owner.alive) { this.resetBall(); return; }
    const goo = b.goo > 0;
    const sp0 = Math.hypot(b.vx, b.vy);
    const n = clamp(Math.ceil((sp0 * dt) / 4), 1, 12);
    const h = dt / n;
    // goo is heavy and sluggish; a hot ball wobbles side to side
    b.tt = (b.tt || 0) + dt;
    const g = TABLE_G * (goo ? 1.35 : 1) * (1 + clamp((b.tt - 15) / 20, 0, 0.9));   // long rallies get heavier
    const wobble = !goo && b.heat > 0.25 ? Math.sin(performance_now() * 0.011) * 520 * b.heat : 0;
    for (let i = 0; i < n; i++) {
      this.flipStep(owner, h);
      b.vy += g * h;
      b.vx += wobble * h;
      b.x += b.vx * h; b.y += b.vy * h;

      for (const w of T.walls) this.hitSeg(b, w[0], w[1], w[2], w[3], 0, 0.55);
      for (const bm of T.bumpers) {
        const dx = b.x - bm.x, dy = b.y - bm.y;
        const dist = Math.hypot(dx, dy), min = R + bm.r;
        if (dist < min && dist > 0.001) {
          const nx = dx / dist, ny = dy / dist;
          b.x = bm.x + nx * min; b.y = bm.y + ny * min;
          const dot = b.vx * nx + b.vy * ny;
          if (dot < 0) {
            b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny;
            const cur = Math.hypot(b.vx, b.vy) || 1;
            const sp = Math.min(TABLE_MAX_V, cur * 1.02 + (goo ? 0 : 90));
            b.vx *= sp / cur; b.vy *= sp / cur;
            owner.score += 1;
            this.events.push(['tbump', Math.round(bm.x), Math.round(bm.y)]);
          }
        }
      }
      for (let k = 0; k < 2; k++) {
        const f = T.flippers[k], a = owner.fa[k], w = owner.fw[k];
        const tx = f.px + Math.cos(a) * f.len, ty = f.py + Math.sin(a) * f.len;
        const [cx, cy] = closest(b.x, b.y, f.px, f.py, tx, ty);
        const rx = cx - f.px, ry = cy - f.py;
        const hit = this.hitSeg(b, f.px, f.py, tx, ty, T.flipR, 0.3, -w * ry, w * rx);
        if (hit && Math.abs(w) > 1) this.events.push(['flip', owner.side]);
      }

      if (b.y < -R * 0.5 && b.x >= T.exitLo && b.x <= T.exitHi) { this.exitTable(owner); return; }
      if (b.y > T.H + 40) { this.drain(owner); return; }
    }
    // keep the ball inside the table and under the speed limit
    if (b.x < -20 || b.x > T.W + 20 || b.y < -30) { b.x = 250; b.y = 40; b.vx = 0; b.vy = 200; }
    const cap = goo ? 420 : TABLE_MAX_V;
    const s = Math.hypot(b.vx, b.vy);
    if (s > cap) { b.vx *= cap / s; b.vy *= cap / s; }
    b.heat = Math.max(0, b.heat - 0.06 * dt);
    // a ball that stops dead somewhere gets a nudge
    if (s < 25) { this.stall += dt; if (this.stall > 2.5) { b.vy = -650; b.vx = rnd(-150, 150); this.stall = 0; } }
    else this.stall = 0;
  }

  checkOver() {
    if (this.phase !== 'playing') return this.phase === 'over';
    const alive = this.alivePlayers();
    if (alive.length > 1) return false;
    const everyone = this.seated();
    const winner = alive[0] || everyone.sort((a, b) => b.score - a.score)[0] || null;
    this.winnerId = winner ? winner.id : null;
    this.phase = 'over';
    Object.assign(this.ball, { w: 's', vx: 0, vy: 0, o: null });
    for (const p of this.players.values()) p.role = 0;
    this.events.push(['over']);
    return true;
  }

  // ---------- snapshots (what the host broadcasts) ----------

  rolePack(p) {
    const role = ROLES[p.role];
    if (role === 'dog' || role === 'fan') return [Math.round(p.aim * 100), p.ctl.d ? 1 : 0];
    if (role === 'bump') return [Math.round(p.bx), Math.round(p.by)];
    if (role === 'zap') return [Math.round(p.zapCd * 10), 0];
    if (role === 'tilt') return [Math.round(this.tilt[0] * 100), Math.round(this.tilt[1] * 100)];
    return [0, 0];
  }

  snapshot(hostId) {
    const b = this.ball;
    const owner = b.w === 't' ? this.players.get(b.o) : null;
    const pl = [];
    for (const p of this.players.values()) {
      pl.push({
        id: p.id, n: p.name, s: p.side, l: p.lives, sc: p.score, a: p.alive ? 1 : 0, sp: p.spectator ? 1 : 0, g: p.gone ? 1 : 0,
        r: p.role, p: this.rolePack(p), f: [Math.round(p.fa[0] * 100), Math.round(p.fa[1] * 100)],
      });
    }
    const snap = {
      ph: this.phase, st: this.style, cd: round1(this.phaseT), host: hostId, win: this.winnerId, snd: this.sender,
      ball: {
        w: b.w, x: round1(b.x), y: round1(b.y), vx: round1(b.vx), vy: round1(b.vy),
        o: owner ? owner.side : -1, h: Math.round(b.heat * 100), g: round1(b.goo),
      },
      pl,
      ch: this.chutes.map((c) => [Math.round(c.x), Math.round(c.y), CHUTE_TYPES.indexOf(c.type)]),
      warn: this.chuteTimer < 1 && this.phase === 'playing' && b.w !== 't' ? 1 : 0,
      ev: this.events,
    };
    this.events = [];
    return snap;
  }

  // Rebuild the game from the last snapshot, so a new host can carry on seamlessly
  restore(snap) {
    if (!snap) return;
    this.phase = snap.ph; this.phaseT = snap.cd || 0;
    this.style = snap.st || 0;
    this.winnerId = snap.win || null; this.sender = snap.snd || null;
    this.players.clear(); this.sideOwner = {};
    for (const p of snap.pl) {
      const np = {
        id: p.id, name: p.n, side: p.s, lives: p.l, score: p.sc, alive: !!p.a, spectator: !!p.sp, gone: !!p.g,
        fa: [(p.f[0] || 0) / 100, (p.f[1] || 0) / 100], fw: [0, 0],
        ctl: { l: 0, r: 0, x: 0.5, y: 0.5, d: 0, tx: 0, ty: 0 },
        role: p.r || 0, aim: 0, zapCd: 0, tap: false, bx: 500, by: 500,
      };
      const role = ROLES[np.role];
      if (role === 'dog' || role === 'fan') np.aim = (p.p[0] || 0) / 100;
      if (role === 'bump') { np.bx = p.p[0]; np.by = p.p[1]; }
      if (role === 'zap') np.zapCd = (p.p[0] || 0) / 10;
      this.players.set(p.id, np);
      if (p.s >= 0) this.sideOwner[p.s] = p.id;
    }
    const b = this.ball, sb = snap.ball;
    Object.assign(b, { w: sb.w === 'u' ? 'n' : sb.w, x: sb.x, y: sb.y, vx: sb.vx, vy: sb.vy, t: 1.0, cd: 0.4, exit: 0, goo: sb.g || 0, heat: (sb.h || 0) / 100, o: null });
    if (b.w === 't') { b.o = this.sideOwner[sb.o] || null; if (!b.o) this.resetBall(); }
    this.chutes = snap.ch.map(([x, y, t]) => ({ x, y, type: CHUTE_TYPES[t] || 'warp' }));
    this.chuteTimer = 9; this.rolesT = ROLE_SHUFFLE;
  }
}

// a tiny clock for the hot-ball wobble (works in browsers and Node)
function performance_now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
