/*
  Music Letter MVP
  - Typing creates falling letters with GSAP
  - Each keystroke plays a tone via Tone.js
  - Notes are recorded and can be played back
  - A ball animates over letters along a generated path in sync with notes
*/

/* Globals */
if (window.gsap && window.MotionPathPlugin) {
  gsap.registerPlugin(MotionPathPlugin);
}

const state = {
  theme: 'classic',
  synth: null,
  effects: { reverb: null, delay: null },
  keyToNote: {},
  events: [], // { char, note, time, x, y }
  lastKeyTs: 0,
  inactivityMs: 2500,
  scheduledTimeout: null,
  animationMode: 'arc', // 'arc' | 'physics'
  align: 'left', // 'left' | 'center' | 'right' | 'justify'
  // Physics
  physics: {
    engine: null,
    world: null,
    runner: null,
    groundBodies: [],
    wallBodies: [],
    letterBodies: [], // { body, el }
    enabled: false,
    settleCounter: 0,
    snapped: false,
  },
};

const themes = {
  classic: {
    fontFamily: 'Playfair Display',
    soundPalette: 'majorC',
  },
  midnight: {
    fontFamily: 'Poppins',
    soundPalette: 'minorA',
  },
  pastel: {
    fontFamily: 'Playfair Display',
    soundPalette: 'pentatonicC',
  },
};

/* Simple palettes */
const palettes = {
  majorC: ['C4','D4','E4','F4','G4','A4','B4','C5'],
  minorA: ['A3','B3','C4','D4','E4','F4','G4','A4'],
  pentatonicC: ['C4','D4','E4','G4','A4','C5'],
};

function buildKeyToNote(paletteName) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const pool = palettes[paletteName] || palettes.majorC;
  const mapping = {};
  for (let i = 0; i < letters.length; i += 1) {
    mapping[letters[i]] = pool[i % pool.length];
  }
  mapping[' '] = null; // space: no note
  mapping['\n'] = null; // enter: no note
  return mapping;
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const font = themes[theme]?.fontFamily || 'Playfair Display';
  // Apply font and spacing based on theme default
  setFont(font);
  // Update notes palette per theme
  state.keyToNote = buildKeyToNote(themes[theme]?.soundPalette || 'majorC');
  // Sync UI selector if present
  const fontSelect = document.getElementById('fontSelect');
  if (fontSelect) fontSelect.value = font;
  const paletteSelect = document.getElementById('paletteSelect');
  if (paletteSelect) paletteSelect.value = themes[theme]?.soundPalette || 'majorC';
  // Reconfigure synth if audio already started
  try {
    if (Tone.getContext().state === 'running' && state.synth) {
      configureSynthForTheme(theme);
    }
  } catch (_) {}
}

/* Font management */
const fontLetterSpacingMap = new Map([
  ['Playfair Display', 0.02],
  ['Poppins', 0.01],
  ['EB Garamond', 0.015],
  ['Merriweather', 0.015],
  ['Lora', 0.016],
  ['Cormorant Garamond', 0.02],
  ['DM Serif Display', 0.02],
  ['Libre Baskerville', 0.015],
  // Artistic fonts (tighter defaults)
  ['Great Vibes', 0.01],
  ['Pacifico', 0.012],
  ['Dancing Script', 0.012],
  ['Cinzel Decorative', 0.02],
  ['Playball', 0.012],
  ['Lobster', 0.012],
  ['Sacramento', 0.01],
  ['Amatic SC', 0.015],
  ['Caveat', 0.012],
  ['Abril Fatface', 0.02],
  ['Berkshire Swash', 0.014],
  ['Shadows Into Light', 0.012],
  ['Indie Flower', 0.012],
]);

function setFont(fontFamily) {
  const spacingEm = fontLetterSpacingMap.get(fontFamily) ?? 0.02;
  document.documentElement.style.setProperty('--font-serif', `'${fontFamily}', serif`);
  document.documentElement.style.setProperty('--letter-spacing', `${spacingEm}em`);
  // Recreate measurer so caret width estimates reflect the new metrics
  const container = document.getElementById('textArea');
  if (nextCaretPosition.measurer) {
    nextCaretPosition.measurer.remove();
    nextCaretPosition.measurer = null;
  }
  // Optionally reflow existing letters to inherit font
  reflowExistingLetters();
  if (state.physics && state.physics.world) buildGroundBodies();
  persistToStorage();
}

