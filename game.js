const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Crop rectangles trim the transparent padding some source PNGs still have
// around their drawn art (exported at 4500x4500 with a lot of empty margin).
// Assets not listed here have already been cropped tight and are drawn at
// their full natural size (see getCrop()).
const EXPLICIT_CROPS = {
  wall: { sx: 150, sy: 540, sw: 4350, sh: 3550 },
  '0': { sx: 15, sy: 0, sw: 3150, sh: 3535 },
};

function getCrop(img, key) {
  return EXPLICIT_CROPS[key] || { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
}

const wallImage = new Image();
wallImage.src = 'assets/wall.png';

const spriteImage = new Image();
spriteImage.src = 'assets/sprite.png';

const topSpeedImage = new Image();
topSpeedImage.src = 'assets/top%20speed.png';

const playAgainImage = new Image();
playAgainImage.src = 'assets/play%20again.png';

const startImage = new Image();
startImage.src = 'assets/start.png';

const explosionImage = new Image();
// explosion.png is a hand-drawn outline only (transparent interior, no
// vector path data), so a plain drawImage() doesn't cover anything behind
// it. Once it loads, flood-fill it into a solid white silhouette (cached
// here) so the burst actually masks the wall/sprite at the moment of
// impact — see buildExplosionMask()/drawImpactScreen().
let explosionMaskCanvas = null;
function buildExplosionMask() {
  try {
    const size = 300;
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const octx = off.getContext('2d');
    octx.drawImage(explosionImage, 0, 0, size, size);

    const srcData = octx.getImageData(0, 0, size, size).data;
    const isStroke = (i) => srcData[i * 4 + 3] > 40;
    const outside = new Uint8Array(size * size);
    const stack = [];
    const idx = (x, y) => y * size + x;
    const tryPush = (x, y) => {
      if (x < 0 || x >= size || y < 0 || y >= size) {
        return;
      }
      const i = idx(x, y);
      if (!outside[i] && !isStroke(i)) {
        outside[i] = 1;
        stack.push(i);
      }
    };

    // Flood-fill from every border pixel: whatever that reaches is "outside"
    // the burst; whatever it can't reach (enclosed by the outline) is the
    // interior we want to fill, plus the outline stroke itself.
    for (let x = 0; x < size; x += 1) {
      tryPush(x, 0);
      tryPush(x, size - 1);
    }
    for (let y = 0; y < size; y += 1) {
      tryPush(0, y);
      tryPush(size - 1, y);
    }
    while (stack.length > 0) {
      const i = stack.pop();
      const x = i % size;
      const y = Math.floor(i / size);
      tryPush(x - 1, y);
      tryPush(x + 1, y);
      tryPush(x, y - 1);
      tryPush(x, y + 1);
    }

    const maskData = octx.createImageData(size, size);
    for (let i = 0; i < size * size; i += 1) {
      const filled = !outside[i];
      maskData.data[i * 4] = 255;
      maskData.data[i * 4 + 1] = 255;
      maskData.data[i * 4 + 2] = 255;
      maskData.data[i * 4 + 3] = filled ? 255 : 0;
    }
    octx.putImageData(maskData, 0, 0);
    explosionMaskCanvas = off;
  } catch (err) {
    // getImageData throws if the page was opened directly via file:// (a
    // "tainted canvas" security restriction) rather than served over http —
    // drawImpactScreen() falls back to an approximate polygon fill in that
    // case, so this is a soft failure, not fatal.
    explosionMaskCanvas = null;
  }
}
explosionImage.onload = buildExplosionMask;
explosionImage.src = 'assets/explosion.png';

// One is picked at random on impact (see finishRun()) and shown stamped
// over the explosion, comic-panel style. 'no%20good' -> no good.png; the
// key itself has no space so it works as both an object key and a getCrop()
// lookup, unlike the filename.
const IMPACT_WORD_SOURCES = {
  bam: 'assets/bam.png',
  pow: 'assets/pow.png',
  woah: 'assets/woah.png',
  yikes: 'assets/yikes.png',
  'no-good': 'assets/no%20good.png',
};
const IMPACT_WORD_KEYS = Object.keys(IMPACT_WORD_SOURCES);
const impactWordImages = {};
IMPACT_WORD_KEYS.forEach((key) => {
  const img = new Image();
  img.src = IMPACT_WORD_SOURCES[key];
  impactWordImages[key] = img;
});

// Mobile/touch on-screen D-pad, shown during gameplay only.
const arrowImages = {
  up: new Image(),
  down: new Image(),
  left: new Image(),
  right: new Image(),
};
Object.keys(arrowImages).forEach((key) => {
  arrowImages[key].src = `assets/${key}.png`;
});

function drawImageFit(img, key, targetWidth, centerX, topY) {
  if (!img.complete || img.naturalWidth === 0) {
    return 0;
  }
  const crop = getCrop(img, key);
  const height = targetWidth * (crop.sh / crop.sw);
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, centerX - targetWidth / 2, topY, targetWidth, height);
  return height;
}

