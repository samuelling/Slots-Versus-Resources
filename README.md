# Slots Versus Resources

2-4 phones. Your whole phone is your own pinball table: tap the **left or right half** of the screen to work that flipper. Shoot the ball out the top and it flies into the **NULL ZONE**, a shared arena between everyone, where each phone controls something different and weird. Whatever happens to the ball there decides how hard it hits the next table.

## Play

Open the game's web page on every phone (no app, no install).

1. One person taps **Create room** and then **Share invite link**.
2. Everyone else opens that link and taps **Join room**.
3. The person who made the room taps **Start game**.

The first person in the room is the **host**: their phone runs the game, so they should keep the screen on (the game asks the phone to stay awake). If the host leaves, the next person takes over and the game carries on.

On iPhone, tap **Allow** when asked about motion: you need it for the tilt role.

## Your table

Two flippers, four bumpers, and an opening at the top leading to the null zone. Let the ball drain past your flippers and you lose a life (3 each). Shoot it out the top and it becomes someone else's problem; when it drains on their table, you score 10 (15 if it was red hot).

## The null zone

Every time the ball enters (and every 8 seconds while it is there) everyone is handed a new, random role:

- **Dog:** slide to aim a stream of pee that shoves the ball along.
- **Fan:** slide to aim, hold to blast wind.
- **Zapper:** tap to turn the ball into slow, sticky goo (6 s cooldown).
- **Tilt:** tilt your phone to lean the whole arena (drag your finger if there is no motion sensor).
- **Bumper:** drag a bumper around the arena.

Three chutes (they shuffle places) lead to portals: **wormhole** (teleports the ball), **cannon** (fires it hard) and **vault** (+25 points).

**What it does to the next table:** a ball that got knocked around (bumpers, streams, wind, cannon) arrives **hot**: fast and wobbly. A zapped ball arrives as **goo**: slow, heavy and an easy save.

The null zone has its own **16-bit pixel-art look**, so it feels like a different place. (The engine can also paint it in other art styles, such as pointillism or medieval, each visit; add `?styles=random` to the page address to see them.) When the ball is on someone else's table you watch it turned to face their edge of the arena, as if you were seeing it from your seat.

## How it works

Static files only, hosted on GitHub Pages. Phones talk through the same small Cloudflare relay that Crush Commando and Brick Ninja use (`wss://crush-commando-mp.samuelling.workers.dev`), which just passes messages around a room. The host's phone runs the physics (`sim.js`) and broadcasts snapshots about 30 times a second (`net.js`); guests send their touches and tilt and draw what they get back. Nothing to deploy or run.

- `index.html`: lobby, table and null zone drawing (including the art styles), touch and motion input, sound
- `net.js`: rooms, host selection, host hand-over
- `sim.js`: the game engine (tables, null zone, roles, carry-over). Tuning constants are at the top.
- `test/`: `node test/sim-test.mjs` (engine) and `node test/e2e.mjs` (simulated phones through the real relay)

To try it on your own computer: `python3 -m http.server`, then open http://localhost:8000. Add `?server=ws://...` to use a different relay.