function setAlign(align) {
  state.align = align;
  document.documentElement.style.setProperty('--align', align);
  // Reflow to re-compute positions
  reflowExistingLetters();
  persistToStorage();
}

async function ensureAudio() {
  if (!state.synth) {
    await Tone.start();
    configureSynthForTheme(state.theme);
  }
}

function playNote(note) {
  if (!note) return;
  state.synth?.triggerAttackRelease(note, 0.25);
}

function configureSynthForTheme(theme) {
  // Dispose previous
  try { state.synth?.dispose?.(); } catch (_) {}
  try { state.effects.reverb?.dispose?.(); } catch (_) {}
  try { state.effects.delay?.dispose?.(); } catch (_) {}
  state.synth = null;
  state.effects = { reverb: null, delay: null };

  const reverb = new Tone.Reverb({ decay: 2.0, wet: 0.22 }).toDestination();
  const delay = new Tone.FeedbackDelay({ delayTime: 0.18, feedback: 0.18, wet: 0.16 }).connect(reverb);

  let synth;
  if (theme === 'midnight') {
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.25, sustain: 0.12, release: 0.8 },
    });
  } else if (theme === 'pastel') {
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.006, decay: 0.18, sustain: 0.1, release: 0.5 },
    });
  } else {
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.6 },
    });
  }
  synth.connect(delay);
  state.synth = synth;
  state.effects = { reverb, delay };
}

function setSoundPreset(preset) {
  // Switch different instrument flavors
  // Simple factory using Tone instruments
  try { state.synth?.dispose?.(); } catch (_) {}
  const reverb = state.effects.reverb || new Tone.Reverb({ decay: 2.0, wet: 0.22 }).toDestination();
  const delay = state.effects.delay || new Tone.FeedbackDelay({ delayTime: 0.18, feedback: 0.18, wet: 0.16 }).connect(reverb);
  let synth;
  switch (preset) {
    case 'triangle_ambient':
      synth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'triangle' }, envelope: { attack: 0.02, decay: 0.3, sustain: 0.15, release: 1.2 } });
      break;
    case 'chime_fm':
      synth = new Tone.PolySynth(Tone.FMSynth, { modulationIndex: 10, harmonicity: 2.5, envelope: { attack: 0.005, decay: 0.3, sustain: 0.0, release: 1.2 } });
      break;
    case 'pluck':
      synth = new Tone.PolySynth(Tone.PluckSynth, {});
      break;
    case 'saw_pad':
      synth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.03, decay: 0.4, sustain: 0.2, release: 1.5 } });
      break;
    case 'epiano':
      synth = new Tone.PolySynth(Tone.AMSynth, { harmonicity: 1, modulationIndex: 2, oscillator: { type: 'sine' } });
      break;
    case 'bell':
      synth = new Tone.PolySynth(Tone.MetalSynth, { frequency: 200, envelope: { attack: 0.001, decay: 1.4, release: 2 }, harmonicity: 5.1, modulationIndex: 32, resonance: 400, octaves: 1.5 });
      break;
    case 'sine_soft':
    default:
      synth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: 'sine' }, envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.6 } });
  }
  synth.connect(delay);
  state.synth = synth;
  state.effects = { reverb, delay };
}

function createLetterSpan(char, container, x, y, animate = true) {
  const span = document.createElement('span');
  span.className = 'typed-letter';
  span.textContent = char;
  container.appendChild(span);
  // Measure width/height by placing then positioning
  const rect = container.getBoundingClientRect();
  const targetLeft = x;
  const targetTop = y;

  if (!state.physics.enabled) {
    // Arc drop animation to the final layout position
    const rand = (min, max) => Math.random() * (max - min) + min;
    const startY = -rand(60, 140);
    const startX = Math.max(0, Math.min(rect.width - (span.getBoundingClientRect().width || 16), targetLeft + rand(-140, 140)));
    span.style.left = `${startX}px`;
    span.style.top = `${startY}px`;
    if (animate) {
      gsap.to(span, {
        left: targetLeft,
        top: targetTop,
        duration: 0.75,
        ease: 'power3.out',
      });
    } else {
      span.style.left = `${targetLeft}px`;
      span.style.top = `${targetTop}px`;
    }
  } else {
    // Physics-based drop
    const localX = targetLeft;
    const localY = -64;
    span.style.left = `${localX}px`;
    span.style.top = `${localY}px`;
    addLetterBody(span, localX, localY, targetTop);
  }
  return span;
}

