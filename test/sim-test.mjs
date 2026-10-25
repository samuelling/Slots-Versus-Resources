// Engine checks: tables, the null zone, roles, and how the null zone changes the next table.
import { Sim, ROLES, T, GATE_LO, GATE_HI } from '../sim.js';

let failed = false;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed = true; };

const mk = (n) => {
  const r = new Sim();
  for (let i = 0; i < n; i++) r.join('p' + i, 'P' + i);
  r.start();
  return r;
};
const playing = (n) => { const r = mk(n); r.phase = 'playing'; r.phaseT = 0; r.chuteTimer = 999; r.rolesT = 999; return r; };
const finite = (b) => [b.x, b.y, b.vx, b.vy].every(Number.isFinite);

// a simple flipper bot: swing when the ball is down by a flipper
function bot(r, skill = 1) {
  const b = r.ball;
  for (const p of r.players.values()) {
    if (p.side < 0) continue;
    const mine = b.w === 't' && b.o === p.id;
    const near = mine && b.y > 760 && b.vy > -50;
    const ok = Math.random() < skill;
    r.setControl(p.id, { l: near && ok && b.x < 270 ? 1 : 0, r: near && ok && b.x >= 230 ? 1 : 0, x: 0.5 + Math.sin(performance.now() / 700 + p.side) * 0.4, y: 0.5, d: Math.random() < 0.05 ? 1 : 0, tx: 0, ty: 0 });
  }
}

// 1. idle players: the ball goes out, into tables, drains, game ends
for (const n of [2, 3, 4]) {
  const r = mk(n);
  let t = 0, bad = false; const seen = { enter: 0, drain: 0, exit: 0 };
  while (r.phase !== 'over' && t < 1800) {
    r.update(1 / 60);
    if (!finite(r.ball)) { bad = true; break; }
    for (const e of r.events) if (e[0] in seen) seen[e[0]]++;
    r.events = []; t += 1 / 60;
  }
  const alive = [...r.players.values()].filter((p) => p.alive).length;
  check(r.phase === 'over' && !bad && alive === 1, `${n} idle players: ball visits tables and the game ends in a win (${t.toFixed(0)}s, ${seen.enter} entries, ${seen.drain} drains)`);
}

// 2. players who flip: the ball should make it back out of the table into the null zone
{
  const r = mk(3);
  let t = 0, bad = false; const seen = { enter: 0, drain: 0, exit: 0, flip: 0, tbump: 0 };
  while (r.phase !== 'over' && t < 600) {
    bot(r, 0.25);
    r.update(1 / 60);
    if (!finite(r.ball)) { bad = true; break; }
    for (const e of r.events) if (e[0] in seen) seen[e[0]]++;
    r.events = []; t += 1 / 60;
  }
  console.log('     flipping bots:', JSON.stringify(seen), `${t.toFixed(0)}s`, r.phase);
  check(!bad && seen.exit > 0, 'a flipped ball can be shot out of a table into the null zone');
  check(seen.exit >= seen.enter * 0.15, `a decent share of table visits end in a shot out (${seen.exit}/${seen.enter})`);
  check(r.phase === 'over' || t >= 600, 'games with flipping players still progress');
}

// 3. roles
{
  const r = playing(4);
  let ok = true, zaps = 0, tilts = 0, none = 0;
  for (let k = 0; k < 400; k++) {
    r.assignRoles();
    const roles = [...r.players.values()].map((p) => ROLES[p.role]);
    zaps = Math.max(zaps, roles.filter((x) => x === 'zap').length);
    tilts = Math.max(tilts, roles.filter((x) => x === 'tilt').length);
    none += roles.filter((x) => x === 'none').length;
  }
  check(zaps <= 1 && tilts <= 1 && none === 0, 'every player gets a role; at most one zapper and one tilt master');
}

// 4. zapper turns the ball into goo
{
  const r = playing(2);
  const p = r.players.get('p0'); p.role = ROLES.indexOf('zap'); p.zapCd = 0;
  Object.assign(r.ball, { w: 'n', x: 500, y: 300, vx: 300, vy: 100, goo: 0, heat: 0.5 });
  r.setControl('p0', { d: 1 });
  r.update(1 / 60);
  check(r.ball.goo > 4 && p.zapCd > 4, 'zapper turns the ball to goo and goes on cooldown');
  let s = 0; for (let i = 0; i < 120; i++) { r.update(1 / 60); s = Math.hypot(r.ball.vx, r.ball.vy); if (r.ball.w !== 'n') break; }
  check(s <= 270, `goo ball is slow (${Math.round(s)} u/s)`);
}

