/* ===========================================================================
   app.js — socket client, screen routing, render-from-state.
   Client renders are a pure function of the latest room_update. The server is
   the single source of truth; we only render state and emit user intents.
   =========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.Effects.escapeHtml(s);
  const SESSION_KEY = 'qj_session';

  const socket = io({ autoConnect: true });

  // --- client state ----------------------------------------------------------
  let room = null;          // latest serialized room view
  let youId = null;
  let prevPhase = null;
  let prevStoryLen = 0;
  let voteSelection = null; // local pick before casting
  let revealCtl = null;     // typewriter controller
  let wasYourTurn = false;
  let joining = false;

  // --- session persistence ---------------------------------------------------
  function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }

  // ===========================================================================
  // Screen routing
  // ===========================================================================
  const SCREENS = ['screen-landing', 'screen-lobby', 'screen-writing', 'screen-reveal', 'screen-voting', 'screen-results'];
  function show(id) {
    SCREENS.forEach((s) => $(s).classList.toggle('active', s === id));
  }

  function render() {
    if (!room) {
      show('screen-landing');
      $('reactionBar').classList.add('hidden');
      Countdown.stop();
      Effects.tension(false);
      prevPhase = null;
      return;
    }
    youId = room.youId;
    $('reactionBar').classList.remove('hidden');

    const phaseChanged = room.phase !== prevPhase;
    if (room.phase !== 'WRITING') { Countdown.stop(); Effects.tension(false); }

    switch (room.phase) {
      case 'LOBBY': renderLobby(); break;
      case 'WRITING': renderWriting(); break;
      case 'REVEAL':
        show('screen-reveal');
        if (phaseChanged) enterReveal();
        renderRevealControls();
        break;
      case 'VOTING':
      case 'RUNOFF':
        if (phaseChanged) voteSelection = null;
        renderVoting();
        break;
      case 'RESULTS':
        show('screen-results');
        if (phaseChanged) enterResults();
        renderResults();
        break;
    }
    prevPhase = room.phase;
  }

  // ===========================================================================
  // LOBBY
  // ===========================================================================
  function renderLobby() {
    show('screen-lobby');
    $('lobbyCode').textContent = room.code;
    $('lobbyCount').textContent = `${room.connectedCount}/${room.maxPlayers}`;

    $('playersList').innerHTML = room.players.map((p) => {
      const tags = [];
      if (p.isHost) tags.push('<span class="tag">مضيف</span>');
      if (p.isYou) tags.push('<span class="tag you">أنت</span>');
      return `<li>
        <span class="dot ${p.connected ? '' : 'off'}"></span>
        <span class="pname">${esc(p.name)}</span>
        ${tags.join('')}
      </li>`;
    }).join('');

    if (room.connectedCount < room.minPlayers) {
      $('lobbyHint').textContent = `تحتاج ${room.minPlayers} لاعبين على الأقل للبدء (${room.connectedCount} الآن)`;
    } else {
      $('lobbyHint').textContent = 'جاهزون للبدء!';
    }

    if (room.isHost) {
      $('hostControls').classList.remove('hidden');
      $('lobbyWaitGuest').classList.add('hidden');

      // presets
      $('presetList').innerHTML = (room.presets || []).map((p) =>
        `<button class="preset-item ${room.starterText === p.text ? 'selected' : ''}" data-preset="${p.id}">${esc(p.text)}</button>`
      ).join('');

      // chosen starter preview
      if (room.starterText) {
        $('chosenStarter').classList.remove('hidden');
        $('chosenStarter').textContent = '✦ ' + room.starterText;
      } else {
        $('chosenStarter').classList.add('hidden');
      }

      $('btnStart').disabled = !room.canStart;
    } else {
      $('hostControls').classList.add('hidden');
      $('lobbyWaitGuest').classList.remove('hidden');
    }
  }

  // ===========================================================================
  // WRITING
  // ===========================================================================
  function renderWriting() {
    show('screen-writing');
    const turn = room.turn || {};
    const done = room.allTurnsDone;

    // story
    renderStoryLines($('storyPanel'), room.story);

    // banner
    if (done) {
      $('turnBanner').innerHTML = 'اكتملت الجمل';
    } else if (turn.isYourTurn) {
      $('turnBanner').innerHTML = 'دورك الآن — اكتب جملتك';
    } else {
      $('turnBanner').innerHTML = `دور <b>${esc(turn.currentPlayerName || '')}</b> الآن`;
    }

    // sub-areas
    const writeArea = $('writeArea'), waitArea = $('waitArea'), doneArea = $('doneArea');
    writeArea.classList.add('hidden'); waitArea.classList.add('hidden'); doneArea.classList.add('hidden');

    if (done) {
      Countdown.stop();
      Effects.tension(false);
      doneArea.classList.remove('hidden');
      $('btnReveal').classList.toggle('hidden', !room.isHost);
      $('doneWaitGuest').classList.toggle('hidden', room.isHost);
    } else if (turn.isYourTurn) {
      writeArea.classList.remove('hidden');
      if (!wasYourTurn) {
        const inp = $('sentenceInput');
        inp.value = '';
        updateCounter(inp, $('sentenceCounter'));
        setTimeout(() => inp.focus(), 350);
      }
      Countdown.start(turn.deadline);
    } else {
      waitArea.classList.remove('hidden');
      Countdown.start(turn.deadline);
    }
    wasYourTurn = !!turn.isYourTurn && !done;
  }

  function renderStoryLines(container, story) {
    const grew = story.length > prevStoryLen;
    container.innerHTML = story.map((s, i) => {
      const cls = ['s-line'];
      if (s.isStarter) cls.push('starter');
      if (grew && i === story.length - 1) cls.push('newest', 'enter');
      const num = s.isStarter ? '' : `<span class="s-num">${s.index}.</span>`;
      return `<div class="${cls.join(' ')}">${num}${esc(s.text)}</div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
    prevStoryLen = story.length;
  }

  // ===========================================================================
  // REVEAL
  // ===========================================================================
  function enterReveal() {
    prevStoryLen = room.story.length; // suppress writing-style flashes later
    const sentences = room.story.map((s) => ({ text: s.text, isStarter: s.isStarter }));
    $('btnOpenVoting').classList.add('hidden');
    $('revealWaitGuest').classList.add('hidden');
    $('btnSkipReveal').classList.remove('hidden');
    if (revealCtl) revealCtl.cancel();
    revealCtl = Effects.typeReveal($('revealPanel'), sentences, {
      onTick: () => Audio2.play('reveal_tick'),
      onDone: () => {
        $('btnSkipReveal').classList.add('hidden');
        renderRevealControls();
      },
    });
  }

  function renderRevealControls() {
    if (!room) return;
    $('btnOpenVoting').classList.toggle('hidden', !room.isHost);
    $('revealWaitGuest').classList.toggle('hidden', room.isHost);
  }

  // ===========================================================================
  // VOTING / RUNOFF
  // ===========================================================================
  function renderVoting() {
    show('screen-voting');
    const v = room.voting || {};
    $('votingTitle').textContent = v.isRunoff ? 'جولة الحسم' : 'صوّت للأفضل';
    $('voteCounter').textContent = `صوّت ${v.votedCount} من ${v.totalVoters}`;

    if (v.youVoted) voteSelection = v.yourVote;

    $('votingPanel').innerHTML = room.story.map((s) => {
      if (s.isStarter) {
        return `<div class="vote-card starter-card">✦ ${esc(s.text)}</div>`;
      }
      const selected = voteSelection === s.id;
      const disabled = !s.votable || v.youVoted;
      const cls = ['vote-card'];
      if (selected) cls.push('selected');
      if (disabled) cls.push('disabled');
      const ownTag = s.isOwn ? '<span class="own-tag">جملتك</span>' : '';
      const dim = (!s.inRound && v.isRunoff) ? ' style="opacity:.4"' : '';
      const attr = s.votable && !v.youVoted ? `data-vote="${s.id}"` : '';
      return `<button class="${cls.join(' ')}" ${attr}${dim}>
        <span class="v-num">${s.index}.</span>${esc(s.text)}${ownTag}
      </button>`;
    }).join('');

    const btn = $('btnCastVote');
    if (v.youVoted) {
      btn.textContent = 'صوّتّ ✓';
      btn.disabled = true;
    } else if (!v.youCanVote) {
      btn.textContent = 'لا توجد جملة تصوّت لها';
      btn.disabled = true;
    } else {
      btn.textContent = 'صوّت';
      btn.disabled = !voteSelection;
    }

    $('btnEndVoting').classList.toggle('hidden', !room.isHost);
  }

  // ===========================================================================
  // RESULTS
  // ===========================================================================
  function enterResults() {
    const r = room.results || {};
    Effects.confetti({ shared: r.sharedWin });
    Audio2.play('winner');
  }

  function renderResults() {
    const r = room.results || {};
    const maxVotes = Math.max(1, ...room.story.map((s) => s.votes || 0));

    // winner banner
    let banner = '';
    if (r.noVotes) {
      banner = `<div class="crown">🤷</div><h2>ما صوّت أحد</h2><div class="sub">لا توجد جملة فائزة هذه الجولة</div>`;
    } else if (r.sharedWin) {
      const names = r.winners.map((w) => esc(w.authorName || '—')).join(' و ');
      banner = `<div class="crown">👑</div><h2>تعادل!</h2><div class="sub">فوز مشترك: ${names}</div>`;
    } else if (r.winners && r.winners[0]) {
      const w = r.winners[0];
      banner = `<div class="crown">👑</div><h2>الجملة الفائزة</h2><div class="sub">بقلم <b>${esc(w.authorName || '—')}</b> · ${w.votes} صوت</div>`;
    }
    $('winnerBanner').innerHTML = banner;

    $('resultsPanel').innerHTML = room.story.map((s) => {
      const cls = ['s-line'];
      if (s.isStarter) cls.push('starter');
      if (s.isWinner) cls.push('winner');
      const num = s.isStarter ? '' : `<span class="s-num">${s.index}.</span>`;
      let meta = '';
      if (!s.isStarter) {
        const pct = Math.round(((s.votes || 0) / maxVotes) * 100);
        meta = `<div class="s-meta">
          <span class="s-bar"><i style="width:${pct}%"></i></span>
          <span class="votes">${s.votes || 0}</span>
          <span class="author">بقلم <b>${esc(s.authorName || '—')}</b></span>
        </div>`;
      }
      return `<div class="${cls.join(' ')}">${num}${esc(s.text)}${meta}</div>`;
    }).join('');

    $('btnNewGame').classList.toggle('hidden', !room.isHost);
    $('resultsWaitGuest').classList.toggle('hidden', room.isHost);
  }

  // ===========================================================================
  // Countdown (client renders from deadline; never ticks per-second from server)
  // ===========================================================================
  const Countdown = (function () {
    const TOTAL = 30;
    const C = 2 * Math.PI * 52;
    let raf = null, deadline = 0, lastWhole = -1, fired10 = false;

    function lerpColor(t) {
      // amber (245,185,74) -> red (255,90,90)
      const r = Math.round(245 + (255 - 245) * t);
      const g = Math.round(185 + (90 - 185) * t);
      const b = Math.round(74 + (90 - 74) * t);
      return `rgb(${r},${g},${b})`;
    }

    function frame() {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      const frac = Math.min(1, remaining / TOTAL);
      const ring = $('ringProgress');
      ring.style.strokeDashoffset = String(C * (1 - frac));

      $('ringNum').textContent = String(Math.ceil(remaining));

      const wrap = ring.closest('.ring-wrap');
      if (remaining <= 10) {
        const t = (10 - remaining) / 10;
        ring.style.stroke = lerpColor(t);
        wrap.classList.add('pulse');
        if (!fired10) {
          fired10 = true;
          if (!Effects.isReduce() && navigator.vibrate) navigator.vibrate(20);
        }
      } else {
        ring.style.stroke = 'var(--amber)';
        wrap.classList.remove('pulse');
      }

      // last 3s: ticking + tension vignette pulse (once per whole second)
      const whole = Math.ceil(remaining);
      if (whole !== lastWhole) {
        lastWhole = whole;
        if (remaining > 0 && whole <= 3) {
          Audio2.play('timer_tick');
          Effects.tension(true);
          setTimeout(() => Effects.tension(false), 180);
        }
      }

      if (remaining <= 0) {
        if (!Effects.isReduce() && navigator.vibrate) navigator.vibrate(120);
        stop(true);
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function start(dl) {
      if (!dl) { stop(); return; }
      deadline = dl;
      lastWhole = -1;
      fired10 = false;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    }
    function stop(keepRing) {
      cancelAnimationFrame(raf);
      raf = null;
      const wrap = $('ringProgress').closest('.ring-wrap');
      wrap && wrap.classList.remove('pulse');
      if (!keepRing) {
        $('ringNum').textContent = '30';
        $('ringProgress').style.strokeDashoffset = '0';
        $('ringProgress').style.stroke = 'var(--amber)';
      }
    }
    return { start, stop };
  })();

  // ===========================================================================
  // Socket events
  // ===========================================================================
  socket.on('connect', () => {
    const s = loadSession();
    if (s && s.roomCode && s.playerId && !joining) {
      socket.emit('rejoin', { code: s.roomCode, playerId: s.playerId, name: s.name }, (res) => {
        if (res && res.error) {
          clearSession();
          room = null;
          render();
          // keep their name handy for a fresh start
          if (s.name) $('nameInput').value = s.name;
          showToast('info', 'ابدأ من جديد');
        }
      });
    }
  });

  socket.on('room_update', (data) => {
    room = data.room;
    render();
  });

  socket.on('turn_changed', (data) => {
    // Cinematic title card + cue for each new turn.
    if (data && data.currentPlayerName) {
      Effects.titleCard('دور ' + data.currentPlayerName);
      Audio2.play('turn_start');
    }
  });

  socket.on('your_turn', () => {
    Audio2.play('turn_start');
  });

  socket.on('story_updated', () => {
    Audio2.play('submit');
  });

  socket.on('voting_results', () => {
    // results render is driven by room_update; nothing extra needed here.
  });

  socket.on('reaction_burst', (data) => {
    if (!data) return;
    const edgeOnly = room && room.phase === 'WRITING';
    Effects.floatEmoji(data.emoji, data.fromName, { edgeOnly });
  });

  socket.on('toast', (data) => {
    if (data) showToast(data.type, data.message);
  });

  // ===========================================================================
  // Toasts
  // ===========================================================================
  let toastSeq = 0;
  function showToast(type, message) {
    const host = $('toastHost');
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'error' ? 'error' : 'info');
    el.textContent = message;
    host.appendChild(el);
    const id = ++toastSeq;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 2600 + (id % 2) * 200);
  }

  // ===========================================================================
  // Intent emitters / UI wiring
  // ===========================================================================
  function gesture() { Audio2.unlock(); }
  document.addEventListener('pointerdown', gesture, { once: true });

  // --- Landing
  $('btnShowJoin').addEventListener('click', () => {
    $('joinRow').classList.toggle('hidden');
    if (!$('joinRow').classList.contains('hidden')) $('codeInput').focus();
  });

  $('btnCreate').addEventListener('click', () => {
    gesture();
    const name = $('nameInput').value.trim();
    if (!name) { showToast('error', 'اكتب اسمك أولًا'); return; }
    joining = true;
    socket.emit('create_room', { name }, (res) => {
      joining = false;
      if (res && res.error) return showToast('error', res.error);
      saveSession({ roomCode: res.roomCode, playerId: res.playerId, name });
    });
  });

  $('btnJoin').addEventListener('click', () => {
    gesture();
    const name = $('nameInput').value.trim();
    const code = $('codeInput').value.trim().toUpperCase();
    if (!name) { showToast('error', 'اكتب اسمك أولًا'); return; }
    if (code.length !== 4) { showToast('error', 'أدخل كودًا من 4 أحرف'); return; }
    joining = true;
    socket.emit('join_room', { code, name }, (res) => {
      joining = false;
      if (res && res.error) return showToast('error', res.error);
      saveSession({ roomCode: res.roomCode, playerId: res.playerId, name });
    });
  });

  $('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnCreate').click(); });

  // --- Lobby
  $('btnCopyCode').addEventListener('click', async () => {
    const code = room ? room.code : '';
    try {
      await navigator.clipboard.writeText(code);
      showToast('info', 'تم نسخ الكود');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); showToast('info', 'تم نسخ الكود'); } catch {}
      ta.remove();
    }
  });

  $('presetList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    socket.emit('choose_starter', { presetId: btn.dataset.preset });
  });

  $('btnUseCustom').addEventListener('click', () => {
    const text = $('customStarter').value.trim();
    if (!text) { showToast('error', 'اكتب جملة بداية'); return; }
    socket.emit('choose_starter', { text });
  });
  $('customStarter').addEventListener('input', () => updateCounter($('customStarter'), $('customCounter')));

  $('btnStart').addEventListener('click', () => socket.emit('start_game'));

  // --- Writing
  $('btnSubmit').addEventListener('click', submitSentence);
  $('sentenceInput').addEventListener('input', () => updateCounter($('sentenceInput'), $('sentenceCounter')));
  $('sentenceInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitSentence(); }
  });
  function submitSentence() {
    const inp = $('sentenceInput');
    const text = inp.value.trim();
    if (!text) { showToast('error', 'اكتب جملة قبل الإرسال'); return; }
    socket.emit('submit_sentence', { text });
    inp.value = '';
    updateCounter(inp, $('sentenceCounter'));
    $('writeArea').classList.add('hidden'); // optimistic; server will advance
  }
  $('btnReveal').addEventListener('click', () => socket.emit('reveal_story'));

  // --- Reveal
  $('btnSkipReveal').addEventListener('click', () => { if (revealCtl) revealCtl.skip(); });
  $('btnOpenVoting').addEventListener('click', () => socket.emit('open_voting'));

  // --- Voting
  $('votingPanel').addEventListener('click', (e) => {
    const card = e.target.closest('[data-vote]');
    if (!card) return;
    voteSelection = card.dataset.vote;
    renderVoting();
  });
  $('btnCastVote').addEventListener('click', () => {
    if (!voteSelection) return;
    const card = $('votingPanel').querySelector(`[data-vote="${voteSelection}"]`);
    if (card) { card.classList.add('ripple'); setTimeout(() => card.classList.remove('ripple'), 600); }
    Audio2.play('vote_cast');
    socket.emit('cast_vote', { sentenceId: voteSelection });
  });
  $('btnEndVoting').addEventListener('click', () => socket.emit('force_end_voting'));

  // --- Results
  $('btnNewGame').addEventListener('click', () => socket.emit('new_game'));

  // --- Reactions
  $('reactionBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emoji]');
    if (!btn) return;
    socket.emit('send_reaction', { emoji: btn.dataset.emoji });
  });

  // --- Toggles (persisted)
  function syncMuteBtn() {
    const m = Audio2.isMuted();
    $('toggleMute').textContent = m ? '🔇' : '🔊';
    $('toggleMute').classList.toggle('off', m);
  }
  function syncMotionBtn() {
    const r = Effects.isReduce();
    $('toggleMotion').classList.toggle('off', r);
  }
  $('toggleMute').addEventListener('click', () => { Audio2.unlock(); Audio2.toggleMute(); syncMuteBtn(); });
  $('toggleMotion').addEventListener('click', () => { Effects.setReduce(!Effects.isReduce()); syncMotionBtn(); });
  syncMuteBtn();
  syncMotionBtn();

  // --- helpers
  function updateCounter(input, counterEl) {
    const n = (input.value || '').length;
    counterEl.textContent = `${n}/200`;
    counterEl.style.color = n > 190 ? 'var(--danger)' : '';
  }

  // initial paint
  render();
})();