function nextCaretPosition(container, char) {
  // Simple monospace-like flow using approximate advance by measuring a hidden span
  // Create an invisible measurer on first call
  if (!nextCaretPosition.measurer) {
    const m = document.createElement('span');
    m.style.visibility = 'hidden';
    m.style.position = 'absolute';
    m.style.left = '-9999px';
    m.style.top = '-9999px';
    m.style.whiteSpace = 'pre';
    m.textContent = 'M';
    container.appendChild(m);
    nextCaretPosition.measurer = m;
    nextCaretPosition.x = 0;
    nextCaretPosition.y = 0;
    nextCaretPosition.lineHeight = 36; // fallback, approximated; updated below
    nextCaretPosition.spaceWidth = m.getBoundingClientRect().width * 0.6;
    nextCaretPosition.charWidth = m.getBoundingClientRect().width;
  }
  const measurer = nextCaretPosition.measurer;
  // Measure the actual character where possible; use 'M' as a stable fallback
  measurer.textContent = (char && char !== '\n' && char !== ' ')
    ? char
    : 'M';
  const mRect = measurer.getBoundingClientRect();
  const baseWidth = (char === ' ')
    ? mRect.width * 0.6
    : (char === '\n' ? 0 : mRect.width);
  const rect = container.getBoundingClientRect();
  const padding = 0;
  const maxWidth = rect.width - padding * 2;
  const style = getComputedStyle(container);
  const letterSpacingPx = parseFloat(style.letterSpacing);
  const letterSpacing = Number.isFinite(letterSpacingPx) ? letterSpacingPx : 0;
  const advance = (char === '\n') ? 0 : (baseWidth + (char === ' ' ? 0 : letterSpacing));

  if (char === '\n') {
    nextCaretPosition.x = 0;
    nextCaretPosition.y += nextCaretPosition.lineHeight;
  } else {
    if (nextCaretPosition.x + advance > maxWidth) {
      nextCaretPosition.x = 0;
      nextCaretPosition.y += nextCaretPosition.lineHeight;
    }
  }

  const result = { x: nextCaretPosition.x, y: nextCaretPosition.y };
  if (char === '\n') {
    // already moved
  } else {
    nextCaretPosition.x += advance;
  }
  // Update line height estimate using computed font size
  const fontSize = parseFloat(style.fontSize) || 24;
  nextCaretPosition.lineHeight = fontSize * 1.4;

  return result;
}

function computeLineLayoutOffsets(container) {
  // Re-compute per-line total width to support center/right/justify alignment
  const lines = [];
  if (nextCaretPosition.measurer) {
    nextCaretPosition.measurer.remove();
    nextCaretPosition.measurer = null;
  }
  nextCaretPosition.x = 0; nextCaretPosition.y = 0;
  const items = [];
  for (const ev of state.events) {
    const pos = nextCaretPosition(container, ev.char);
    items.push({ ev, pos });
  }
  // Group items by line y
  const style = getComputedStyle(container);
  const fontSize = parseFloat(style.fontSize) || 24;
  const lineHeight = fontSize * 1.4;
  const linesMap = new Map();
  for (const it of items) {
    const key = Math.round(it.pos.y / lineHeight);
    if (!linesMap.has(key)) linesMap.set(key, []);
    linesMap.get(key).push(it);
  }
  const rect = container.getBoundingClientRect();
  const padding = 0; const maxWidth = rect.width - padding * 2;
  const results = [];
  for (const [key, arr] of [...linesMap.entries()].sort((a,b)=>a[0]-b[0])) {
    const isLastLine = key === Math.max(...linesMap.keys());
    if (state.align === 'left') {
      results.push({ key, offset: 0, spacingAdjust: 0 });
    } else if (state.align === 'center') {
      const totalWidth = arr.filter(x=>x.ev.char!=='\n').reduce((acc, x) => acc + measureChar(container, x.ev.char, style), 0);
      const offset = Math.max(0, (maxWidth - totalWidth) / 2);
      results.push({ key, offset, spacingAdjust: 0 });
    } else if (state.align === 'right') {
      const totalWidth = arr.filter(x=>x.ev.char!=='\n').reduce((acc, x) => acc + measureChar(container, x.ev.char, style), 0);
      const offset = Math.max(0, maxWidth - totalWidth);
      results.push({ key, offset, spacingAdjust: 0 });
    } else if (state.align === 'justify') {
      if (isLastLine || arr.length <= 1) {
        results.push({ key, offset: 0, spacingAdjust: 0 });
      } else {
        const glyphs = arr.filter(x=>x.ev.char!=='\n');
        const totalWidth = glyphs.reduce((acc, x) => acc + measureChar(container, x.ev.char, style), 0);
        const gaps = Math.max(1, glyphs.length - 1);
        const extra = Math.max(0, maxWidth - totalWidth);
        results.push({ key, offset: 0, spacingAdjust: extra / gaps });
      }
    }
  }
  return { lineHeight, offsets: results };
}

