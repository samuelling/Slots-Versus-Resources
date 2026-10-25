# Pinball Party

2-4 phones, one shared pinball arena. Slide your finger to move your paddle and keep the puck out of your goal; swipe fast to smash it.

## Play

Open the game's web page on every phone (no app, no install).

1. One person taps **Create room** and then **Share invite link**.
2. Everyone else opens that link and taps **Join room**.
3. The person who made the room taps **Start game**.

The first person in the room is the **host**: their phone runs the game, so they should keep the screen on (the game asks the phone to stay awake). If the host leaves, the next person takes over and the game carries on.

## The arena

- Three chutes lead to three kinds of portal, and they change places every 9 seconds:
  - **Wormhole (teal):** teleports the puck out of another chute in a random direction.
  - **Cannon (orange):** fires the puck hard at a random opponent of whoever hit it last.
  - **Vault (gold):** +25 points to the last toucher, then releases the puck at calm speed.
- Bumpers score a point for whoever last touched the puck. Putting the puck in someone's goal scores 10. Everyone starts with 3 lives.

## How it works

Static files only, hosted on GitHub Pages. Phones talk through the same small Cloudflare relay that Crush Commando and Brick Ninja use (`wss://crush-commando-mp.samuelling.workers.dev`), which just passes messages around a room. The host's phone runs the physics (`sim.js`) and broadcasts snapshots about 30 times a second (`net.js`); guests send their paddle position and draw what they get back. Nothing to deploy or run.

- `index.html`: lobby, drawing, touch input, sound
- `net.js`: rooms, host selection, host hand-over
- `sim.js`: the game engine
- `test/`: `node test/sim-test.mjs` (engine) and `node test/e2e.mjs` (simulated phones through the real relay)

To try it on your own computer: `python3 -m http.server`, then open http://localhost:8000. Add `?server=ws://...` to use a different relay.