// Same as drawImageFit, but anchored by its center point rather than its
// top edge — used for the impact-screen explosion/word stamp, which is
// centered on the canvas rather than stacked top-down like the other screens.
function drawImageCentered(img, key, targetWidth, centerX, centerY) {
  if (!img.complete || img.naturalWidth === 0) {
    return;
  }
  const crop = getCrop(img, key);
  const height = targetWidth * (crop.sh / crop.sw);
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, centerX - targetWidth / 2, centerY - height / 2, targetWidth, height);
}

// Clickable bounding rect for whichever "button" image is on screen right
// now (start.png on the start screen, play again.png on the results
// screen), in canvas-internal coordinates. Null when nothing clickable.
let activeButtonRect = null;

function getCanvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

function pointInRect(point, rect) {
  return !!rect
    && point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

// On-screen D-pad for touch, arranged in a plus shape on the right side of
// the canvas (up/down/left/right around an empty center cell).
const PAD_BUTTON = 56;
const PAD_GAP = 8;
const PAD_RIGHT_MARGIN = 20;
const PAD_BOTTOM_MARGIN = 20;
const PAD_COL0 = canvas.width - PAD_RIGHT_MARGIN - (PAD_BUTTON * 3 + PAD_GAP * 2);
const PAD_COL1 = PAD_COL0 + PAD_BUTTON + PAD_GAP;
const PAD_COL2 = PAD_COL1 + PAD_BUTTON + PAD_GAP;
const PAD_ROW0 = canvas.height - PAD_BOTTOM_MARGIN - (PAD_BUTTON * 3 + PAD_GAP * 2);
const PAD_ROW1 = PAD_ROW0 + PAD_BUTTON + PAD_GAP;
const PAD_ROW2 = PAD_ROW1 + PAD_BUTTON + PAD_GAP;

const CONTROL_RECTS = {
  up: { x: PAD_COL1, y: PAD_ROW0, width: PAD_BUTTON, height: PAD_BUTTON },
  left: { x: PAD_COL0, y: PAD_ROW1, width: PAD_BUTTON, height: PAD_BUTTON },
  right: { x: PAD_COL2, y: PAD_ROW1, width: PAD_BUTTON, height: PAD_BUTTON },
  down: { x: PAD_COL1, y: PAD_ROW2, width: PAD_BUTTON, height: PAD_BUTTON },
};

function getControlAt(point) {
  return Object.keys(CONTROL_RECTS).find((key) => pointInRect(point, CONTROL_RECTS[key])) || null;
}

function setControlActive(control, active) {
  if (control === 'up') {
    state.holdInput = active;
  } else if (control === 'down') {
    state.reverseInput = active;
  } else if (control === 'left') {
    state.nudgeLeft = active;
  } else if (control === 'right') {
    state.nudgeRight = active;
  }
}

function drawControlButton(control) {
  const rect = CONTROL_RECTS[control];
  const img = arrowImages[control];
  const pressed = {
    up: state.holdInput,
    down: state.reverseInput,
    left: state.nudgeLeft,
    right: state.nudgeRight,
  }[control];
  const pad = 10;
  const iconSize = rect.width - pad * 2;

  ctx.save();
  if (pressed) {
    ctx.fillStyle = '#111111';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    if (img.complete && img.naturalWidth > 0) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(img, rect.x + pad, rect.y + pad, iconSize, iconSize);
    }
  } else {
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, rect.x + pad, rect.y + pad, iconSize, iconSize);
    }
  }
  ctx.restore();
}