function measureChar(container, ch, style) {
  if (!measureChar.measurer) {
    const m = document.createElement('span');
    m.style.visibility = 'hidden';
    m.style.position = 'absolute';
    m.style.left = '-9999px';
    m.style.top = '-9999px';
    m.style.whiteSpace = 'pre';
    container.appendChild(m);
    measureChar.measurer = m;
  }
  const m = measureChar.measurer;
  m.textContent = ch === '\n' ? '' : ch || 'M';
  const base = m.getBoundingClientRect().width;
  const letterSpacingPx = parseFloat(style.letterSpacing);
  const letterSpacing = Number.isFinite(letterSpacingPx) ? letterSpacingPx : 0;
  return base + (ch === ' ' ? 0 : letterSpacing);
}

function recordEvent(char, note, position) {
  state.events.push({
    char,
    note,
    time: Tone.now(),
    x: position.x,
    y: position.y,
  });
  persistToStorage();
}

function scheduleInactivityPlayback() {
  if (state.scheduledTimeout) clearTimeout(state.scheduledTimeout);
  state.scheduledTimeout = setTimeout(() => playSequence(), state.inactivityMs);
}

function handleKeyDown(ev) {
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    ev.preventDefault();
    deleteLast();
    scheduleInactivityPlayback();
    return;
  }
  const char = ev.key.length === 1 ? ev.key : (ev.key === 'Enter' ? '\n' : '');
  if (!char) return;
  ev.preventDefault();

  const lower = char.toLowerCase();
  const note = state.keyToNote[lower] ?? null;

  ensureAudio().then(() => playNote(note));

  const container = document.getElementById('textArea');
  const pos = nextCaretPosition(container, char);
  if (char !== '\n') {
    createLetterSpan(char, container, pos.x, pos.y);
  }

  recordEvent(char, note, pos);
  state.lastKeyTs = Date.now();
  scheduleInactivityPlayback();
}

function deleteLast() {
  if (!state.events.length) return;
  // Remove last event
  const last = state.events[state.events.length - 1];
  // If last is a rendered letter (not newline), remove its DOM and physics body
  if (last.char !== '\n') {
    const container = document.getElementById('textArea');
    const letters = container.querySelectorAll('.typed-letter');
    const lastEl = letters[letters.length - 1];
    if (lastEl) {
      // Remove physics body if present
      removeLetterBodyByElement(lastEl);
      lastEl.remove();
    }
  }
  // Pop the last event (letter or newline)
  state.events.pop();
  persistToStorage();
  // Reflow the remaining letters to updated optimal positions
  reflowExistingLetters();
}

function removeLetterBodyByElement(el) {
  if (!state.physics || !state.physics.world) return;
  const { World } = Matter;
  const arr = state.physics.letterBodies;
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].el === el) {
      try { World.remove(state.physics.world, arr[i].body); } catch (_) {}
      arr.splice(i, 1);
      break;
    }
  }
}

function clearAll() {
  state.events = [];
  const container = document.getElementById('textArea');
  container.innerHTML = '';
  // reset caret measurer
  if (nextCaretPosition.measurer) {
    nextCaretPosition.measurer.remove();
    nextCaretPosition.measurer = null;
    nextCaretPosition.x = 0;
    nextCaretPosition.y = 0;
  }
  // clear physics bodies
  clearLetterBodies();
  persistToStorage();
}

function buildMotionPathFromEvents(containerRect) {
  // Build simple path that visits top of each letter position
  // We don't have per-letter DOM refs saved; use recorded x,y with a small offset
  const points = state.events
    .filter(e => e.char !== '\n')
    .map(e => ({ x: e.x + 8, y: e.y + 8 }));
  if (points.length === 0) return null;
  return points;
}

