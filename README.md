# Wall Run

A tiny browser game inspired by classic arcade runners, played from a mid-back POV: the wall sits ahead of you and grows larger as you close the distance. Hold the sprint key or hold down the mouse on the game canvas to build speed, then smash into the wall as fast as you can.

## Run locally

From this folder, start the server:

```bash
npm start
```

(This runs [server.js](server.js), a small dependency-free Node static file server — no Python, no `serve` package needed.) Then open http://localhost:8000 in your browser.

## Deploying (Railway)

The app is a Node service, not a static site, so it works with Railway's default Node deploy: it detects [package.json](package.json), runs `npm start`, and [server.js](server.js) binds to whatever port Railway provides via the `PORT` environment variable (falling back to 8000 locally). No other configuration is needed.

## Controls

- Hold the Up Arrow key to sprint
- Hold the Down Arrow key to reverse (undoes progress and shrinks the wall back down)
- Hold Left/Right Arrow to strafe the runner left/right without affecting speed buildup
- Or hold click/tap on the game canvas to sprint
- On touch devices, use the on-screen D-pad on the right side of the canvas — it supports multi-touch, so you can e.g. sprint and nudge at the same time with two fingers
- Click/tap the START / PLAY AGAIN graphic on screen to begin or restart a run — holding a key or clicking elsewhere doesn't start anything

## Goal

Push your speed as high as possible before the runner reaches the wall. The distance to the wall is randomized each run, and so is your top possible speed — the same play style caps out differently from one run to the next. Your current speed is shown top-right during the run; after impact, a results screen shows your top speed with a Play Again graphic to click.
