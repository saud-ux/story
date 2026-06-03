/* ===========================================================================
   effects.js — overlay layer only. Title cards, confetti, floating emoji,
   typewriter reveal, tension vignette. Animates transform/opacity only.
   Never gates game-state rendering (except the skippable reveal sequence).
   Respects reduce-motion. Caps + recycles nodes (no unbounded growth).
   =========================================================================== */
(function () {
  'use strict';

  const MOTION_KEY = 'qj_reduce_motion';
  let reduce = localStorage.getItem(MOTION_KEY) === '1'
    || (localStorage.getItem(MOTION_KEY) === null
        && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const emojiLayer = () => document.getElementById('fxEmoji');
  const canvas = () => document.getElementById('fxCanvas');
  const MAX_EMOJI = 30;

  function isReduce() { return reduce; }
  function setReduce(v) {
    reduce = !!v;
    localStorage.setItem(MOTION_KEY, reduce ? '1' : '0');
    document.body.classList.toggle('reduce-motion', reduce);
  }
  document.body && document.body.classList.toggle('reduce-motion', reduce);

  // --- Tension vignette ------------------------------------------------------
  function tension(on) {
    const el = document.getElementById('tensionVignette');
    if (!el) return;
    el.classList.toggle('on', !!on && !reduce);
  }

  // --- Title card ------------------------------------------------------------
  let titleTimer = null;
  function titleCard(text) {
    const card = document.getElementById('titleCard');
    const span = document.getElementById('titleCardText');
    if (!card || !span) return;
    span.textContent = text;
    if (reduce) {
      card.style.opacity = '1';
      clearTimeout(titleTimer);
      titleTimer = setTimeout(() => { card.style.opacity = '0'; }, 700);
      return;
    }
    card.classList.remove('show');
    void card.offsetWidth; // restart animation
    card.classList.add('show');
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => card.classList.remove('show'), 1700);
  }

  // --- Floating emoji --------------------------------------------------------
  const countBadges = {}; // reduce-motion: static counts
  function floatEmoji(emoji, fromName, opts) {
    opts = opts || {};
    const layer = emojiLayer();
    if (!layer) return;

    if (reduce) {
      // Static count instead of motion.
      let badge = countBadges[emoji];
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'float-emoji';
        badge.style.position = 'fixed';
        badge.style.bottom = '70px';
        badge.style.insetInlineEnd = (12 + Object.keys(countBadges).length * 64) + 'px';
        badge.dataset.n = '0';
        layer.appendChild(badge);
        countBadges[emoji] = badge;
      }
      const n = (parseInt(badge.dataset.n, 10) || 0) + 1;
      badge.dataset.n = String(n);
      badge.textContent = emoji + ' ' + n;
      clearTimeout(badge._t);
      badge._t = setTimeout(() => { badge.remove(); delete countBadges[emoji]; }, 2500);
      return;
    }

    // Recycle if over cap.
    while (layer.children.length >= MAX_EMOJI) layer.firstChild.remove();

    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;

    let startX;
    if (opts.edgeOnly) {
      // Keep clear of the writer's input: hug the screen edges.
      const side = Math.random() < 0.5 ? 0 : 1;
      startX = side === 0 ? (4 + Math.random() * 10) : (86 + Math.random() * 10);
    } else {
      startX = 15 + Math.random() * 70;
    }
    el.style.insetInlineStart = startX + 'vw';
    el.style.bottom = '12vh';
    const dx1 = (Math.random() * 8 - 4);
    const dx2 = (Math.random() * 16 - 8);
    el.style.setProperty('--dx1', dx1 + 'vw');
    el.style.setProperty('--dx2', dx2 + 'vw');
    el.style.setProperty('--dur', (2 + Math.random() * 1.2) + 's');

    if (fromName) {
      const tag = document.createElement('span');
      tag.className = 'float-emoji tag';
      tag.textContent = fromName;
      el.appendChild(tag);
    }

    layer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('go'));
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  // --- Confetti (custom canvas, hard particle cap) ---------------------------
  let confettiRAF = null;
  function confetti(opts) {
    opts = opts || {};
    const cv = canvas();
    if (!cv) return;
    if (reduce) return; // physics disabled under reduce-motion

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = window.innerWidth * dpr;
    cv.height = window.innerHeight * dpr;
    const c = cv.getContext('2d');
    c.scale(dpr, dpr);

    const W = window.innerWidth, H = window.innerHeight;
    const COLORS = ['#ffd479', '#f5b94a', '#ffffff', '#ff9d5a', '#9b8cff'];
    const CAP = 150;
    const origins = opts.shared ? [W * 0.3, W * 0.7] : [W * 0.5];
    const particles = [];
    origins.forEach((ox) => {
      const per = Math.floor(CAP / origins.length);
      for (let i = 0; i < per; i++) {
        const a = (-Math.PI / 2) + (Math.random() - 0.5) * 1.4;
        const sp = 6 + Math.random() * 9;
        particles.push({
          x: ox, y: H * 0.28,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4,
          g: 0.22 + Math.random() * 0.1,
          size: 5 + Math.random() * 6,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          life: 0, ttl: 90 + Math.random() * 50,
        });
      }
    });

    let frame = 0;
    cancelAnimationFrame(confettiRAF);
    function step() {
      frame++;
      c.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of particles) {
        if (p.life > p.ttl) continue;
        alive++;
        p.life++;
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.99;
        p.rot += p.vr;
        const fade = Math.max(0, 1 - p.life / p.ttl);
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);
        c.globalAlpha = fade;
        c.fillStyle = p.color;
        c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        c.restore();
      }
      if (alive > 0 && frame < 260) {
        confettiRAF = requestAnimationFrame(step);
      } else {
        c.clearRect(0, 0, W, H);
      }
    }
    step();
  }

  // --- Typewriter reveal -----------------------------------------------------
  // sentences: [{ text, isStarter }]
  function typeReveal(container, sentences, opts) {
    opts = opts || {};
    const onTick = opts.onTick || function () {};
    const onDone = opts.onDone || function () {};
    container.innerHTML = '';

    if (reduce) {
      // Instant render with a simple stagger-fade, no typing / no SFX.
      sentences.forEach((s, i) => {
        const div = document.createElement('div');
        div.className = 's-line' + (s.isStarter ? ' starter' : '');
        div.innerHTML = (s.isStarter ? '' : `<span class="s-num">${i}.</span>`) + escapeHtml(s.text);
        div.style.opacity = '0';
        container.appendChild(div);
        setTimeout(() => { div.style.transition = 'opacity .35s ease'; div.style.opacity = '1'; }, i * 120);
      });
      setTimeout(onDone, sentences.length * 120 + 200);
      return { skip() {}, cancel() {} };
    }

    let cancelled = false;
    let idx = 0;
    let timer = null;
    const PER_CHAR = 28; // ms
    const CLAMP = 2200; // ≤2.2s per sentence

    function renderAll() {
      container.innerHTML = '';
      sentences.forEach((s, i) => {
        const div = document.createElement('div');
        div.className = 's-line' + (s.isStarter ? ' starter' : '');
        div.innerHTML = (s.isStarter ? '' : `<span class="s-num">${i}.</span>`) + escapeHtml(s.text);
        container.appendChild(div);
      });
      container.scrollTop = container.scrollHeight;
    }

    function typeSentence(i) {
      if (cancelled) return;
      if (i >= sentences.length) { onDone(); return; }
      const s = sentences[i];
      const div = document.createElement('div');
      div.className = 's-line' + (s.isStarter ? ' starter' : '') + ' caret';
      const numHtml = s.isStarter ? '' : `<span class="s-num">${i}.</span>`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;

      const chars = Array.from(s.text);
      const perChar = Math.min(PER_CHAR, Math.max(8, Math.floor(CLAMP / Math.max(1, chars.length))));
      let ci = 0;
      function step() {
        if (cancelled) return;
        ci++;
        div.innerHTML = numHtml + escapeHtml(chars.slice(0, ci).join(''));
        if (ci % 3 === 0) onTick();
        container.scrollTop = container.scrollHeight;
        if (ci < chars.length) {
          timer = setTimeout(step, perChar);
        } else {
          div.classList.remove('caret');
          timer = setTimeout(() => typeSentence(i + 1), 220);
        }
      }
      step();
    }

    typeSentence(0);

    return {
      skip() {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(timer);
        renderAll();
        onDone();
      },
      cancel() { cancelled = true; clearTimeout(timer); },
    };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.Effects = {
    isReduce, setReduce, tension, titleCard, floatEmoji, confetti, typeReveal, escapeHtml,
  };
})();