function playSequence() {
  if (!state.events.length) return;
  ensureAudio();

  const ball = document.getElementById('ball');
  const container = document.getElementById('textArea');
  const rect = container.getBoundingClientRect();
  const points = buildMotionPathFromEvents(rect);
  if (!points || points.length === 0) return;

  // Normalize times relative to the first event
  const startTime = state.events[0].time;
  const rel = state.events.map(e => ({ ...e, t: Math.max(0, e.time - startTime) }));

  // Create a Tone.Part to schedule in order
  const part = new Tone.Part((time, value) => {
    if (value.note) state.synth?.triggerAttackRelease(value.note, 0.22, time);
  }, rel.map(e => [e.t, { note: e.note }]));
  part.start(0);

  // Compute total duration slightly beyond last event
  const totalDur = (rel[rel.length - 1].t || 0) + 0.35;

  // Show ball
  gsap.set(ball, { opacity: 1 });

  // Animate ball along points proportional to event times
  // Build keyframes with times scaled to totalDur
  const lastT = rel[rel.length - 1].t || 0.0001;
  const keyframes = points.map((p, i) => ({
    x: p.x + rect.left,
    y: p.y + rect.top,
    t: (rel[i]?.t ?? (i / (points.length - 1) * lastT)) / totalDur,
  }));

  // Fallback linear timing if inconsistent
  for (let i = 0; i < keyframes.length; i += 1) {
    if (!isFinite(keyframes[i].t)) keyframes[i].t = i / Math.max(1, keyframes.length - 1);
  }

  // Use MotionPath with relative container coords
  gsap.to(ball, {
    duration: totalDur,
    ease: 'none',
    motionPath: {
      path: keyframes.map(k => ({ x: k.x - rect.left, y: k.y - rect.top })),
      autoRotate: false,
    },
    onComplete: () => {
      gsap.to(ball, { opacity: 0, duration: 0.3 });
    },
  });

  Tone.Transport.stop();
  Tone.Transport.position = 0;
  Tone.Transport.start('+0.05');
}

// Physics integration with Matter.js
function initPhysics() {
  const { Engine, World, Bodies, Runner } = Matter;
  const engine = Engine.create();
  const world = engine.world;
  world.gravity.y = 1.2;
  const runner = Runner.create();
  Runner.run(runner, engine);
  state.physics.engine = engine;
  state.physics.world = world;
  state.physics.runner = runner;

  buildGroundBodies();
  buildWalls();
}

function buildGroundBodies() {
  if (!state.physics || !state.physics.world) return;
  const { Bodies, World } = Matter;
  const textArea = document.getElementById('textArea');
  if (!textArea) return;
  const rect = textArea.getBoundingClientRect();
  // Clear old
  state.physics.groundBodies.forEach(b => Matter.World.remove(state.physics.world, b));
  state.physics.groundBodies = [];
  // Create per-line grounds to catch letters
  const style = getComputedStyle(textArea);
  const fontSize = parseFloat(style.fontSize) || 24;
  const lineHeight = fontSize * 1.4;
  const numLines = Math.floor(rect.height / lineHeight);
  for (let i = 0; i <= numLines; i += 1) {
    const y = i * lineHeight + 8; // small offset
    const ground = Bodies.rectangle(rect.width / 2, y, rect.width + 200, 8, { isStatic: true, restitution: 0.2, friction: 0.6, render: { visible: false } });
    state.physics.groundBodies.push(ground);
  }
  Matter.World.add(state.physics.world, state.physics.groundBodies);
}

function buildWalls() {
  if (!state.physics || !state.physics.world) return;
  const { Bodies, World } = Matter;
  const textArea = document.getElementById('textArea');
  if (!textArea) return;
  const rect = textArea.getBoundingClientRect();
  // Clear old walls
  state.physics.wallBodies.forEach(b => Matter.World.remove(state.physics.world, b));
  state.physics.wallBodies = [];
  const thickness = 40;
  const left = Bodies.rectangle(-thickness / 2, rect.height / 2, thickness, rect.height * 2, { isStatic: true });
  const right = Bodies.rectangle(rect.width + thickness / 2, rect.height / 2, thickness, rect.height * 2, { isStatic: true });
  state.physics.wallBodies.push(left, right);
  Matter.World.add(state.physics.world, state.physics.wallBodies);
}

