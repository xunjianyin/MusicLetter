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
  pattern: 'plain',
  synth: null,
  effects: { reverb: null, delay: null },
  keyToNote: {},
  events: [], // { char, note, time, x, y }
  lastKeyTs: 0,
  inactivityMs: 2500,
  scheduledTimeout: null,
  animationMode: 'arc', // 'arc' | 'physics'
  align: 'left', // 'left' | 'center' | 'right' | 'justify'
  welcomeText: 'Hi,\nJust typing.\nTurn poetry into song.',
  welcomeShown: true,
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

// Playback tuning to keep motion musical and pleasant
const playbackTuning = {
  maxPixelsPerSecond: 700,    // clamp max travel speed
  minSegmentSec: 0.12,        // ensure each hop has minimum duration
  noteOverlapSec: 0.06,       // small overlap for smoother transitions
  arcLiftMin: 20,
  arcLiftMax: 60,
  arcLiftFactor: 0.25,        // lift ~ 25% of dx
  // Timing thresholds for pleasant playback
  minTimeBetweenNotes: 0.08,  // minimum time between notes (seconds)
  maxTimeBetweenNotes: 2.0,   // maximum time between notes (seconds)
  // Elasticity settings
  letterElasticity: 0.5,      // letter bounce/restitution (0-1)
  playheadElasticity: 0.8,    // playhead bounce factor (0-2)
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

function setPattern(pattern) {
  state.pattern = pattern;
  document.documentElement.setAttribute('data-pattern', pattern);
  persistToStorage();
}

function updateContainerHeight(container, positions) {
  if (positions.length === 0) return;
  
  // Find the lowest position
  const maxY = Math.max(...positions.map(p => p.y));
  const style = getComputedStyle(container);
  const fontSize = parseFloat(style.fontSize) || 24;
  const lineHeight = fontSize * 1.4;
  
  // Calculate required height with padding
  const requiredHeight = maxY + lineHeight + 40; // extra padding for bottom
  const minHeight = parseFloat(getComputedStyle(container).minHeight) || 640;
  const finalHeight = Math.max(requiredHeight, minHeight);
  
  // Update container height if needed
  if (container.style.height !== `${finalHeight}px`) {
    container.style.height = `${finalHeight}px`;
    
    // Auto-scroll to show the latest content if needed
    const letterSheet = container.closest('.letter-sheet');
    if (letterSheet && requiredHeight > minHeight) {
      // Scroll to bottom with a small delay to allow DOM updates
      setTimeout(() => {
        letterSheet.scrollTop = letterSheet.scrollHeight - letterSheet.clientHeight;
      }, 50);
    }
  }
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
  console.log('ensureAudio called, synth exists:', !!state.synth);
  if (!state.synth) {
    console.log('Starting Tone.js...');
    await Tone.start();
    console.log('Tone started, configuring synth for theme:', state.theme);
    configureSynthForTheme(state.theme);
    console.log('Synth configured:', !!state.synth);
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
        onComplete: () => {
          // Ensure final position is set precisely
          span.style.left = `${targetLeft}px`;
          span.style.top = `${targetTop}px`;
        }
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

function updateCursorPosition(container) {
  // Update the visual cursor position based on current caret position
  const x = nextCaretPosition.x || 0;
  const y = nextCaretPosition.y || 0;
  container.style.setProperty('--cursor-x', `${x}px`);
  container.style.setProperty('--cursor-y', `${y}px`);
}

function initializeCursor(container) {
  // Initialize cursor position at start
  nextCaretPosition.x = 0;
  nextCaretPosition.y = 0;
  updateCursorPosition(container);
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

// Compute aligned layout target positions for all non-newline characters
function layoutEventsAligned(container, events, align = state.align) {
  const style = getComputedStyle(container);
  const fontSize = parseFloat(style.fontSize) || 24;
  const lineHeight = fontSize * 1.4;
  const rect = container.getBoundingClientRect();
  const maxWidth = rect.width;
  const positions = [];

  // Build lines from events
  let currentLine = [];
  let currentWidth = 0;
  const lines = [];
  const widths = [];
  for (const ev of events) {
    if (ev.char === '\n') {
      lines.push({ glyphs: currentLine, total: currentWidth });
      currentLine = [];
      currentWidth = 0;
      continue;
    }
    const w = measureChar(container, ev.char, style);
    if (currentLine.length > 0 && currentWidth + w > maxWidth) {
      lines.push({ glyphs: currentLine, total: currentWidth });
      currentLine = [];
      currentWidth = 0;
    }
    currentLine.push({ char: ev.char, width: w });
    currentWidth += w;
  }
  lines.push({ glyphs: currentLine, total: currentWidth });

  // Map glyph positions line by line
  let y = 0;
  for (let li = 0; li < lines.length; li += 1) {
    const { glyphs, total } = lines[li];
    if (glyphs.length === 0) {
      // empty line
      y += lineHeight;
      continue;
    }
    let startX = 0;
    let extraGap = 0;
    const isLast = li === lines.length - 1;
    if (align === 'center') {
      startX = Math.max(0, (maxWidth - total) / 2);
    } else if (align === 'right') {
      startX = Math.max(0, maxWidth - total);
    } else if (align === 'justify' && !isLast && glyphs.length > 1) {
      extraGap = Math.max(0, (maxWidth - total) / (glyphs.length - 1));
    }
    let x = startX;
    for (let gi = 0; gi < glyphs.length; gi += 1) {
      positions.push({ x, y });
      x += glyphs[gi].width + (gi < glyphs.length - 1 ? extraGap : 0);
    }
    y += lineHeight;
  }
  return { positions, lineHeight };
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
  state.scheduledTimeout = setTimeout(() => {
    // Only play if there are events with notes to play
    const eventsWithNotes = state.events.filter(e => e.note);
    console.log('Inactivity timeout triggered. Events with notes:', eventsWithNotes.length);
    if (eventsWithNotes.length > 0) {
      console.log('Starting playback...');
      playSequence().catch(err => console.error('Playback failed:', err));
    }
  }, state.inactivityMs);
}

function handleKeyDown(ev) {
  // Clear welcome text on first interaction
  if (state.welcomeShown) {
    clearWelcomeText();
  }
  
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
  
  // Record the event first
  const pos = { x: 0, y: 0 }; // temporary, will be updated
  recordEvent(char, note, pos);
  
  // Compute aligned positions for ALL events including the new one
  const layout = layoutEventsAligned(container, state.events, state.align);
  const allPositions = layout.positions;
  
  // Create the new letter span if not newline
  if (char !== '\n') {
    const target = allPositions[allPositions.length - 1] || { x: 0, y: 0 };
    createLetterSpan(char, container, target.x, target.y, true);
  }
  
  // Update positions of ALL existing letters to maintain alignment
  const letters = Array.from(container.querySelectorAll('.typed-letter'));
  
  // Expand container height to accommodate content
  updateContainerHeight(container, allPositions);
  
  // Kill any existing positioning animations to prevent overlaps during fast typing
  // But don't kill the drop animation of the newly created letter
  const existingLetters = char !== '\n' ? letters.slice(0, -1) : letters;
  gsap.killTweensOf(existingLetters);
  
  // Count how many non-newline events we have (should match letters.length)
  const nonNewlineEvents = state.events.filter(ev => ev.char !== '\n').length;
  const isNewLetter = char !== '\n';
  const existingLetterCount = isNewLetter ? letters.length - 1 : letters.length;
  
  let letterIndex = 0;
  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i];
    if (ev.char !== '\n' && letterIndex < letters.length && letterIndex < allPositions.length) {
      const el = letters[letterIndex];
      const target = allPositions[letterIndex];
      // Update event position for consistency
      ev.x = target.x;
      ev.y = target.y;
      
      // For fast typing, use shorter duration; for slow typing, use smoother animation
      const now = Date.now();
      const timeSinceLastKey = now - (state.lastKeyTs || 0);
      const isFastTyping = timeSinceLastKey < 150; // Less than 150ms between keys
      const duration = isFastTyping ? 0.1 : 0.3;
      
      // Animate existing letters to new positions (all letters should be positioned)
      // Only skip animation for the very last letter if it was just created
      const isLastLetterJustCreated = isNewLetter && letterIndex === letters.length - 1;
      if (!isLastLetterJustCreated) {
        gsap.to(el, { 
          left: target.x, 
          top: target.y, 
          duration: duration, 
          ease: isFastTyping ? 'power1.out' : 'power2.out'
        });
      }
      letterIndex++;
    }
  }

  state.lastKeyTs = Date.now();
  
  // Update cursor position to show where next character will appear
  updateCursorPosition(container);
  
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
  // Update cursor position
  const container = document.getElementById('textArea');
  updateCursorPosition(container);
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

function showWelcomeText() {
  if (!state.welcomeShown) return;
  
  const container = document.getElementById('textArea');
  const welcomeDiv = document.createElement('div');
  welcomeDiv.id = 'welcomeText';
  welcomeDiv.className = 'welcome-text';
  welcomeDiv.innerHTML = state.welcomeText.replace(/\n/g, '<br>');
  container.appendChild(welcomeDiv);
  
  // Fade in the welcome text
  gsap.fromTo(welcomeDiv, 
    { opacity: 0, y: 20 }, 
    { opacity: 0.7, y: 0, duration: 1.2, ease: 'power2.out' }
  );
}

function clearWelcomeText() {
  const welcomeDiv = document.getElementById('welcomeText');
  if (welcomeDiv) {
    gsap.to(welcomeDiv, {
      opacity: 0,
      y: -10,
      duration: 0.5,
      ease: 'power2.in',
      onComplete: () => welcomeDiv.remove()
    });
  }
  state.welcomeShown = false;
  
  // Update cursor position after clearing welcome text
  const container = document.getElementById('textArea');
  updateCursorPosition(container);
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
  // Reset cursor position
  initializeCursor(container);
  // Show welcome text again
  state.welcomeShown = true;
  showWelcomeText();
  persistToStorage();
}

function buildMotionPathFromEvents(containerRect) {
  // Build path using stored event positions (more reliable than DOM elements)
  const container = document.getElementById('textArea');
  const letterSheet = document.getElementById('letterSheet');
  const letterSheetRect = letterSheet.getBoundingClientRect();
  const containerRect2 = container.getBoundingClientRect();
  
  // Get points from events that have notes (visible letters)
  const points = state.events
    .filter(e => e.note && e.char !== '\n') // Only events with notes and not newlines
    .map(event => {
      // Convert stored positions to letter-sheet-relative coordinates
      const x = event.x + (containerRect2.left - letterSheetRect.left) + 32; // Add margin offset
      const y = event.y + (containerRect2.top - letterSheetRect.top) + 40; // Add margin offset
      return { x, y };
    });
  
  if (points.length === 0) return null;
  return points;
}

function stopPlayback() {
  const ball = document.getElementById('ball');
  const trailLayer = document.getElementById('trailLayer');
  
  // Stop all animations and hide ball
  gsap.killTweensOf(ball);
  gsap.set(ball, { opacity: 0 });
  
  // Clear trail
  if (trailLayer) trailLayer.innerHTML = '';
  
  // Stop audio transport
  if (Tone.Transport.state === 'started') {
    Tone.Transport.stop();
    Tone.Transport.position = 0;
  }
}

async function playSequence() {
  console.log('playSequence called, events:', state.events.length);
  if (!state.events.length) return;
  
  // Check if there are any events with notes to play
  const eventsWithNotes = state.events.filter(e => e.note);
  console.log('Events with notes:', eventsWithNotes.length);
  if (eventsWithNotes.length === 0) return;
  
  console.log('Ensuring audio...');
  await ensureAudio();
  console.log('Audio ready, synth:', !!state.synth);
  
  // Stop any existing playback first
  stopPlayback();

  const ball = document.getElementById('ball');
  const trailLayer = document.getElementById('trailLayer');
  const container = document.getElementById('textArea');
  const rect = container.getBoundingClientRect();
  const points = buildMotionPathFromEvents(rect);
  if (!points || points.length === 0) return;

  // Normalize times relative to the first event with timing adjustments
  // Use only events with notes for timing calculations
  const noteEvents = state.events.filter(e => e.note);
  const startTime = noteEvents[0].time;
  
  // First pass: create basic timing array
  const rel = noteEvents.map((e, i) => ({
    ...e,
    t: Math.max(0, e.time - startTime)
  }));
  
  // Second pass: apply timing thresholds for pleasant playback
  for (let i = 1; i < rel.length; i++) {
    const prevTime = rel[i - 1].t;
    const timeDiff = rel[i].t - prevTime;
    
    // Clamp timing between notes to pleasant range
    if (timeDiff < playbackTuning.minTimeBetweenNotes) {
      rel[i].t = prevTime + playbackTuning.minTimeBetweenNotes;
    } else if (timeDiff > playbackTuning.maxTimeBetweenNotes) {
      rel[i].t = prevTime + playbackTuning.maxTimeBetweenNotes;
    }
  }

  // Create a Tone.Part to schedule in order (will be triggered by onUpdate sync)
  console.log('Creating Tone.Part with', rel.length, 'note events');
  const part = new Tone.Part((time, value) => {
    console.log('Playing note:', value.note, 'at time:', time);
    if (value.note) state.synth?.triggerAttackRelease(value.note, 0.22, time);
  }, rel.map((e, i) => [e.t, { note: e.note, index: i }]));
  part.start(0);
  console.log('Tone.Part started');

  // Compute total duration slightly beyond last event
  const totalDur = (rel[rel.length - 1].t || 0) + 0.35;

  // Clean up any existing animations and trail, then show ball
  gsap.killTweensOf(ball);
  trailLayer.innerHTML = ''; // Clear trail first
  
  // Position ball at the first letter but keep it invisible (only trail will show)
  const firstPoint = points[0];
  gsap.set(ball, { 
    opacity: 0, // Hide the main ball - only trail will be visible
    x: firstPoint.x, 
    y: firstPoint.y, 
    scale: 1,
    rotation: 0,
    transformOrigin: 'center center'
  });
  
  // Ensure the ball has the correct playhead style applied for trail matching
  if (state.playhead && state.playhead.className) {
    ball.className = `ball ${state.playhead.className}`;
  } else {
    ball.className = 'ball';
  }

  // Build bezier arcs between successive points
  const lastT = rel[rel.length - 1].t || 0.0001;
  const keyframes = points.map((p, i) => ({
    x: p.x,
    y: p.y,
    t: (rel[i]?.t ?? (i / (points.length - 1) * lastT)) / totalDur,
  }));

  // Fallback linear timing if inconsistent
  for (let i = 0; i < keyframes.length; i += 1) {
    if (!isFinite(keyframes[i].t)) keyframes[i].t = i / Math.max(1, keyframes.length - 1);
  }

  // Build a piecewise timeline using quadratic bezier curves to simulate arcs
  const tl = gsap.timeline({ defaults: { ease: 'power1.inOut' } });
  const local = (pt) => ({ x: pt.x, y: pt.y });
  const playNoteAtIndex = (idx, when) => {
    const e = rel[idx];
    if (e?.note) {
      // Slight voice overlap to avoid choppy transitions
      state.synth?.triggerAttackRelease(e.note, 0.22 + playbackTuning.noteOverlapSec, when);
    }
  };
  const speedRatio = (state.playhead?.speedRatio) ?? 1.0;
  const trailScale = (state.playhead?.trailScale) ?? 1.0;
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = local(keyframes[i]);
    const b = local(keyframes[i + 1]);
    // Duration clamping by distance
    const dx = b.x - a.x; const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    let segDur = (keyframes[i + 1].t - keyframes[i].t) * totalDur;
    const speedLimited = dist / playbackTuning.maxPixelsPerSecond;
    segDur = Math.max(playbackTuning.minSegmentSec, Math.max(segDur, speedLimited));
    segDur = segDur / speedRatio; // apply style speed ratio
    // Arc control point: mid x between a and b, elevated y by -20..-60 px
    const midX = (a.x + b.x) / 2;
    const lift = Math.max(playbackTuning.arcLiftMin, Math.min(playbackTuning.arcLiftMax, Math.abs(a.x - b.x) * playbackTuning.arcLiftFactor));
    const cp = { x: midX, y: Math.min(a.y, b.y) - lift };
    tl.to(ball, {
      duration: segDur,
      motionPath: {
        path: [
          { x: a.x, y: a.y },
          { x: cp.x, y: cp.y },
          { x: b.x, y: b.y },
        ],
        curviness: 1.2 * playbackTuning.playheadElasticity,
        autoRotate: false,
      },
      // Add bouncy, lively animation
      scale: `${0.8 + 0.4 * playbackTuning.playheadElasticity}`,
      rotation: `${Math.random() * 20 - 10}deg`,
      ease: `elastic.out(${playbackTuning.playheadElasticity}, 0.3)`,
      onStart: () => {
        // On landing at a (except first), play previous note
        if (i === 0) playNoteAtIndex(0, '+0');
      },
      onComplete: () => {
        // Play note at landing point b
        playNoteAtIndex(i + 1, '+0');
      },
      onUpdate: () => {
        // Trail effect that matches the playhead shape
        const r = ball.getBoundingClientRect();
        const dot = document.createElement('div');
        
        // Make trail dot match the playhead style
        dot.className = `trail-dot ${state.playhead?.className || ''}`.trim();
        
        // Position the trail dot at the center of the ball
        const ballCenterX = r.left - rect.left + r.width / 2;
        const ballCenterY = r.top - rect.top + r.height / 2;
        dot.style.left = `${ballCenterX - 6}px`; // Center the 12px dot
        dot.style.top = `${ballCenterY - 6}px`;
        dot.style.transform = `scale(${trailScale})`; // Full size trail dots
        
        trailLayer.appendChild(dot);
        gsap.to(dot, { opacity: 0, scale: 0.3, duration: 0.6, ease: 'power1.out', onComplete: () => dot.remove() });
      },
    }, i === 0 ? 0 : undefined);
  }
  // No need to fade out ball since it's already hidden
  
  // Start transport immediately to ensure Part can schedule properly
  console.log('Starting Tone.Transport...');
  Tone.Transport.start('+0.05');
  console.log('Transport started, state:', Tone.Transport.state);
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
    restitution: playbackTuning.letterElasticity,
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
  // Compute aligned positions anew
  const { positions } = layoutEventsAligned(container, state.events, state.align);
  // Update container height for new positions
  updateContainerHeight(container, positions);
  // Reset DOM positions before re-adding bodies
  const containerRect = container.getBoundingClientRect();
  let letterIndex = 0;
  for (const ev of state.events) {
    if (ev.char !== '\n') {
      const alignedPos = positions[letterIndex];
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
  
  // Update cursor position after reflow
  updateCursorPosition(container);
}

function snapLettersToTypesetGrid() {
  const container = document.getElementById('textArea');
  if (!container) return;
  const letters = Array.from(container.querySelectorAll('.typed-letter'));
  if (letters.length === 0) return;
  // Compute target positions per stored events order
  const { positions: targets } = layoutEventsAligned(container, state.events, state.align);
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
      pattern: state.pattern,
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
    if (data.pattern) setPattern(data.pattern);
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
  // Set default theme and sound palette
  state.theme = 'classic';
  document.documentElement.setAttribute('data-theme', 'classic');
  state.keyToNote = buildKeyToNote(themes['classic']?.soundPalette || 'majorC');
  
  // Configure synth for theme
  try {
    if (Tone.getContext().state === 'running' && state.synth) {
      configureSynthForTheme('classic');
    }
  } catch (_) {}
  
  const sheet = document.getElementById('letterSheet');
  sheet.addEventListener('keydown', handleKeyDown);
  sheet.addEventListener('pointerdown', (e) => {
    // Don't focus if the click is within the font picker area
    const fontPicker = document.getElementById('fontPicker');
    const fontPickerRect = fontPicker.getBoundingClientRect();
    const isInFontPicker = (
      e.clientX >= fontPickerRect.left && 
      e.clientX <= fontPickerRect.right && 
      e.clientY >= fontPickerRect.top && 
      e.clientY <= fontPickerRect.bottom
    );
    
    if (!isInFontPicker) {
      // Clear welcome text on first click
      if (state.welcomeShown) {
        clearWelcomeText();
      }
      sheet.focus();
    }
  });
  sheet.focus();

  document.getElementById('playBtn').addEventListener('click', playSequence);
  document.getElementById('clearBtn').addEventListener('click', clearAll);

  const themeSelect = document.getElementById('themeSelect');
  themeSelect.addEventListener('change', (e) => setTheme(e.target.value));
  const patternSelect = document.getElementById('patternSelect');
  patternSelect.addEventListener('change', (e) => setPattern(e.target.value));
  // Custom font picker
  const fontPickerBtn = document.getElementById('fontPickerBtn');
  const fontPickerList = document.getElementById('fontPickerList');
  const fontPicker = document.getElementById('fontPicker');
  const closeList = () => {
    fontPickerList.classList.remove('open');
    fontPickerBtn.setAttribute('aria-expanded', 'false');
    // Clear any highlights when closing
    const listItems = fontPickerList.querySelectorAll('li');
    listItems.forEach(li => li.classList.remove('highlighted'));
  };
  fontPickerBtn.addEventListener('click', () => {
    const open = fontPickerList.classList.toggle('open');
    fontPickerBtn.setAttribute('aria-expanded', String(open));
    if (open) fontPickerList.focus();
  });
  // Enhanced font picker click handling with mouse position detection
  // Use capture phase to ensure we get the event first
  fontPickerList.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const li = e.target.closest('li');
    if (!li) return;
    const font = li.getAttribute('data-font');
    fontPickerBtn.textContent = font;
    setFont(font);
    closeList();
  }, true); // Use capture phase
  
  // Also add mousedown handler as backup
  fontPickerList.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);
  
  // Add direct event listeners to each font item as additional safeguard
  const fontItems = fontPickerList.querySelectorAll('li');
  fontItems.forEach(li => {
    li.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const font = li.getAttribute('data-font');
      if (font) {
        fontPickerBtn.textContent = font;
        setFont(font);
        closeList();
      }
    }, true); // Use capture phase
    
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  });
  
  // Add scroll handling for font picker
  let fontPickerScrollHandler = null;
  
  const addFontPickerScrolling = () => {
    if (fontPickerScrollHandler) return; // Already added
    
    fontPickerScrollHandler = (e) => {
      const fontPickerRect = fontPicker.getBoundingClientRect();
      const fontPickerListRect = fontPickerList.getBoundingClientRect();
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      
      // Check if mouse is within font picker area
      const isInFontPicker = (
        mouseX >= fontPickerRect.left && 
        mouseX <= fontPickerRect.right && 
        mouseY >= fontPickerRect.top && 
        mouseY <= fontPickerRect.bottom
      );
      
      const isInFontList = fontPickerList.classList.contains('open') && (
        mouseX >= fontPickerListRect.left && 
        mouseX <= fontPickerListRect.right && 
        mouseY >= fontPickerListRect.top && 
        mouseY <= fontPickerListRect.bottom
      );
      
      if (isInFontList) {
        e.preventDefault();
        e.stopPropagation();
        
        // Scroll the font picker list
        const delta = e.deltaY;
        fontPickerList.scrollTop += delta * 0.5; // Smooth scrolling
        
        // Update highlighted item based on mouse position
        updateFontPickerHighlight(mouseX, mouseY);
      }
    };
    
    document.addEventListener('wheel', fontPickerScrollHandler, { passive: false });
  };
  
  const updateFontPickerHighlight = (mouseX, mouseY) => {
    const listItems = fontPickerList.querySelectorAll('li');
    
    // Clear existing highlights
    listItems.forEach(li => li.classList.remove('highlighted'));
    
    // Find item under mouse and highlight it
    for (const li of listItems) {
      const liRect = li.getBoundingClientRect();
      if (mouseX >= liRect.left && mouseX <= liRect.right && 
          mouseY >= liRect.top && mouseY <= liRect.bottom) {
        li.classList.add('highlighted');
        break;
      }
    }
  };
  
  // Add mousemove handler for highlighting
  document.addEventListener('mousemove', (e) => {
    if (fontPickerList.classList.contains('open')) {
      const fontPickerListRect = fontPickerList.getBoundingClientRect();
      const isInFontList = (
        e.clientX >= fontPickerListRect.left && 
        e.clientX <= fontPickerListRect.right && 
        e.clientY >= fontPickerListRect.top && 
        e.clientY <= fontPickerListRect.bottom
      );
      
      if (isInFontList) {
        updateFontPickerHighlight(e.clientX, e.clientY);
      }
    }
  });
  
  // Initialize scroll handling
  addFontPickerScrolling();
  
  // Add mouse position detection for font picker area
  document.addEventListener('click', (e) => {
    const fontPickerRect = fontPicker.getBoundingClientRect();
    const fontPickerListRect = fontPickerList.getBoundingClientRect();
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Check if click is within font picker button area
    const isInButton = (
      mouseX >= fontPickerRect.left && 
      mouseX <= fontPickerRect.right && 
      mouseY >= fontPickerRect.top && 
      mouseY <= fontPickerRect.bottom
    );
    
    // Check if click is within font picker list area (when open)
    const isInList = fontPickerList.classList.contains('open') && (
      mouseX >= fontPickerListRect.left && 
      mouseX <= fontPickerListRect.right && 
      mouseY >= fontPickerListRect.top && 
      mouseY <= fontPickerListRect.bottom
    );
    
    // If clicking within the font picker area, handle font selection
    if (isInList) {
      e.preventDefault();
      e.stopPropagation();
      
      // Find which li element was clicked
      const listItems = fontPickerList.querySelectorAll('li');
      for (const li of listItems) {
        const liRect = li.getBoundingClientRect();
        if (mouseX >= liRect.left && mouseX <= liRect.right && 
            mouseY >= liRect.top && mouseY <= liRect.bottom) {
          const font = li.getAttribute('data-font');
          fontPickerBtn.textContent = font;
          setFont(font);
          closeList();
          return;
        }
      }
    }
    
    // Close list if clicking outside font picker
    if (!isInButton && !isInList) {
      closeList();
    }
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
  const elasticityRange = document.getElementById('elasticityRange');
  elasticityRange.addEventListener('input', (e) => {
    playbackTuning.playheadElasticity = parseFloat(e.target.value);
    playbackTuning.letterElasticity = parseFloat(e.target.value) * 0.6; // Letters slightly less bouncy
  });
  const timingRange = document.getElementById('timingRange');
  timingRange.addEventListener('input', (e) => {
    const factor = parseFloat(e.target.value);
    playbackTuning.minTimeBetweenNotes = 0.08 * factor;
    playbackTuning.maxTimeBetweenNotes = 2.0 * factor;
  });
  const playheadSelect = document.getElementById('playheadSelect');
  playheadSelect.addEventListener('change', (e) => setPlayheadStyle(e.target.value));

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

  // Set default font to Pacifico (after restore to override stored settings)
  if (state.events.length === 0) {
    setFont('Pacifico');
  }

  // Show welcome text if no events exist
  if (state.events.length === 0) {
    showWelcomeText();
  }
  
  // Initialize cursor position
  const container = document.getElementById('textArea');
  initializeCursor(container);

  // Default playhead style
  setPlayheadStyle('kitten');

  // Controls collapse/expand
  const controls = document.getElementById('controls');
  const toggle = document.getElementById('controlsToggle');
  const setCollapsed = (collapsed) => {
    controls.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  toggle.addEventListener('click', () => {
    const isCollapsed = controls.classList.contains('collapsed');
    setCollapsed(!isCollapsed);
  });
}

// Master volume
function setMasterVolumeDb(db) {
  try { Tone.Destination.volume.value = db; } catch (_) {}
}

// Playhead appearance and behavior
const playheadPresets = {
  classic: { className: '', speedRatio: 1.0, trailScale: 1.0 },
  comet: { className: 'comet', speedRatio: 0.9, trailScale: 1.5 },
  star: { className: 'star', speedRatio: 1.05, trailScale: 1.0 },
  heart: { className: 'heart', speedRatio: 0.95, trailScale: 1.2 },
  flame: { className: 'flame', speedRatio: 0.85, trailScale: 1.8 },
  kitten: { className: 'kitten', speedRatio: 0.9, trailScale: 1.0 },
  diamond: { className: 'diamond', speedRatio: 1.1, trailScale: 0.9 },
};

function setPlayheadStyle(style) {
  const ball = document.getElementById('ball');
  state.playhead = playheadPresets[style] || playheadPresets.classic;
  
  // Clear any existing classes and apply new one
  ball.className = 'ball';
  if (state.playhead.className) {
    ball.classList.add(state.playhead.className);
  }
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


