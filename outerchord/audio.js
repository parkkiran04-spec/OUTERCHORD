// ---------- interactive sound engine ----------
// A small synth: clicking, moving the pointer, and a few of the scene's
// own animations (the ring's spin, the beam's swing, a star catching
// the light) each trigger a short tone. Nothing about this is shown on
// screen — every tone is also POSTed to the server's /api/sound-log
// endpoint (see server.ps1) so the session's sequence of notes is kept,
// without ever appearing in the UI. Opened as a plain file, or on static
// hosting with no server behind it (e.g. GitHub Pages), that request
// fails quietly — so every event is also kept in this browser, the same
// way the other pieces do, and make chord reads it from there instead.
(() => {
  const LOCAL_KEY = 'outerchord.soundlog.v1';
  function keepLocal(data) {
    try {
      const list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
      list.push(data);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(-5000)));
    } catch (e) { /* storage blocked or full */ }
  }
  // C major pentatonic, C3..A5 — no two adjacent scale degrees clash,
  // so whatever position/order they land in, they still sound musical.
  const SCALE_HZ = [
    130.81, 146.83, 164.81, 196.00, 220.00,   // C3 D3 E3 G3 A3
    261.63, 293.66, 329.63, 392.00, 440.00,   // C4 D4 E4 G4 A4
    523.25, 587.33, 659.25, 783.99, 880.00,   // C5 D5 E5 G5 A5
  ];

  let ctx = null;
  let master = null;

  function ensureStarted() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    return ctx;
  }

  function resumeIfNeeded() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function ctxReady() {
    return !!ctx && ctx.state === 'running';
  }

  function noteIndexFromX(xNorm) {
    const i = Math.round(xNorm * (SCALE_HZ.length - 1));
    return Math.max(0, Math.min(SCALE_HZ.length - 1, i));
  }

  // kept locally first (so make chord has it even without a server), then
  // fire-and-forget POSTed to the server when there is one
  function logEvent(data) {
    keepLocal(data);
    try {
      navigator.sendBeacon
        ? navigator.sendBeacon('api/sound-log', JSON.stringify(data))
        : fetch('api/sound-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            keepalive: true,
          }).catch(() => {});
    } catch (e) { /* storage is a nice-to-have, never worth a crash */ }
  }

  // a tone with its own filter + gain envelope; returns a handle you can
  // .release(now, tail) to fade out, used for held notes (click + hold)
  function startTone({ freq, type = 'sine', brightness = 0.5, peakGain = 0.18 }) {
    if (!ctx) return null;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500 + brightness * 4500;
    filter.Q.value = 0.7;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);

    osc.start(t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.015);

    return {
      osc, gain,
      release(sustainSeconds) {
        const t = ctx.currentTime;
        const tail = Math.max(0.12, Math.min(1.4, sustainSeconds * 0.6));
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.exponentialRampToValueAtTime(0.0008, t + tail);
        osc.stop(t + tail + 0.05);
      },
    };
  }

  // a single short, non-sustained blip — used for hover-blips, star
  // twinkle chimes, and the ring's tick
  function playBlip({ freq, type = 'sine', duration = 0.14, peakGain = 0.07, brightness = 0.6 }) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500 + brightness * 4500;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  // a brief burst of filtered noise — used for the beam's directional
  // whoosh, where a tuned pitch would feel wrong
  let noiseBuffer = null;
  function getNoiseBuffer() {
    if (noiseBuffer) return noiseBuffer;
    const len = ctx.sampleRate * 1;
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function playWhoosh({ brightness = 0.5, peakGain = 0.05, duration = 0.35 }) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer();

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 400 + brightness * 2200;
    filter.Q.value = 0.9;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peakGain, t0 + duration * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
  }

  window.OuterchordAudio = {
    ensureStarted,
    resumeIfNeeded,
    ctxReady,
    noteIndexFromX,
    SCALE_HZ,
    startTone,
    playBlip,
    playWhoosh,
    logEvent,
  };
})();