function addLetterBody(el, x, startY, baselineTop) {
  const { Bodies, Body, World } = Matter;
  const textArea = document.getElementById('textArea');
  const rect = textArea.getBoundingClientRect();
  const style = getComputedStyle(textArea);
  const fontSize = parseFloat(style.fontSize) || 24;
  const width = el.getBoundingClientRect().width || fontSize * 0.6;
  const height = fontSize * 1.1;
  // Position in physics space (textArea local coords)
  const body = Bodies.rectangle(x + width / 2, startY, Math.max(8, width), Math.max(14, height), {
    restitution: 0.5,
    friction: 0.4,
    density: 0.0015,
  });
  World.add(state.physics.world, body);
  state.physics.letterBodies.push({ body, el });

  // Sync DOM position on each tick
  const update = () => {
    const pos = body.position;
    el.style.left = `${pos.x - width / 2}px`;
    el.style.top = `${pos.y - height / 2}px`;
  };
  if (!addLetterBody._bound) {
    addLetterBody._bound = true;
    Matter.Events.on(state.physics.engine, 'afterUpdate', () => {
      let anyMoving = false;
      for (const item of state.physics.letterBodies) {
        const w = item.el.getBoundingClientRect().width || width;
        const h = fontSize * 1.1;
        item.el.style.left = `${item.body.position.x - w / 2}px`;
        item.el.style.top = `${item.body.position.y - h / 2}px`;
        if (Math.abs(item.body.velocity.x) > 0.05 || Math.abs(item.body.velocity.y) > 0.05) anyMoving = true;
      }
      if (anyMoving) {
        state.physics.settleCounter = 0;
        state.physics.snapped = false;
      } else {
        state.physics.settleCounter += 1;
        if (!state.physics.snapped && state.physics.settleCounter > 20) {
          // After ~20 frames of rest, snap to typeset grid
          snapLettersToTypesetGrid();
          state.physics.snapped = true;
        }
      }
    });
  }
}

function clearLetterBodies() {
  const { World } = Matter;
  for (const { body } of state.physics.letterBodies) {
    World.remove(state.physics.world, body);
  }
  state.physics.letterBodies = [];
}

function reflowExistingLetters() {
  // Rebuild physics bodies and update DOM letter positions based on new font metrics
  if (state.physics.enabled && !state.physics.world) return;
  const container = document.getElementById('textArea');
  const letters = Array.from(container.querySelectorAll('.typed-letter'));
  if (letters.length === 0) return;
  if (state.physics.enabled) clearLetterBodies();
  // Recompute positions using events order
  if (nextCaretPosition.measurer) {
    nextCaretPosition.measurer.remove();
    nextCaretPosition.measurer = null;
    nextCaretPosition.x = 0;
    nextCaretPosition.y = 0;
  }
  const evs = state.events;
  const { lineHeight, offsets } = computeLineLayoutOffsets(container);
  // Reset DOM positions before re-adding bodies
  const containerRect = container.getBoundingClientRect();
  let letterIndex = 0;
  const style = getComputedStyle(container);
  const rect = container.getBoundingClientRect();
  const padding = 0;
  const maxWidth = rect.width - padding * 2;
  let currentLineKey = 0; let currentOffset = 0; let spacingAdjust = 0; let cursorX = 0; let cursorY = 0;
  for (const ev of evs) {
    const pos = nextCaretPosition(container, ev.char);
    // Alignment adjustments
    const lineKey = Math.round(pos.y / lineHeight);
    const found = offsets.find(o => o.key === lineKey);
    const lineOffset = found ? found.offset : 0;
    const extraSpace = found ? found.spacingAdjust : 0;
    const measured = measureChar(container, ev.char, style);
    const alignedX = (ev.char === '\n') ? 0 : (pos.x + lineOffset + (extraSpace && pos.x > 0 ? (Math.floor((pos.x) / measured) * extraSpace) : 0));
    const alignedPos = { x: alignedX, y: pos.y };
    if (ev.char !== '\n') {
      const el = letters[letterIndex++];
      if (!el) continue;
      if (state.physics.enabled) {
        el.style.left = `${alignedPos.x}px`;
        el.style.top = `-64px`;
        addLetterBody(el, alignedPos.x, -64, alignedPos.y);
      } else {
        // Arc to final aligned position
        gsap.to(el, { left: alignedPos.x, top: alignedPos.y, duration: 0.6, ease: 'power3.out' });
      }
    }
  }
}

