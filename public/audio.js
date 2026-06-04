/* ===========================================================================
   audio.js — synthesized SFX via Web Audio API (no files, zero deps).
   Cues: turn_start, submit, timer_tick, vote_cast, reveal_tick,
         drumroll, tally_tick, winner.
   AudioContext is created/resumed on the first user gesture. Respects mute.
   Modular: swap synths for samples later without touching callers.
   =========================================================================== */
(function () {
  'use strict';

  const MUTE_KEY = 'qj_muted';
  let ctx = null;
  let master = null;
  let muted = localStorage.getItem(MUTE_KEY) === '1';

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
    return ctx;
  }

  /** Call on the first real user gesture (name entry / join tap). */
  function unlock() {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function isMuted() { return muted; }
  function setMuted(v) {
    muted = !!v;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.01);
  }
  function toggleMute() { setMuted(!muted); return muted; }

  // --- low-level voice ------------------------------------------------------
  function tone({ type = 'sine', freq = 440, to = null, dur = 0.2, gain = 0.3, attack = 0.005, delay = 0 }) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.18, gain = 0.18, freq = 1200, q = 0.7, delay = 0 }) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(master);
    src.start(t0);
  }

  // --- named cues -----------------------------------------------------------
  const SFX = {
    turn_start() {
      ensureContext();
      tone({ type: 'sine', freq: 110, to: 220, dur: 0.55, gain: 0.32 });
      tone({ type: 'triangle', freq: 220, to: 440, dur: 0.5, gain: 0.12, delay: 0.04 });
    },
    submit() {
      ensureContext();
      noise({ dur: 0.22, gain: 0.16, freq: 2200, q: 0.6 });
      tone({ type: 'sine', freq: 520, to: 900, dur: 0.16, gain: 0.14 });
    },
    timer_tick() {
      ensureContext();
      tone({ type: 'square', freq: 880, dur: 0.06, gain: 0.12 });
    },
    vote_cast() {
      ensureContext();
      tone({ type: 'sine', freq: 440, to: 660, dur: 0.14, gain: 0.2 });
      tone({ type: 'sine', freq: 660, to: 990, dur: 0.16, gain: 0.14, delay: 0.08 });
    },
    reveal_tick() {
      ensureContext();
      tone({ type: 'square', freq: 1400, dur: 0.025, gain: 0.05 });
    },
    // Suspense roll that accelerates into a low boom — fires while the
    // vote bars climb, landing right as the winner is crowned (~1.6s).
    drumroll() {
      ensureContext();
      const n = 20;
      let t = 0;
      for (let i = 0; i < n; i++) {
        noise({ dur: 0.05, gain: 0.05 + 0.12 * (i / n), freq: 200, q: 1.4, delay: t });
        t += 0.085 - 0.05 * (i / n); // each hit a touch sooner than the last
      }
      tone({ type: 'sine', freq: 100, to: 60, dur: 0.45, gain: 0.22, delay: t });
    },
    // Soft blip as a sentence's vote count ticks up.
    tally_tick() {
      ensureContext();
      tone({ type: 'triangle', freq: 740, dur: 0.05, gain: 0.07 });
    },
    winner() {
      ensureContext();
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C E G C
      notes.forEach((f, i) => tone({ type: 'triangle', freq: f, dur: 0.5, gain: 0.2, delay: i * 0.09 }));
      tone({ type: 'sine', freq: 130, to: 260, dur: 0.7, gain: 0.18 });
    },
  };

  function play(name) {
    if (muted) return;
    ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (SFX[name]) SFX[name]();
  }

  window.Audio2 = { unlock, play, isMuted, setMuted, toggleMute };
})();