function drawControls() {
  Object.keys(CONTROL_RECTS).forEach(drawControlButton);
}

// Hand-drawn digit/unit glyphs (assets/0.png..9.png, assets/mph.png) used to
// render every speed readout instead of plain text.
const digitImages = {};
['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'mph'].forEach((key) => {
  const img = new Image();
  img.src = `assets/${key}.png`;
  digitImages[key] = img;
});

function digitSequenceWidth(keys, glyphHeight, gap) {
  let total = 0;
  keys.forEach((key, i) => {
    const img = digitImages[key];
    if (img && img.complete && img.naturalWidth > 0) {
      const crop = getCrop(img, key);
      total += crop.sw * (glyphHeight / crop.sh);
    }
    if (i < keys.length - 1) {
      total += gap;
    }
  });
  return total;
}

function drawDigitSequence(targetCtx, keys, x, yBottom, glyphHeight, gap) {
  let cursorX = x;
  keys.forEach((key) => {
    const img = digitImages[key];
    if (img && img.complete && img.naturalWidth > 0) {
      const crop = getCrop(img, key);
      const width = crop.sw * (glyphHeight / crop.sh);
      targetCtx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, cursorX, yBottom - glyphHeight, width, glyphHeight);
      cursorX += width + gap;
    }
  });
}

const track = {
  groundY: canvas.height+5,
  distMin: 60,
  distMax: 150,
  wallTopY: 40,
};

const WALL_ASPECT = EXPLICIT_CROPS.wall.sh / EXPLICIT_CROPS.wall.sw;
const WALL_START_WIDTH = 90;
// This is the wall's width at rawProgress === 1, which the game never
// actually reaches anymore (see IMPACT_TRIGGER_WIDTH_FRACTION below) — it
// only still matters as the curve's asymptote, i.e. how large the wall
// *would* get if a run somehow ran all the way out. Kept wider than the
// canvas (a small overscan margin) so that if it ever were reached, it'd
// fully cover the canvas with no rounding sliver at the edges.
const WALL_IMPACT_WIDTH = canvas.width + 20;
// The run actually ends once the wall's rendered width crosses this
// fraction of canvas.width — a bit before it fully bleeds off-canvas, so
// impact lands while the wall is large and dominant but a sliver of
// background is still visible around it (see update()).
const IMPACT_TRIGGER_WIDTH_FRACTION = 0.85;
// Parallax: the wall shifts opposite state.lateralX (as if it's the camera
// panning while strafing, not the wall itself moving), growing stronger as
// the wall grows closer. getWallRect() clamps this once the wall is wide
// enough that an unclamped shift could expose a gap at the canvas edge.
const WALL_PARALLAX_FACTOR = 0.35;

const SPRITE_WIDTH = 200;
const NUDGE_SPEED = 90;
// Scaled down (~1/6) from an earlier, deliberately-arcadey 420 cap to a more
// realistic top speed — every constant below is scaled together so the
// timing/feel (how fast you ramp up, how fast releasing decays) stays the
// same, just on a smaller MPH number. DRAG_REFERENCE_SPEED is the "220" the
// drag term (below, in update()) divides speed by; ACTIVE_DRAG/IDLE_DRAG are
// coefficients on that already-scale-invariant ratio, so they don't need to
// change too.
const REVERSE_MAX_SPEED = 30;
const REVERSE_ACCEL = -58;
const BASE_SPRINT_ACCEL = 75;
const BASE_MAX_SPEED = 70;
const DRAG_REFERENCE_SPEED = 37;
const ACTIVE_DRAG = 28;
const IDLE_DRAG = 160;
// Randomized per run so the achievable top speed (and how fast you get
// there) genuinely differs each play, not just the distance to the wall.
const ACCEL_SCALE_MIN = 0.7;
const ACCEL_SCALE_MAX = 1.3;

const IMPACT_SCREEN_DURATION = 0.9;