function snapLettersToTypesetGrid() {
  const container = document.getElementById('textArea');
  if (!container) return;
  if (nextCaretPosition.measurer) {
    nextCaretPosition.measurer.remove();
    nextCaretPosition.measurer = null;
    nextCaretPosition.x = 0;
    nextCaretPosition.y = 0;
  }
  const letters = Array.from(container.querySelectorAll('.typed-letter'));
  if (letters.length === 0) return;
  // Compute target positions per stored events order
  const { lineHeight, offsets } = computeLineLayoutOffsets(container);
  const style = getComputedStyle(container);
  const targets = [];
  for (const ev of state.events) {
    const pos = nextCaretPosition(container, ev.char);
    const lineKey = Math.round(pos.y / lineHeight);
    const found = offsets.find(o => o.key === lineKey);
    const lineOffset = found ? found.offset : 0;
    const extraSpace = found ? found.spacingAdjust : 0;
    const measured = measureChar(container, ev.char, style);
    const alignedX = (ev.char === '\n') ? 0 : (pos.x + lineOffset + (extraSpace && pos.x > 0 ? (Math.floor((pos.x) / measured) * extraSpace) : 0));
    if (ev.char !== '\n') targets.push({ x: alignedX, y: pos.y });
  }
  const items = state.physics.letterBodies;
  const count = Math.min(items.length, targets.length);
  // Disable physics and tween letters into place
  for (let i = 0; i < count; i += 1) {
    const { body, el } = items[i];
    Matter.Body.setStatic(body, true);
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(container);
    const fontSize = parseFloat(style.fontSize) || 24;
    const w = rect.width || fontSize * 0.6;
    const h = fontSize * 1.1;
    const tx = targets[i].x;
    const ty = targets[i].y;
    gsap.to(el, { left: tx, top: ty, duration: 0.35, ease: 'power2.out' });
    // Keep physics body in sync after tween completes
    gsap.to({}, { duration: 0.36, onComplete: () => {
      Matter.Body.setPosition(body, { x: tx + w / 2, y: ty + h / 2 });
    }});
  }
}

// Storage
const STORAGE_KEY = 'music-letter-v1';
function persistToStorage() {
  try {
    const data = {
      theme: state.theme,
      font: getComputedStyle(document.documentElement).getPropertyValue('--font-serif') || 'Playfair Display',
      palette: document.getElementById('paletteSelect')?.value || 'majorC',
      events: state.events,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { /* ignore */ }
}

function restoreFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.theme) setTheme(data.theme);
    if (data.font) setFont(String(data.font).replace(/['",]/g, '').trim());
    if (data.palette) {
      const ps = document.getElementById('paletteSelect');
      if (ps) ps.value = data.palette;
      state.keyToNote = buildKeyToNote(data.palette);
    }
    if (Array.isArray(data.events)) {
      // Rebuild letters visually without sounds
      const container = document.getElementById('textArea');
      // reset caret
      if (nextCaretPosition.measurer) {
        nextCaretPosition.measurer.remove();
        nextCaretPosition.measurer = null;
        nextCaretPosition.x = 0;
        nextCaretPosition.y = 0;
      }
      state.events = [];
      for (const ev of data.events) {
        const pos = nextCaretPosition(container, ev.char);
        if (ev.char !== '\n') createLetterSpan(ev.char, container, pos.x, pos.y);
        recordEvent(ev.char, ev.note, pos);
      }
    }
  } catch (e) { /* ignore */ }
}

function init() {
  // Set default theme
  setTheme('classic');
  document.documentElement.setAttribute('data-theme', 'classic');
  // Default font spacing assignment handled by setTheme

  const sheet = document.getElementById('letterSheet');
  sheet.addEventListener('keydown', handleKeyDown);
  sheet.addEventListener('pointerdown', () => sheet.focus());
  sheet.focus();

  document.getElementById('playBtn').addEventListener('click', playSequence);
  document.getElementById('clearBtn').addEventListener('click', clearAll);

  const themeSelect = document.getElementById('themeSelect');
  themeSelect.addEventListener('change', (e) => setTheme(e.target.value));
  // Custom font picker
  const fontPickerBtn = document.getElementById('fontPickerBtn');
  const fontPickerList = document.getElementById('fontPickerList');
  const fontPicker = document.getElementById('fontPicker');
  const closeList = () => {
    fontPickerList.classList.remove('open');
    fontPickerBtn.setAttribute('aria-expanded', 'false');
  };
  fontPickerBtn.addEventListener('click', () => {
    const open = fontPickerList.classList.toggle('open');
    fontPickerBtn.setAttribute('aria-expanded', String(open));
    if (open) fontPickerList.focus();
  });
  fontPickerList.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const font = li.getAttribute('data-font');
    fontPickerBtn.textContent = font;
    setFont(font);
    closeList();
  });
  document.addEventListener('click', (e) => {
    if (!fontPicker.contains(e.target)) closeList();
  });
  const paletteSelect = document.getElementById('paletteSelect');
  paletteSelect.addEventListener('change', (e) => {
    state.keyToNote = buildKeyToNote(e.target.value);
    persistToStorage();
  });
  const alignSelect = document.getElementById('alignSelect');
  alignSelect.addEventListener('change', (e) => setAlign(e.target.value));
  const soundSelect = document.getElementById('soundSelect');
  soundSelect.addEventListener('change', (e) => {
    ensureAudio().then(() => setSoundPreset(e.target.value));
  });
  const volumeRange = document.getElementById('volumeRange');
  volumeRange.addEventListener('input', (e) => setMasterVolumeDb(parseFloat(e.target.value)));

  // Export/Import
  document.getElementById('exportJsonBtn').addEventListener('click', exportAsJson);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', handleImportJson);
  document.getElementById('exportWavBtn').addEventListener('click', exportAsWav);

  // Physics
  initPhysics();
  // Rebuild grounds on resize as layout changes
  window.addEventListener('resize', () => buildGroundBodies());

  // Restore
  restoreFromStorage();
}

