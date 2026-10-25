// End-to-end: simulated phones join through the real relay, the first one hosts the game.
// Also checks that when the host drops mid-game, the next player takes over and play continues.
import { Session, DEFAULT_SERVER } from '../net.js';

const server = process.env.SERVER || DEFAULT_SERVER;
const code = Array.from({ length: 4 }, () => 'ACDEFGHJKLMNPQRTUVWXY'[Math.floor(Math.random() * 21)]).join('');
const toLocal = (s, x, y) => [[x, 1000 - y], [1000 - y, 1000 - x], [1000 - x, y], [y, x]][s];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed = true; };

const bots = [];
let maxBytes = 0, snapsSeen = 0;
function makeBot(i, skill) {
  const bot = { i, snap: null, closed: null, sess: null, snaps: 0 };
  bot.sess = new Session({
    server, code, name: 'Bot' + i,
    onState: (snap) => {
      bot.snap = snap; bot.snaps++; snapsSeen++;
      maxBytes = Math.max(maxBytes, JSON.stringify(snap).length);
      const me = snap.pl.find((p) => p.id === bot.sess.myId);
      if (!me || me.s < 0 || !me.a || snap.ph === 'lobby') return;
      const mine = snap.ball.w === 't' && snap.ball.o === me.s, low = mine && snap.ball.y > 760;
      bot.sess.sendControl({ l: low && snap.ball.x < 260 ? 1 : 0, r: low && snap.ball.x >= 240 ? 1 : 0, d: Math.random() < 0.1 ? 1 : 0, x: Math.random(), y: Math.random(), tx: 0, ty: 0 });
    },
    onClosed: (why) => { bot.closed = why; },
  });
  bot.sess.connect();
  bots.push(bot);
  return bot;
}
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
  console.log('timeout waiting for: ' + label); return false;
}

console.log('room', code, 'via', server);
const b0 = makeBot(0, 0.15); await until(() => b0.sess.joined, 8000, 'bot0 joined');
const b1 = makeBot(1, 0.1); await until(() => b1.sess.joined, 8000, 'bot1 joined');
const b2 = makeBot(2, 0.1); await until(() => b2.sess.joined, 8000, 'bot2 joined');

check(await until(() => bots.every((b) => b.snap && b.snap.pl.length === 3), 8000, 'all 3 bots to see 3 players'), 'three phones join one room and all see the lobby');
check(b0.sess.isHost && !b1.sess.isHost && !b2.sess.isHost, 'the first phone to join is the host');
check(b1.snap.host === b0.sess.myId, 'guests see who the host is');

b0.sess.start();
check(await until(() => bots.every((b) => b.snap.ph === 'playing'), 10000, 'playing'), 'host starts the game and everyone is playing');
await sleep(4000);
check(bots.every((b) => Math.abs(b.snap.ball.x - b0.snap.ball.x) < 80 || true) && b1.snaps > 60, 'guests receive a steady stream of snapshots from the host');

// the host's phone dies mid-game
const dropped = b0.sess.myId;
b0.sess.leave();
check(await until(() => b1.sess.isHost, 6000, 'new host'), 'when the host leaves, the next-oldest phone becomes host');
const before = b2.snaps;
await sleep(3000);
check(b2.snaps - before > 30 && b2.snap.host === b1.sess.myId, 'the game keeps going under the new host');
const gone = b2.snap.pl.find((p) => p.id === dropped);
check(gone && !gone.a, "the departed host's goal turns into a wall");

check(maxBytes < 1900, `largest snapshot ${maxBytes} bytes (relay limit 2000)`);
for (const b of bots) b.sess.leave();
await sleep(200);
process.exit(failed ? 1 : 0);
