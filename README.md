# Pinball Party

2-4 phones, one shared pinball arena. Slide your finger to move your paddle and keep the puck out of your goal; swipe fast to smash it. Three chutes lead to three kinds of portal, and they change places every 9 seconds:

- **Wormhole (teal):** teleports the puck out of another chute in a random direction.
- **Cannon (orange):** fires the puck hard at a random opponent of whoever hit it last.
- **Vault (gold):** +25 points to the last toucher, then releases the puck at calm serve speed.

Cloudflare Worker + one Durable Object per room. The Durable Object runs the physics at ~60 Hz and broadcasts ~30 Hz snapshots; phones only send paddle position.

```
npm install
npm run dev      # http://localhost:8787 (open on two or more tabs/phones on the same Wi-Fi)
npm test         # with `npm run dev` running: simulated players
npm run deploy   # needs `npx wrangler login` first
```

Tuning knobs are constants at the top of `src/room.js` (lives, speeds, paddle size, goal mouth, bumpers).