// 5. dog's stream pushes the ball along its aim
{
  const r = playing(2);
  const p = r.players.get('p0'); p.role = ROLES.indexOf('dog'); p.aim = 0.6;
  const q = r.players.get('p1'); q.role = 0;
  Object.assign(r.ball, { w: 'n', x: 500, y: 700, vx: 0, vy: 0, goo: 0, heat: 0 });
  // side 0 is the bottom: inward is up (-y); a positive aim swings toward +x
  r.update(1 / 60); // updateGadgets
  const [ax, ay, ex] = r.forces({ x: 500 + 0.6 * 300, y: 910 - 300 * Math.cos(0.6) });
  check(ex === 1 && ay < 0 && ax > 0, 'dog stream pushes a ball in its path along the aim');
  const [bx, by, ex2] = r.forces({ x: 100, y: 100 });
  check(ex2 === 0 && bx === 0 && by === 0, 'ball outside the stream is unaffected');
}

// 6. the null zone changes how the ball arrives: hot = fast, goo = slow
{
  const arrive = (heat, goo) => {
    const r = playing(2);
    Object.assign(r.ball, { w: 'n', heat, goo });
    r.enterTable(r.players.get('p1'), 500, 0, -700);
    return Math.hypot(r.ball.vx, r.ball.vy);
  };
  const cold = arrive(0, 0), hot = arrive(1, 0), goo = arrive(0, 5);
  check(hot > cold && cold > goo, `ball arrives faster when hot than cold than goo (${Math.round(hot)} > ${Math.round(cold)} > ${Math.round(goo)})`);
}

// 7. a ball shot from one table lands on another player's table; the shooter scores when it drains
{
  const r = playing(2);
  const a = r.players.get('p0'), b = r.players.get('p1');
  Object.assign(r.ball, { w: 't', o: 'p0', x: 250, y: 20, vx: 0, vy: -900, heat: 0, goo: 0 });
  r.update(1 / 60); r.update(1 / 60);
  check(r.ball.w === 'n' && r.sender === 'p0', 'shooting up through the exit sends the ball into the null zone');
  Object.assign(r.ball, { w: 't', o: 'p1', x: 250, y: 1050, vx: 0, vy: 300 });
  const before = a.score, lives = b.lives;
  r.update(1 / 60);
  check(b.lives === lives - 1 && a.score >= before + 10, 'a drain costs the defender a life and pays the player who sent the ball');
}

// 8. snapshot / restore, and size
{
  const r = mk(4);
  for (let i = 0; i < 600; i++) { bot(r); r.update(1 / 60); }
  const snap = JSON.parse(JSON.stringify(r.snapshot('p0')));
  const size = JSON.stringify(snap).length;
  const r2 = new Sim(); r2.restore(snap);
  check(r2.phase === r.phase && r2.players.size === 4 && r2.ball.w === r.ball.w, 'a snapshot restores into a new Sim');
  check(size < 1400, `snapshot is small (${size} bytes)`);
  for (let i = 0; i < 300; i++) r2.update(1 / 60);
  check(finite(r2.ball), 'a restored game keeps running');
}

// 9. leaving: a player who drops mid-game stops being a target, and the game can still end
{
  const r = playing(3);
  r.leave('p1');
  check(!r.players.get('p1').alive && r.phase === 'playing', 'a leaver is knocked out and the game goes on');
  r.leave('p2');
  check(r.phase === 'over' && r.winnerId === 'p0', 'last player standing wins');
}

// 10. art style re-rolls on each null-zone visit and survives a snapshot
{
  const r = playing(2);
  const seen = new Set(); let same = false;
  for (let i = 0; i < 60; i++) { const a = r.style; r.rollStyle(); seen.add(r.style); if (r.style === a) same = true; }
  check(seen.size >= 4 && !same, `art style changes every time and varies (${seen.size} styles seen)`);
  const r2 = new Sim(); r2.restore(JSON.parse(JSON.stringify(r.snapshot('p0'))));
  check(r2.style === r.style, 'art style survives host migration');
}

process.exit(failed ? 1 : 0);
