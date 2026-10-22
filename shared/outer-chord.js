/* Outer Chord — what make chord, the phone page and the archive share.

   A song travels as a small "compact" object: per bar, its chord and the
   melody and percussion hits, every value already rounded to the grid it
   is played on. expand() turns that into the notes the synth plays, so a
   song sounds the same wherever it is opened — on the exhibition PC, from
   the archive, or on a visitor's phone after scanning its QR code.

     compact = { v: 1, bars,
                 chords: [[pc, …], …],                 one per bar, 1–3 pitch classes
                 mel:    [[[s, m, d, q, src, p], …], …] step, midi, length in steps,
                                                        velocity 0–7, source index, pan 0–7
                 dr:     [[[s, k, q, p], …], …] }       step, kind, velocity 0–3, pan 0–7

   encode()/decode() pack that into a short code (bits → deflate → base32)
   that fits in a QR code together with the address of the phone page. */
(function () {
  'use strict';

  /* ---------------- constants ---------------- */
  // The order is part of the song code (each melody note stores its
  // source's index), so new pieces only ever go on the end.
  const SOURCES = {
    cattle:     { name: 'Cattle Mutilation',          color: '#e0442c' },
    e:          { name: 'The Sound of not the Earth', color: '#7cc9a4' },
    d:          { name: 'Noctiluca',                  color: '#2fb3c2' },
    imnota:     { name: "I'm not an Alien",           color: '#b4a6de' },
    tenshi:     { name: 'Tenshi no Tsubasa',          color: '#f0ead8' },
    c3:         { name: 'Passacaglia',                color: '#e84175' },
    outerchord: { name: 'OUTER CHORD',                color: '#4c948e' },
  };
  const ORDER = Object.keys(SOURCES);
  const KINDS = ['kick', 'tick', 'wash'];
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const BPM = 84, BEAT = 60 / BPM, BAR = BEAT * 4, STEPS = 16, STEP = BAR / STEPS;
  const TAIL = 3.5;   // seconds of reverb left ringing after the last bar

  // Where the phone page lives. A QR code made on the exhibition PC
  // (localhost) has to point at the public copy of the site.
  const PUBLIC_BASE = 'https://parkkiran04-spec.github.io/OUTERCHORD/';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fold = (m, lo, hi) => { while (m < lo) m += 12; while (m > hi) m -= 12; return m; };
  const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const chordName = pcs => pcs.map(pc => NAMES[pc]).join(' · ');

  /* ---------------- compact song -> playable notes ---------------- */
  function expand(c) {
    const notes = [], drums = [], barInfo = [];
    for (let b = 0; b < c.bars; b++) {
      const t0 = b * BAR, chord = c.chords[b], root = chord[0];
      const pad = chord.map(pc => fold(pc + 48, 55, 66)).sort((x, y) => x - y);
      for (const m of pad) notes.push({ t: t0, dur: BAR * 1.02, midi: m, vel: .5, voice: 'pad', pan: (m - 60) / 12 });
      notes.push({ t: t0, dur: BEAT * 2.2, midi: fold(root + 36, 33, 44), vel: .8, voice: 'bass', pan: 0 });
      notes.push({ t: t0 + BEAT * 2, dur: BEAT * 1.8, midi: fold(root + 36, 33, 44), vel: .55, voice: 'bass', pan: 0 });
      for (const [s, m, d, q, src, p] of c.mel[b]) {
        const key = ORDER[src];
        notes.push({ t: t0 + s * STEP, dur: d * STEP, midi: m, vel: .3 + .7 * q / 7,
                     voice: key, src: key, pan: (-1 + 2 * p / 7) * .8 });
      }
      for (const [s, k, q, p] of c.dr[b]) {
        drums.push({ t: t0 + s * STEP, kind: KINDS[k], vel: (q + 1) / 4, pan: (-1 + 2 * p / 7) * .7 });
      }
      barInfo.push({ t: t0, chord: chord.slice() });
    }
    return { bars: c.bars, notes, drums, barInfo, length: c.bars * BAR, tail: TAIL };
  }

  // the rounding compose() uses, so that what it builds is exactly what decodes
  const q7 = v => clamp(Math.round(v * 7), 0, 7);              // 0..1 -> 0..7
  const qPan = p => clamp(Math.round((clamp(p, -1, 1) + 1) / 2 * 7), 0, 7);
  const qHit = v => clamp(Math.round(v * 4) - 1, 0, 3);        // 0..1 -> 0..3

  /* ---------------- packing ---------------- */
  function bitWriter() {
    const bytes = []; let acc = 0, n = 0;
    return {
      put(v, bits) { for (let i = bits - 1; i >= 0; i--) { acc = (acc << 1) | ((v >> i) & 1); if (++n === 8) { bytes.push(acc); acc = 0; n = 0; } } },
      done() { if (n) bytes.push(acc << (8 - n)); return new Uint8Array(bytes); },
    };
  }
  function bitReader(bytes) {
    let pos = 0;
    return { get(bits) { let v = 0; for (let i = 0; i < bits; i++) { const b = bytes[pos >> 3] >> (7 - (pos & 7)) & 1; v = (v << 1) | b; pos++; } return v; } };
  }

  function pack(c) {
    const w = bitWriter();
    w.put(1, 4);                 // format version
    w.put(c.bars, 6);
    for (let b = 0; b < c.bars; b++) {
      const ch = c.chords[b].slice(0, 3);
      w.put(ch.length, 2); for (const pc of ch) w.put(pc, 4);
      const mel = c.mel[b].slice(0, 15);
      w.put(mel.length, 4);
      for (const [s, m, d, q, src, p] of mel) { w.put(s, 4); w.put(m - 55, 6); w.put(d - 1, 3); w.put(q, 3); w.put(src, 3); w.put(p, 3); }
      const dr = c.dr[b].slice(0, 15);
      w.put(dr.length, 4);
      for (const [s, k, q, p] of dr) { w.put(s, 4); w.put(k, 2); w.put(q, 2); w.put(p, 3); }
    }
    return w.done();
  }
  function unpack(bytes) {
    const r = bitReader(bytes);
    if (r.get(4) !== 1) throw new Error('unknown song format');
    const bars = r.get(6), c = { v: 1, bars, chords: [], mel: [], dr: [] };
    for (let b = 0; b < bars; b++) {
      const nc = r.get(2), ch = []; for (let i = 0; i < nc; i++) ch.push(r.get(4));
      c.chords.push(ch.length ? ch : [0]);
      const nm = r.get(4), mel = [];
      for (let i = 0; i < nm; i++) mel.push([r.get(4), r.get(6) + 55, r.get(3) + 1, r.get(3), r.get(3), r.get(3)]);
      c.mel.push(mel);
      const nd = r.get(4), dr = [];
      for (let i = 0; i < nd; i++) dr.push([r.get(4), r.get(2), r.get(2), r.get(3)]);
      c.dr.push(dr);
    }
    return c;
  }

  async function squeeze(bytes, mode) {
    if (!window.CompressionStream) return null;
    const s = new Blob([bytes]).stream().pipeThrough(mode === 'in' ? new DecompressionStream('deflate-raw') : new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  // RFC 4648 base32, no padding: only A–Z and 2–7, which a QR code can
  // carry in its compact alphanumeric mode
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function toB32(bytes) {
    let out = '', acc = 0, n = 0;
    for (const b of bytes) { acc = (acc << 8) | b; n += 8; while (n >= 5) { out += B32[(acc >> (n - 5)) & 31]; n -= 5; } acc &= (1 << n) - 1; }
    if (n) out += B32[(acc << (5 - n)) & 31];
    return out;
  }
  function fromB32(str) {
    const out = []; let acc = 0, n = 0;
    for (const ch of str.toUpperCase().replace(/[^A-Z2-7]/g, '')) { acc = (acc << 5) | B32.indexOf(ch); n += 5; if (n >= 8) { out.push((acc >> (n - 8)) & 255); n -= 8; acc &= (1 << n) - 1; } }
    return new Uint8Array(out);
  }

  // first byte: 0 = raw bits, 1 = deflated bits
  async function encode(c) {
    const raw = pack(c);
    let body = raw, flag = 0;
    try { const z = await squeeze(raw, 'out'); if (z && z.length < raw.length) { body = z; flag = 1; } } catch (e) { /* keep raw */ }
    const all = new Uint8Array(body.length + 1); all[0] = flag; all.set(body, 1);
    return toB32(all);
  }
  async function decode(code) {
    const all = fromB32(code);
    if (!all.length) throw new Error('empty code');
    let body = all.subarray(1);
    if (all[0] === 1) body = await squeeze(body, 'in');
    return unpack(body);
  }

  /* ---------------- synth ---------------- */
  const m2f = m => 440 * Math.pow(2, (m - 69) / 12);

  function buildGraph(ctx) {
    const master = ctx.createGain(); master.gain.value = .7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = .01; comp.release.value = .25;
    master.connect(comp); comp.connect(ctx.destination);
    // a long, dark room made from decaying noise
    const len = Math.floor(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    const verb = ctx.createConvolver(); verb.buffer = ir;
    const verbIn = ctx.createGain(); verbIn.gain.value = .32;
    const verbTone = ctx.createBiquadFilter(); verbTone.type = 'lowpass'; verbTone.frequency.value = 3200;
    verbIn.connect(verbTone); verbTone.connect(verb); verb.connect(master);
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return { master, verbIn, noise };
  }
  // every voice ends in: gain envelope -> panner -> dry + reverb send
  function outlet(ctx, g, pan, send) {
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan || 0, -1, 1);
    const env = ctx.createGain(); env.gain.value = 0;
    env.connect(p); p.connect(g.master);
    const s = ctx.createGain(); s.gain.value = send; p.connect(s); s.connect(g.verbIn);
    return env;
  }
  function adsr(param, t, dur, peak, a, r) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.setValueAtTime(peak, t + Math.max(a, dur));
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(a, dur) + r);
    return t + Math.max(a, dur) + r + .05;
  }
  function osc(ctx, type, f, t, end, dest, detune) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    if (detune) o.detune.value = detune;
    o.connect(dest); o.start(t); o.stop(end);
    return o;
  }
  const VOICES = {
    pad(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan * .5, .55);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = .4; lp.connect(env);
      const end = adsr(env.gain, t, n.dur, .045 * n.vel, .7, 1.2);
      osc(ctx, 'sawtooth', m2f(n.midi), t, end, lp, -7);
      osc(ctx, 'sawtooth', m2f(n.midi), t, end, lp, 7);
    },
    bass(ctx, g, n, t) {
      const env = outlet(ctx, g, 0, .08);
      const end = adsr(env.gain, t, n.dur * .6, .32 * n.vel, .01, .5);
      osc(ctx, 'sine', m2f(n.midi), t, end, env);
      const h = ctx.createGain(); h.gain.value = .25; h.connect(env);
      osc(ctx, 'triangle', m2f(n.midi + 12), t, end, h);
    },
    // Cattle Mutilation: a raw, filtered saw pluck
    cattle(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .3);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
      lp.frequency.setValueAtTime(900 + n.vel * 3200, t);
      lp.frequency.exponentialRampToValueAtTime(380, t + n.dur + .2);
      lp.connect(env);
      const end = adsr(env.gain, t, n.dur * .5, .13 * n.vel, .005, .35);
      osc(ctx, 'sawtooth', m2f(n.midi), t, end, lp);
    },
    // The Sound of Not the Earth: a struck, bell-like FM tone
    e(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .45);
      const end = adsr(env.gain, t, .02, .16 * n.vel, .004, Math.max(.8, n.dur * 1.5));
      const f = m2f(n.midi);
      const car = osc(ctx, 'sine', f, t, end, env);
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 2.2, t); mg.gain.exponentialRampToValueAtTime(f * .05, t + .9);
      mg.connect(car.frequency);
      osc(ctx, 'sine', f * 3.5, t, end, mg);
    },
    // Noctiluca: a slow, glassy triangle with an octave shimmer
    d(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .6);
      const end = adsr(env.gain, t, n.dur, .12 * n.vel, .09, .9);
      osc(ctx, 'triangle', m2f(n.midi), t, end, env);
      const h = ctx.createGain(); h.gain.value = .18; h.connect(env);
      osc(ctx, 'sine', m2f(n.midi + 12), t, end, h, 4);
    },
    // I'm Not an Alien: an 8-bit square
    imnota(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .2);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600; lp.connect(env);
      const end = adsr(env.gain, t, n.dur * .8, .06 * n.vel, .003, .08);
      osc(ctx, 'square', m2f(n.midi), t, end, lp);
    },
    // Tenshi no Tsubasa: two soft sines with a slow vibrato, like a voice
    tenshi(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .7);
      const end = adsr(env.gain, t, n.dur, .1 * n.vel, .16, 1.1);
      const f = m2f(n.midi);
      const a = osc(ctx, 'sine', f, t, end, env, -5);
      const b = osc(ctx, 'sine', f, t, end, env, 6);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
      const depth = ctx.createGain(); depth.gain.value = f * .006;
      lfo.connect(depth); depth.connect(a.frequency); depth.connect(b.frequency);
      lfo.start(t); lfo.stop(end);
    },
    // Passacaglia: a plucked, harpsichord-like tone — a bright square with
    // a fast-closing filter and a quieter octave above
    c3(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .35);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
      lp.frequency.setValueAtTime(5200, t); lp.frequency.exponentialRampToValueAtTime(900, t + .35);
      lp.connect(env);
      const end = adsr(env.gain, t, .01, .07 * n.vel, .002, Math.max(.5, n.dur * .9));
      osc(ctx, 'square', m2f(n.midi), t, end, lp);
      const h = ctx.createGain(); h.gain.value = .35; h.connect(lp);
      osc(ctx, 'sawtooth', m2f(n.midi + 12), t, end, h, 3);
    },
    // OUTER CHORD: a glassy sine with a slow shimmer, the beam's hum
    outerchord(ctx, g, n, t) {
      const env = outlet(ctx, g, n.pan, .75);
      const end = adsr(env.gain, t, n.dur, .11 * n.vel, .05, 1.4);
      const f = m2f(n.midi);
      osc(ctx, 'sine', f, t, end, env);
      const h = ctx.createGain(); h.gain.value = .22; h.connect(env);
      osc(ctx, 'sine', f * 2.01, t, end, h);
      const s = ctx.createGain(); s.gain.value = .08; s.connect(env);
      osc(ctx, 'triangle', f * 3, t, end, s, -6);
    },
  };
  const DRUMS = {
    kick(ctx, g, d, t) {
      const env = outlet(ctx, g, d.pan, .05);
      const end = adsr(env.gain, t, .02, .55 * d.vel, .002, .32);
      const o = osc(ctx, 'sine', 120, t, end, env);
      o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + .28);
    },
    tick(ctx, g, d, t) {
      const env = outlet(ctx, g, d.pan, .35);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200; hp.connect(env);
      const end = adsr(env.gain, t, .005, .16 * d.vel, .001, .06);
      const s = ctx.createBufferSource(); s.buffer = g.noise; s.connect(hp); s.start(t); s.stop(end);
    },
    wash(ctx, g, d, t) {
      const env = outlet(ctx, g, d.pan, .8);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(2400, t + 1.4);
      bp.connect(env);
      const end = adsr(env.gain, t, .9, .05 * d.vel, .5, .9);
      const s = ctx.createBufferSource(); s.buffer = g.noise; s.loop = true; s.connect(bp); s.start(t); s.stop(end);
    },
  };
  // `from` seconds into the song: notes that start earlier are skipped, the
  // rest keep their places relative to it (used to resume after a pause)
  function schedule(ctx, song, at, from) {
    from = from || 0;
    const g = buildGraph(ctx);
    for (const n of song.notes) if (n.t >= from - 1e-6) (VOICES[n.voice] || VOICES.d)(ctx, g, n, at + n.t - from);
    for (const d of song.drums) if (d.t >= from - 1e-6) DRUMS[d.kind](ctx, g, d, at + d.t - from);
  }

  // A player that can be started, paused and stopped; time() is seconds
  // into the song. play() picks up where pause() left off.
  function player(song, onEnd) {
    let ac = null, startAt = 0, offset = 0, timer = 0;
    const self = {
      playing: false,
      time: () => (ac ? Math.max(0, offset + ac.currentTime - startAt) : offset),
      play() {
        if (offset >= song.length) offset = 0;
        const from = offset;
        self.halt();
        const AC = window.AudioContext || window.webkitAudioContext;
        ac = new AC();
        startAt = ac.currentTime + .15;
        offset = from;
        schedule(ac, song, startAt, from);
        self.playing = true;
        timer = setTimeout(() => { self.stop(); if (onEnd) onEnd(); }, (song.length + song.tail - from + .3) * 1000);
      },
      pause() {
        if (!self.playing) return;
        offset = self.time();
        self.halt();
      },
      stop() { self.halt(); offset = 0; },
      halt() {
        clearTimeout(timer);
        if (ac) { try { ac.close(); } catch (e) { /* already closed */ } ac = null; }
        self.playing = false;
      },
    };
    return self;
  }

  function toWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, rate, true); data.setUint32(28, rate * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
    str(36, 'data'); data.setUint32(40, len * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      const s = clamp(chans[c][i], -1, 1);
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return new Blob([data], { type: 'audio/wav' });
  }
  // the whole song rendered offline into a 16-bit stereo WAV
  async function renderWav(song) {
    const rate = 44100;
    const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.ceil((song.length + song.tail) * rate), rate);
    schedule(off, song, 0);
    return toWav(await off.startRendering());
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  /* ---------------- the record ----------------
     The whole piece as one spiral groove: bar 1 on the outside, each bar
     one turn further in, every melody note an arc in its piece's colour.
     `now` is seconds into the song (or -1 when stopped): the disc turns so
     the current moment sits under the needle. */
  const OUTER = .94, INNER = .36;
  const NEEDLE = -Math.PI / 4;   // half past one
  function drawRecord(ctx, cx, cy, R, song, now, opt) {
    opt = opt || {};
    const bars = song ? song.bars : 16;
    // the groove band can be narrowed (grooveOuter / grooveInner, fractions of R)
    // to match how far a page's tonearm can actually reach
    const GO = opt.grooveOuter || OUTER, GI = opt.grooveInner || INNER;
    const band = (GO - GI) * R / bars;
    const playingNow = now != null && now >= 0;
    const frac = playingNow ? (now / BAR) % 1 : 0;
    // where the needle touches the disc (screen angle); what is playing is
    // turned to sit right under it
    const needle = opt.needleAngle != null ? opt.needleAngle : NEEDLE;
    const rot = needle + 2 * Math.PI * frac + (playingNow ? 0 : (opt.spin || 0));

    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = opt.vinyl || '#0c0c0c'; ctx.fill();
    ctx.rotate(rot);
    ctx.lineWidth = Math.max(.5, R / 400);
    if (R > 60) {
      for (let b = 0; b <= bars; b++) {
        ctx.beginPath(); ctx.arc(0, 0, GO * R - b * band, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(232,226,212,0.07)'; ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(232,226,212,0.035)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -1.9, -1.1); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, 1.25, 2.05); ctx.fill();

    if (song) {
      ctx.lineCap = 'round';
      for (const n of song.notes) {
        if (!n.src) continue;
        const b = Math.floor(n.t / BAR + 1e-6);
        const s = (n.t - b * BAR) / BAR;
        const len = Math.min(n.dur / BAR, 1 - s);
        const r = GO * R - b * band - band * (.15 + .7 * (1 - (n.midi - 55) / 33));
        const a0 = -s * 2 * Math.PI, a1 = -(s + Math.max(len, .012)) * 2 * Math.PI;
        const played = playingNow && now >= n.t, sounding = played && now < n.t + n.dur;
        ctx.beginPath(); ctx.arc(0, 0, r, a1, a0);
        ctx.strokeStyle = SOURCES[n.src].color;
        ctx.globalAlpha = !playingNow ? (opt.restAlpha || .55) : sounding ? 1 : played ? .8 : .32;
        ctx.lineWidth = Math.max(R > 60 ? 1.2 : .8, band * (sounding ? .5 : .28));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // label, optionally sitting in a plain ring (radii as fractions of R)
    if (opt.ringColor) {
      ctx.beginPath(); ctx.arc(0, 0, (opt.ringR || INNER * .95) * R, 0, Math.PI * 2); ctx.fillStyle = opt.ringColor; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0, 0, (opt.labelR || INNER * .86) * R, 0, Math.PI * 2); ctx.fillStyle = opt.labelColor || '#b01d12'; ctx.fill();
    if (opt.labelText !== false && R > 60) {
      ctx.fillStyle = '#e8e2d4';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `italic 500 ${Math.round(R * .085)}px "Playfair Display", serif`;
      const lines = opt.labelText || ['OUTER', 'CHORD'];
      ctx.fillText(lines[0], 0, -R * .045);
      ctx.fillText(lines[1], 0, R * .05);
    }
    if (opt.spindle !== false) {
      ctx.beginPath(); ctx.arc(0, 0, Math.max(1.5, R * .018), 0, Math.PI * 2); ctx.fillStyle = opt.vinyl || '#0c0c0c'; ctx.fill();
    }
    ctx.restore();

    if (opt.tonearm) {
      const rr = playingNow ? GO * R - (now / BAR) * band : R * 1.02;
      const tipX = cx + Math.cos(NEEDLE) * rr, tipY = cy + Math.sin(NEEDLE) * rr;
      const pivX = cx + R * 1.02, pivY = cy - R * 1.02;
      const armColor = opt.armColor || '#e8e2d4';
      ctx.strokeStyle = armColor; ctx.lineWidth = Math.max(2, R * .014); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(pivX, pivY);
      ctx.quadraticCurveTo(pivX - R * .05, (pivY + tipY) / 2, tipX, tipY); ctx.stroke();
      ctx.beginPath(); ctx.arc(pivX, pivY, R * .04, 0, Math.PI * 2); ctx.fillStyle = armColor; ctx.fill();
      ctx.beginPath(); ctx.arc(tipX, tipY, R * .016, 0, Math.PI * 2); ctx.fillStyle = '#b01d12'; ctx.fill();
    }
  }

  /* ---------------- a title for every song ----------------
     Two words, in the voice of the exhibition (lost signals, stray angels,
     cattle under a beam), picked from the song's own code — so one song
     keeps one title wherever it is opened: here, the archive, the phone. */
  const TITLE_A = ['LOST', 'STRAY', 'HOLLOW', 'DISTANT', 'SILENT', 'BROKEN', 'FALLEN', 'OUTER', 'PALE', 'STATIC',
    'ORBITAL', 'DROWNED', 'WANDERING', 'FORGOTTEN', 'MIDNIGHT', 'NEON', 'FAINT', 'LAST', 'TENDER', 'SPLIT',
    'SECOND', 'COLD', 'FLOATING', 'BURIED', 'ELECTRIC', 'UNKNOWN', 'GHOST', 'VELVET', 'CRIMSON', 'GLASS'];
  const TITLE_B = ['SIGNAL', 'CHORD', 'ORBIT', 'ECHO', 'COMET', 'NEBULA', 'ANGEL', 'CATTLE', 'RECORD', 'PULSE',
    'HYMN', 'DRIFT', 'LULLABY', 'BEACON', 'PLANET', 'WING', 'GROOVE', 'TIDE', 'STAR', 'SATELLITE',
    'NOCTURNE', 'RIPPLE', 'HALO', 'FREQUENCY', 'DUST', 'CANON', 'REQUIEM', 'MERIDIAN', 'APHELION', 'CHORUS'];
  function titleFor(code) {
    let h = 0x811c9dc5;                                  // FNV-1a over the code
    for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const a = TITLE_A[h % TITLE_A.length];
    let b = TITLE_B[(h >>> 8) % TITLE_B.length];
    if (b === a) b = TITLE_B[((h >>> 8) + 1) % TITLE_B.length];
    return a + ' ' + b;
  }

  /* ---------------- the phone link and its QR code ---------------- */
  function listenPrefix() { return siteRoot() + 'chord/listen.html#'; }
  function siteRoot() {
    if (/^https?:$/.test(location.protocol) && !/^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(location.hostname)) {
      // pages sit one folder down from the site root (chord/, records/)
      return new URL('../', location.href).href;
    }
    return PUBLIC_BASE;
  }

  // The address goes in as a byte segment and the code as an alphanumeric
  // one, which packs base32 about a fifth tighter than plain text would.
  function qrSvg(code, opt) {
    opt = opt || {};
    if (!window.qrcode) throw new Error('QR library not loaded');
    const qr = window.qrcode(0, opt.level || 'L');
    qr.addData(listenPrefix(), 'Byte');
    qr.addData(code, 'Alphanumeric');
    qr.make();
    const n = qr.getModuleCount(), m = opt.margin == null ? 4 : opt.margin, size = n + m * 2;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${opt.light || '#fff'}"/><path d="${d}" fill="${opt.dark || '#000'}"/></svg>`;
  }

  /* The code to scan, as a record sleeve: a red sleeve holding the title,
     the QR code and a line on what to do, with the record sliding halfway
     out of it to the right. Laid out on the 1920×1080 design (the sleeve
     609×773 in the middle, the disc r=262 centred on its right edge) and
     scaled to the window. Fonts: Nomark for the title, Pretendard for the
     rest — a page that has not declared Nomark gets it from here. */
  let qrStyled = false;
  function qrStyle() {
    if (qrStyled) return;
    qrStyled = true;
    const css = document.createElement('style');
    css.textContent = `
      @font-face{ font-family:'Nomark'; src:url('${siteRootAssets()}fonts/nomark.otf') format('opentype'); font-display:swap; }
      .oc-qr{ position:fixed; inset:0; z-index:2147482000; display:grid; place-items:center;
        background:rgba(12,11,11,.78); opacity:0; transition:opacity .25s steps(4,end); }
      .oc-qr.is-open{ opacity:1; }
      .oc-qr[hidden]{ display:none; }
      .oc-qr__stage{ position:relative; width:609px; height:773px; transform-origin:50% 50%; }
      .oc-qr__disc{ position:absolute; left:347px; top:124.5px; width:524px; height:524px; z-index:1;
        transform:translateX(-262px); transition:transform 1.15s cubic-bezier(.2,.75,.25,1) .3s; }
      .oc-qr.is-open .oc-qr__disc{ transform:translateX(0); }
      .oc-qr__spin{ width:100%; height:100%; border-radius:50%; position:relative;
        background:repeating-radial-gradient(circle at 50% 50%, #1e1e1e 0 3px, #222 3px 4px);
        animation:oc-qr-spin 1.8s steps(24,end) infinite; animation-play-state:paused; }
      .oc-qr.is-open .oc-qr__spin{ animation-play-state:running; }
      .oc-qr__spin::before{ content:''; position:absolute; left:50%; top:50%; width:180px; height:180px; margin:-90px 0 0 -90px;
        border-radius:50%; background:#313131; }
      .oc-qr__spin::after{ content:''; position:absolute; left:50%; top:50%; width:140px; height:140px; margin:-70px 0 0 -70px;
        border-radius:50%; background:#b01d12; }
      @keyframes oc-qr-spin{ to{ transform:rotate(360deg); } }
      .oc-qr__sleeve{ position:absolute; inset:0; z-index:2; background:#b01d12;
        display:flex; flex-direction:column; align-items:center; }
      .oc-qr__title{ margin:22px 0 0; height:58px; max-width:540px; color:#1e1e1e; white-space:nowrap;
        font:400 46px/58px 'Nomark', 'Pretendard Variable', serif; letter-spacing:-.035em; text-transform:uppercase; }
      .oc-qr__code{ margin-top:11px; width:482px; height:483px; background:#fff; padding:14px; box-sizing:border-box; }
      .oc-qr__code svg{ display:block; width:100%; height:100%; }
      .oc-qr__text{ margin-top:30px; color:#1e1e1e; text-align:center;
        font:400 19px/30px 'Pretendard Variable', Pretendard, sans-serif; letter-spacing:-.05em; }
      .oc-qr__close{ margin-top:13px; width:143px; height:54px; border:0; border-radius:999px; cursor:pointer;
        background:#1e1e1e; color:#b01d12; font:500 19px/1 'Pretendard Variable', Pretendard, sans-serif; letter-spacing:-.03em;
        transition:background .15s steps(2,end), color .15s steps(2,end); }
      .oc-qr__close:hover, .oc-qr__close:focus-visible{ background:#e8e2d4; color:#1e1e1e; outline:none; }
      @media (prefers-reduced-motion: reduce){ .oc-qr__disc{ transition:none; } .oc-qr__spin{ animation:none; } }`;
    document.head.appendChild(css);
  }
  // fonts/ sits at the site root; pages live one folder down
  function siteRootAssets() { return /\/(chord|records)\/[^/]*$/.test(location.pathname) ? '../' : ''; }

  function showQR(code, meta) {
    qrStyle();
    let sheet = document.getElementById('ocQR');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'ocQR'; sheet.className = 'oc-qr'; sheet.hidden = true;
      sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
      sheet.innerHTML = `<div class="oc-qr__stage">
          <div class="oc-qr__disc" aria-hidden="true"><div class="oc-qr__spin"></div></div>
          <div class="oc-qr__sleeve">
            <h2 class="oc-qr__title"></h2>
            <div class="oc-qr__code"></div>
            <div class="oc-qr__text">휴대폰 카메라로 찍으면<br>이 곡을 휴대폰에서 듣고 내려받을 수 있어요.</div>
            <button type="button" class="oc-qr__close">닫기</button>
          </div>
        </div>`;
      document.body.appendChild(sheet);
      const stage = sheet.querySelector('.oc-qr__stage');
      // the sleeve stays in the middle; the disc needs room to its right
      const fit = () => { stage.style.transform = `scale(${Math.min(1, innerWidth / 1250, innerHeight / 860)})`; };
      fit(); addEventListener('resize', fit);
      const close = () => {
        sheet.classList.remove('is-open');
        setTimeout(() => { if (!sheet.classList.contains('is-open')) sheet.hidden = true; }, 260);
      };
      sheet.querySelector('.oc-qr__close').addEventListener('click', close);
      sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) close(); });
    }
    const title = sheet.querySelector('.oc-qr__title');
    title.textContent = (meta && meta.title) || 'Outer Chord';
    // a long title is set smaller rather than run past the sleeve
    title.style.fontSize = '46px';
    sheet.querySelector('.oc-qr__code').innerHTML = qrSvg(code, { margin: 1 });
    sheet.hidden = false;
    for (let s = 46; s > 24 && title.scrollWidth > 540; s -= 2) title.style.fontSize = s + 'px';
    // restart the slide each time it opens
    sheet.classList.remove('is-open');
    void sheet.offsetWidth;
    sheet.classList.add('is-open');
    sheet.querySelector('.oc-qr__close').focus();
  }

  /* ---------------- the archive ----------------
     Every song made is kept: on the exhibition server (songs/songs.jsonl)
     when there is one, otherwise in this browser. One entry per make chord
     visit — remaking replaces that visit's song rather than adding more. */
  const LOCAL_SONGS = 'xg.songs.v1';
  const onServer = /^https?:$/.test(location.protocol);
  function localSongs() { try { return JSON.parse(localStorage.getItem(LOCAL_SONGS)) || []; } catch (e) { return []; } }
  function keepLocal(entry) {
    const list = localSongs().filter(s => s.id !== entry.id);
    list.push(entry);
    try { localStorage.setItem(LOCAL_SONGS, JSON.stringify(list.slice(-300))); } catch (e) { /* full */ }
  }
  async function saveSong(entry, root) {
    if (onServer) {
      try {
        const r = await fetch((root || '../') + 'api/songs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
        if (r.ok) return 'server';
      } catch (e) { /* no server: keep it here */ }
    }
    keepLocal(entry);
    return 'local';
  }
  async function listSongs(root) {
    if (onServer) {
      try {
        const r = await fetch((root || '../') + 'api/songs', { cache: 'no-store' });
        if (r.ok) return { from: 'server', songs: await r.json() };
      } catch (e) { /* fall through */ }
    }
    return { from: 'local', songs: localSongs() };
  }

  window.OuterChord = {
    SOURCES, ORDER, KINDS, NAMES, BPM, BEAT, BAR, STEPS, STEP, TAIL, PUBLIC_BASE,
    clamp, fold, fmt, chordName, q7, qPan, qHit,
    expand, encode, decode, pack, unpack,
    schedule, player, renderWav, toWav, download,
    drawRecord, qrSvg, showQR, listenPrefix, siteRoot, titleFor,
    saveSong, listSongs,
  };
})();
