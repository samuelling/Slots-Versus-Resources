// Networking for Pinball Party: host-runs-it, over the same tiny Cloudflare relay that
// Crush Commando and Brick Ninja use. The relay only passes messages around a room.
//
// The player who joined the room first is the host. Their phone runs the game (a Sim)
// and broadcasts snapshots; everyone else sends their paddle position to the host and
// draws what they get back. If the host leaves, the next-oldest player takes over from
// the last snapshot, so the game carries on.

import { Sim, MAX_PLAYERS } from './sim.js';

export const DEFAULT_SERVER = 'wss://crush-commando-mp.samuelling.workers.dev';

const SNAP_PLAYING = 1 / 30;   // snapshots per second while a game is running
const SNAP_IDLE = 0.25;        // ...and in the lobby / after a game
const MAX_MSG = 1900;          // the relay's messages stay under 2000 characters

export class Session {
  constructor({ server = DEFAULT_SERVER, code, name, onState, onClosed }) {
    this.server = server.replace(/\/$/, '');
    this.code = String(code).toUpperCase();
    this.name = String(name || 'Player').replace(/[^\p{L}\p{N} '\-.!?]/gu, '').trim().slice(0, 12) || 'Player';
    this.onState = onState || (() => {});
    this.onClosed = onClosed || (() => {});
    this.ws = null;
    this.myId = null;
    this.myN = 0;
    this.peers = new Map();   // id -> { id, n, name }
    this.joined = false;
    this.sim = null;          // only on the host
    this.snap = null;         // latest snapshot, host or guest
    this.timer = null;
    this.pingTimer = null;
    this.last = 0;
    this.acc = 0;
    this.forceSnap = false;
    this.closed = false;
  }

  get hostId() {
    let best = { id: this.myId, n: this.myN };
    for (const p of this.peers.values()) if (p.n < best.n) best = p;
    return best.id;
  }
  get isHost() { return this.joined && this.hostId === this.myId; }

  connect() {
    let ws;
    try { ws = new WebSocket(`${this.server}/room/pp-${this.code.toLowerCase()}`); }
    catch { this.finish('unreachable'); return; }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hi', name: this.name, col: 0 }));
      this.pingTimer = setInterval(() => { try { ws.send('ping'); } catch {} }, 20000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === 'pong' || this.ws !== ws) return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      this.onMsg(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.finish(ev.code === 4001 ? 'full' : this.joined ? 'lost' : 'unreachable');
    };
    ws.onerror = () => {};
  }

  leave() {
    const ws = this.ws; this.ws = null;
    this.closed = true;
    this.stopTimers();
    if (ws) { try { ws.close(1000, 'bye'); } catch {} }
  }

  finish(why) {
    if (this.closed) return;
    this.closed = true; this.ws = null; this.joined = false;
    this.stopTimers();
    this.onClosed(why);
  }

  stopTimers() {
    clearInterval(this.timer); clearInterval(this.pingTimer);
    this.timer = null; this.pingTimer = null;
  }

  send(o, to) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const s = JSON.stringify(to ? { t: 'ev', e: o, to } : { t: 'ev', e: o });
    if (s.length <= 2000) ws.send(s);
  }

  // ---------- incoming ----------

  onMsg(m) {
    switch (m.t) {
      case 'welcome': {
        const others = (m.peers || []).filter((p) => p && p.id);
        if (others.length >= MAX_PLAYERS) { this.leave(); this.onClosed('full'); return; }
        this.myId = m.id; this.myN = m.n;
        for (const p of others) this.peers.set(p.id, { id: p.id, n: p.n, name: p.name || 'Player' });
        this.joined = true;
        this.updateRole();
        return;
      }
      case 'join':
        this.peers.set(m.id, { id: m.id, n: m.n, name: m.name || 'Player' });
        if (this.sim) { this.sim.join(m.id, m.name || 'Player'); this.forceSnap = true; }
        return;
      case 'leave': {
        this.peers.delete(m.id);
        if (this.sim) { this.sim.leave(m.id); this.forceSnap = true; }
        this.updateRole();
        return;
      }
      case 'ev': {
        const e = m.e;
        if (!e || typeof e !== 'object') return;
        if (e.k === 's') {
          // a snapshot, accepted only from whoever is the host
          if (!this.sim && m.id === this.hostId) { this.snap = e; this.onState(e); }
        } else if (e.k === 'c' && this.sim) {
          this.sim.setControl(m.id, e);
        }
      }
    }
  }

  // become the host (or stay a guest) based on who has been in the room longest
  updateRole() {
    if (!this.joined) return;
    if (this.isHost && !this.sim) {
      const sim = new Sim();
      if (this.snap) sim.restore(this.snap);   // took over from a host who left
      sim.join(this.myId, this.name);
      const known = new Set([this.myId]);
      for (const p of this.peers.values()) { sim.join(p.id, p.name); known.add(p.id); }
      for (const id of [...sim.players.keys()]) if (!known.has(id)) sim.leave(id);
      this.sim = sim;
      this.last = performance.now(); this.acc = 0; this.forceSnap = true;
      this.timer = setInterval(() => this.tick(), 16);
      this.tick();
    }
  }

  // ---------- host loop ----------

  tick() {
    const sim = this.sim;
    if (!sim) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    sim.update(dt);
    this.acc += dt;
    const every = sim.phase === 'playing' || sim.phase === 'countdown' ? SNAP_PLAYING : SNAP_IDLE;
    if (this.forceSnap || this.acc >= every) {
      this.acc = 0; this.forceSnap = false;
      const snap = sim.snapshot(this.myId);
      snap.k = 's';
      this.snap = snap;
      if (this.peers.size) {
        let s = JSON.stringify({ t: 'ev', e: snap });
        if (s.length > MAX_MSG) { snap.ev = []; s = JSON.stringify({ t: 'ev', e: snap }); }
        if (this.ws && this.ws.readyState === 1) this.ws.send(s);
      }
      this.onState(snap);
    }
  }

  // ---------- actions from this phone ----------

  // c = { l, r, d, x, y, tx, ty }: flipper buttons, finger (0..1 across the arena), and phone tilt
  sendControl(c) {
    if (this.sim) { this.sim.setControl(this.myId, c); return; }
    if (!this.joined) return;
    const q = (v) => Math.round(v * 1000) / 1000;
    this.send({ k: 'c', l: c.l ? 1 : 0, r: c.r ? 1 : 0, d: c.d ? 1 : 0, x: q(c.x), y: q(c.y), tx: q(c.tx), ty: q(c.ty) }, this.hostId);
  }

  start() {
    if (this.sim && this.sim.start()) this.forceSnap = true;
  }

  again() {
    if (this.sim && this.sim.phase === 'over') { this.sim.toLobby(); this.forceSnap = true; }
  }
}