const state = {
  time: 0,
  speed: 0,
  maxSpeed: 0,
  running: false,
  screen: 'start',
  traveled: 0,
  startDistance: track.distMax,
  accelScale: 1,
  lateralX: 0,
  holdInput: false,
  reverseInput: false,
  nudgeLeft: false,
  nudgeRight: false,
  lastTimestamp: 0,
  impactWordKey: null,
  impactTimeRemaining: 0,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function startRun() {
  if (state.running) {
    return;
  }

  state.startDistance = randomBetween(track.distMin, track.distMax);
  state.traveled = 0;
  state.lateralX = 0;
  state.accelScale = randomBetween(ACCEL_SCALE_MIN, ACCEL_SCALE_MAX);

  state.running = true;
  state.screen = 'gameplay';
  state.time = 0;
  state.speed = 0;
  state.maxSpeed = 0;
}

function finishRun() {
  state.running = false;
  state.screen = 'impact';
  state.impactWordKey = IMPACT_WORD_KEYS[Math.floor(Math.random() * IMPACT_WORD_KEYS.length)];
  state.impactTimeRemaining = IMPACT_SCREEN_DURATION;
  // Nothing is clickable during the impact flash; drawResultsScreen() sets
  // this again once we actually reach the results screen.
  activeButtonRect = null;
}

function update(dt) {
  if (!state.running) {
    return;
  }

  state.time += dt;

  let acceleration;
  let drag;
  if (state.reverseInput) {
    acceleration = REVERSE_ACCEL;
    drag = ACTIVE_DRAG;
  } else {
    const sprintBoost = state.holdInput ? 1 : 0;
    acceleration = sprintBoost * BASE_SPRINT_ACCEL * state.accelScale;
    drag = sprintBoost ? ACTIVE_DRAG : IDLE_DRAG;
  }

  state.speed += (acceleration - drag * (state.speed / DRAG_REFERENCE_SPEED)) * dt;
  state.speed = clamp(state.speed, -REVERSE_MAX_SPEED, BASE_MAX_SPEED * state.accelScale);
  state.maxSpeed = Math.max(state.maxSpeed, state.speed);

  // No floor at 0: you can walk backward past the start line for a longer
  // running start. Negative traveled shrinks the wall further (see
  // getWallRect()) and counts against the same startDistance you still
  // have to close.
  state.traveled += state.speed * dt * 0.72;

  const nudge = (state.nudgeRight ? 1 : 0) - (state.nudgeLeft ? 1 : 0);
  state.lateralX = clamp(state.lateralX + nudge * NUDGE_SPEED * dt, -220, 220);

  // Trigger impact once the wall's on-screen width crosses a threshold
  // rather than waiting for it to fully bleed off-canvas — this ends the
  // run a bit before "full coverage", while the wall is still large and
  // dominant but hasn't completely swallowed the screen yet.
  if (state.traveled > 0 && getWallRect().width >= canvas.width * IMPACT_TRIGGER_WIDTH_FRACTION) {
    state.speed = Math.max(state.speed, 0);
    finishRun();
  }
}

// Raw, unclamped ratio — negative while you've walked backward past the
// start line (see update()). Deliberately not clamped here: getWallRect()
// needs the sign and magnitude to shrink the wall further when negative.
function getWallProgress() {
  return state.startDistance > 0 ? state.traveled / state.startDistance : 0;
}

// Growth curve for the wall's size/parallax: raising linear progress to a
// power > 1 eases it in, so the wall barely grows at first and then balloons
// toward the end (exponential-feeling) instead of growing at a constant
// rate with distance covered. This is purely visual — getWallProgress()
// itself (state.traveled / state.startDistance) stays linear.
const WALL_GROWTH_EXPONENT = 2.5;
// How far below WALL_START_WIDTH the wall can shrink while walking
// backward, as a fraction of it (never quite to zero, so there's always a
// visible speck rather than the wall vanishing).
const WALL_MIN_SHRINK_SCALE = 0.15;

// The wall is drawn as a plain axis-aligned rectangle (no shear/rotation),
// so it always keeps square, 90-degree corners as it scales up. It grows
// from WALL_START_WIDTH toward WALL_IMPACT_WIDTH as progress goes 0 -> 1,
// though in practice a run always ends earlier, once the width crosses
// IMPACT_TRIGGER_WIDTH_FRACTION of the canvas (see update()) — so the wall
// is still large and dominant at impact, but hasn't gone fully edge-to-edge.
// Below 0 (walked backward past the start) it instead shrinks smaller than
// WALL_START_WIDTH, continuously — both branches agree exactly at
// progress === 0, so there's no jump.
function getWallRect() {
  const rawProgress = getWallProgress();
  const forwardEased = rawProgress > 0 ? Math.min(rawProgress, 1) ** WALL_GROWTH_EXPONENT : 0;

  let width;
  if (rawProgress > 0) {
    width = WALL_START_WIDTH + (WALL_IMPACT_WIDTH - WALL_START_WIDTH) * forwardEased;
  } else {
    const shrink = clamp(1 + rawProgress, WALL_MIN_SHRINK_SCALE, 1);
    width = WALL_START_WIDTH * shrink;
  }
  const height = width * WALL_ASPECT;

  let offset = -state.lateralX * WALL_PARALLAX_FACTOR * forwardEased;
  const overscan = (width - canvas.width) / 2;
  if (overscan >= 0) {
    // The wall is now wide enough that it's expected to fully cover the
    // canvas (this is the case right at impact) — clamp so the shift can't
    // pull an edge in and expose a sliver of white.
    offset = clamp(offset, -overscan, overscan);
  }

  return {
    dx: canvas.width / 2 - width / 2 + offset,
    dy: track.wallTopY,
    width,
    height,
  };
}

function drawBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawWall() {
  if (!wallImage.complete || wallImage.naturalWidth === 0) {
    return;
  }

  const crop = getCrop(wallImage, 'wall');
  const rect = getWallRect();

  ctx.drawImage(
    wallImage,
    crop.sx, crop.sy, crop.sw, crop.sh,
    rect.dx, rect.dy, rect.width, rect.height,
  );
}

function drawRunner() {
  if (!spriteImage.complete || spriteImage.naturalWidth === 0) {
    return;
  }

  const crop = getCrop(spriteImage, 'sprite');
  const spriteHeight = Math.round(SPRITE_WIDTH * (crop.sh / crop.sw));
  const bob = state.speed > 0 ? Math.sin(state.time * 26) * 3 : 0;
  const dx = canvas.width / 2 + state.lateralX - SPRITE_WIDTH / 2;
  const dy = track.groundY - spriteHeight + bob;

  ctx.drawImage(
    spriteImage,
    crop.sx, crop.sy, crop.sw, crop.sh,
    dx, dy, SPRITE_WIDTH, spriteHeight,
  );
}

function drawSpeedHud() {
  const keys = [...String(Math.round(Math.abs(state.speed))).split(''), 'mph'];
  const glyphHeight = 30;
  const gap = 5;
  const margin = 20;
  const width = digitSequenceWidth(keys, glyphHeight, gap);

  drawDigitSequence(ctx, keys, canvas.width - margin - width, margin + glyphHeight, glyphHeight, gap);
}

// Fallback for buildExplosionMask() failing (e.g. opened via file:// rather
// than served over http): an approximate jagged-star polygon, close enough
// to the hand-drawn silhouette but not pixel-accurate the way the mask is.
function drawBurstFill(centerX, centerY, radius) {
  const spikes = 10;
  const innerRatio = 0.58;

  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i += 1) {
    const angle = (Math.PI * i) / spikes;
    const r = i % 2 === 0 ? radius : radius * innerRatio;
    const x = centerX + Math.cos(angle) * r;
    const y = centerY + Math.sin(angle) * r;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawImpactScreen() {
  // The wall's rect is still whatever it was the instant finishRun() fired
  // (state.traveled/startDistance haven't changed), which is exactly full
  // canvas coverage — so this reads as "frozen on the moment of impact."
  drawBackground();
  drawWall();

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  // explosion.png (and every impact-word PNG) is a square 1:1 canvas, so
  // sizing to canvas.height here makes it fill the screen top-to-bottom.
  const explosionWidth = canvas.height;

  if (explosionMaskCanvas) {
    ctx.drawImage(explosionMaskCanvas, centerX - explosionWidth / 2, centerY - explosionWidth / 2, explosionWidth, explosionWidth);
  } else {
    drawBurstFill(centerX, centerY, (explosionWidth / 2) * 1.05);
  }
  drawImageCentered(explosionImage, 'explosion', explosionWidth, centerX, centerY);

  const wordImg = impactWordImages[state.impactWordKey];
  if (wordImg) {
    // Keep the word's previous proportion relative to the explosion (was
    // 264/456) rather than a fixed pixel size, so it scales together with it.
    const wordWidth = explosionWidth * (264 / 456);
    drawImageCentered(wordImg, state.impactWordKey, wordWidth, centerX, centerY);
  }
}

function drawResultsScreen() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawImageFit(topSpeedImage, 'topSpeed', 320, canvas.width / 2, 140);

  const keys = [...String(Math.round(state.maxSpeed)).split(''), 'mph'];
  const glyphHeight = 80;
  const gap = 10;
  const width = digitSequenceWidth(keys, glyphHeight, gap);

  drawDigitSequence(ctx, keys, canvas.width / 2 - width / 2, 310, glyphHeight, gap);

  const playAgainWidth = 260;
  const playAgainTopY = 360;
  const playAgainHeight = drawImageFit(playAgainImage, 'playAgain', playAgainWidth, canvas.width / 2, playAgainTopY);
  activeButtonRect = {
    x: canvas.width / 2 - playAgainWidth / 2,
    y: playAgainTopY,
    width: playAgainWidth,
    height: playAgainHeight,
  };
}

function drawStartScreen() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const startWidth = 320;
  const startTopY = canvas.height / 2 - 60;
  const startHeight = drawImageFit(startImage, 'start', startWidth, canvas.width / 2, startTopY);
  activeButtonRect = {
    x: canvas.width / 2 - startWidth / 2,
    y: startTopY,
    width: startWidth,
    height: startHeight,
  };
}