// Master volume
function setMasterVolumeDb(db) {
  try { Tone.Destination.volume.value = db; } catch (_) {}
}

function exportAsJson() {
  const data = {
    theme: state.theme,
    font: getComputedStyle(document.documentElement).getPropertyValue('--font-serif').replace(/['",]/g, '').trim(),
    palette: document.getElementById('paletteSelect')?.value || 'majorC',
    events: state.events,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'music-letter.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleImportJson(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      clearAll();
      if (data.theme) setTheme(data.theme);
      if (data.font) setFont(String(data.font));
      if (data.palette) {
        document.getElementById('paletteSelect').value = data.palette;
        state.keyToNote = buildKeyToNote(data.palette);
      }
      const container = document.getElementById('textArea');
      if (nextCaretPosition.measurer) {
        nextCaretPosition.measurer.remove();
        nextCaretPosition.measurer = null;
        nextCaretPosition.x = 0;
        nextCaretPosition.y = 0;
      }
      state.events = [];
      for (const e of (data.events || [])) {
        const pos = nextCaretPosition(container, e.char);
        if (e.char !== '\n') createLetterSpan(e.char, container, pos.x, pos.y);
        recordEvent(e.char, e.note, pos);
      }
      persistToStorage();
    } catch (_) {}
    ev.target.value = '';
  };
  reader.readAsText(file);
}

async function exportAsWav() {
  // Render scheduled notes in an OfflineContext to a WAV Blob
  try {
    if (!state.events.length) return;
    const relStart = state.events[0].time;
    const rel = state.events.map(e => ({ t: Math.max(0, e.time - relStart), note: e.note })).filter(e => e.note);
    const totalDur = (rel.length ? rel[rel.length - 1].t : 0) + 0.8;

    const sampleRate = 44100;
    const offline = new Tone.Offline(({ transport }) => {
      const reverb = new Tone.Reverb({ decay: 1.6, wet: 0.2 }).toDestination();
      const delay = new Tone.FeedbackDelay({ delayTime: 0.15, feedback: 0.15, wet: 0.12 }).connect(reverb);
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.5 },
      }).connect(delay);
      const part = new Tone.Part((time, v) => synth.triggerAttackRelease(v.note, 0.22, time), rel.map(r => [r.t, { note: r.note }]));
      part.start(0);
      transport.start();
    }, totalDur, sampleRate);

    const buffer = await offline;
    const wav = toneAudioBufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'music-letter.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    // ignore
  }
}

// Helper: convert Tone.js AudioBuffer to WAV ArrayBuffer
function toneAudioBufferToWav(toneBuffer) {
  const numChannels = toneBuffer.numberOfChannels;
  const length = toneBuffer.length * numChannels * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + toneBuffer.length * numChannels * 2, true);
  writeString(view, 8, 'WAVE');
  // FMT sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, toneBuffer.sampleRate, true);
  view.setUint32(28, toneBuffer.sampleRate * numChannels * 2, true); // ByteRate
  view.setUint16(32, numChannels * 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, toneBuffer.length * numChannels * 2, true);

  // Interleave channels
  const channels = [];
  for (let i = 0; i < numChannels; i += 1) {
    channels.push(toneBuffer.getChannelData(i));
  }
  let offset = 44;
  const sampleCount = toneBuffer.length;
  for (let i = 0; i < sampleCount; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      let sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

window.addEventListener('DOMContentLoaded', init);