function render() {
  if (state.screen === 'start') {
    drawStartScreen();
    return;
  }

  if (state.screen === 'impact') {
    drawImpactScreen();
    return;
  }

  if (state.screen === 'results') {
    drawResultsScreen();
    return;
  }

  drawBackground();
  drawWall();
  drawRunner();
  drawSpeedHud();
  drawControls();
}

function loop(timestamp) {
  const dt = Math.min((timestamp - state.lastTimestamp) / 1000 || 0.016, 0.033);
  state.lastTimestamp = timestamp;

  update(dt);

  if (state.screen === 'impact') {
    state.impactTimeRemaining -= dt;
    if (state.impactTimeRemaining <= 0) {
      state.screen = 'results';
    }
  }

  render();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'ArrowUp') {
    event.preventDefault();
    state.holdInput = true;
  } else if (event.code === 'ArrowDown') {
    event.preventDefault();
    state.reverseInput = true;
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault();
    state.nudgeLeft = true;
  } else if (event.code === 'ArrowRight') {
    event.preventDefault();
    state.nudgeRight = true;
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'ArrowUp') {
    state.holdInput = false;
  } else if (event.code === 'ArrowDown') {
    state.reverseInput = false;
  } else if (event.code === 'ArrowLeft') {
    state.nudgeLeft = false;
  } else if (event.code === 'ArrowRight') {
    state.nudgeRight = false;
  }
});

// Maps active pointerId -> control key, so multiple simultaneous touches
// (e.g. sprinting with one thumb while nudging with the other) release
// independently instead of one finger lifting clearing every input.
const activePointerControls = new Map();

canvas.addEventListener('pointerdown', (event) => {
  const point = getCanvasPoint(event.clientX, event.clientY);

  if (!state.running) {
    if (pointInRect(point, activeButtonRect)) {
      startRun();
    }
    return;
  }

  const control = getControlAt(point) || 'up';
  activePointerControls.set(event.pointerId, control);
  setControlActive(control, true);
});

function releasePointerControl(event) {
  const control = activePointerControls.get(event.pointerId);
  if (control) {
    setControlActive(control, false);
    activePointerControls.delete(event.pointerId);
  }
}

canvas.addEventListener('pointerup', releasePointerControl);
canvas.addEventListener('pointercancel', releasePointerControl);
canvas.addEventListener('pointerleave', releasePointerControl);

render();
requestAnimationFrame(loop);
