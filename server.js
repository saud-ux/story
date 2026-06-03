'use strict';

/**
 * قصة جماعية — Realtime Collaborative Story Game
 * Express + Socket.IO. All room/game state is in-memory (a Map).
 * The server is the single source of truth; clients only render state + emit intents.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, no O (ambiguous)
const TURN_MS = 30_000;
const GRACE_MS = 30_000;
const EMPTY_ROOM_MS = 120_000; // destroy empty room after 2 min
const AUTO_REVEAL_MS = 8_000; // host-triggered reveal, with auto fallback
const MAX_PLAYERS = 7;
const MIN_PLAYERS = 3;
const MAX_SENTENCE = 200;
const REACTION_THROTTLE_MS = 500;

const PHASE = {
  LOBBY: 'LOBBY',
  WRITING: 'WRITING',
  REVEAL: 'REVEAL',
  VOTING: 'VOTING',
  RUNOFF: 'RUNOFF',
  RESULTS: 'RESULTS',
};

const PRESETS = [
  { id: 'p1', text: 'في منتصف الليل، رنّ هاتفٌ لم يكن موصولًا بالكهرباء منذ سنوات.' },
  { id: 'p2', text: 'قرّرتُ أن أفتح الصندوق الذي حذّرتني جدّتي من فتحه.' },
  { id: 'p3', text: 'استيقظ سكان الحيّ ليجدوا أن الشارع كلّه قد اختفى.' },
  { id: 'p4', text: 'كان آخر شخصٍ على وجه الأرض جالسًا في غرفته، حين سمع طرقًا على الباب.' },
  { id: 'p5', text: 'في أوّل يوم عمل، اكتشفتُ أن زميلي في المكتب ليس إنسانًا.' },
  { id: 'p6', text: 'وجدتُ رسالةً في جيب معطفي بخطّ يدي، لكنّي لا أذكر أنّني كتبتها.' },
];

/** @type {Map<string, Room>} */
const rooms = new Map();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const now = () => Date.now();
const genId = () => crypto.randomUUID();

function genRoomCode() {
  for (let attempt = 0; attempt < 5000; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  // Extremely unlikely fallback
  return 'R' + crypto.randomInt(1000).toString();
}

function sanitizeName(raw) {
  let name = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (name.length > 24) name = name.slice(0, 24);
  if (!name) name = 'لاعب';
  return name;
}

function uniqueName(room, name) {
  const taken = new Set(room.players.map((p) => p.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} #${n}`)) n++;
  return `${name} #${n}`;
}

function sanitizeSentence(raw) {
  let text = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_SENTENCE) text = text.slice(0, MAX_SENTENCE);
  return text;
}

const playerById = (room, id) => room.players.find((p) => p.id === id);
const orderedPlayers = (room) => room.players; // pushed in join order
const livePlayers = (room) => room.players.filter((p) => !p.gone); // still in the game
const connectedPlayers = (room) => room.players.filter((p) => p.connected && !p.gone);
const authoredSentences = (room) => room.story.filter((s) => s.authorId !== null);

function votableSet(room) {
  return room.story.filter((s) => {
    if (s.authorId === null) return false;
    if (room.phase === PHASE.RUNOFF) return room.runoffSentenceIds.includes(s.id);
    return true;
  });
}

/** Can this player vote at all in the current round? (has ≥1 sentence not their own) */
function canVote(room, player) {
  return votableSet(room).some((s) => s.authorId !== player.id);
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------
function toastTo(playerId, type, message) {
  io.to(playerId).emit('toast', { type, message });
}
function toastRoom(room, type, message) {
  io.to(room.code).emit('toast', { type, message });
}

function broadcastRoom(room) {
  for (const p of room.players) {
    if (!p.connected) continue;
    io.to(p.id).emit('room_update', { room: serializeRoom(room, p.id) });
  }
}

function broadcastPhase(room) {
  io.to(room.code).emit('phase_changed', { phase: room.phase });
  broadcastRoom(room);
}

// ---------------------------------------------------------------------------
// Serialization — client-safe, per-player view
// ---------------------------------------------------------------------------
function serializeStory(room, forId) {
  return room.story.map((s) => {
    const base = { id: s.id, index: s.index, text: s.text, isStarter: s.authorId === null };
    if (room.phase === PHASE.RESULTS) {
      const author = s.authorId ? playerById(room, s.authorId) : null;
      return {
        ...base,
        authorName: author ? author.name : null,
        votes: room.tally ? room.tally[s.id] || 0 : 0,
        isWinner: room.winners ? room.winners.includes(s.id) : false,
      };
    }
    if (room.phase === PHASE.VOTING || room.phase === PHASE.RUNOFF) {
      // Anonymous: never leak authorId. Only tell the requester about their OWN sentence.
      const isOwn = s.authorId === forId;
      const inRound = room.phase !== PHASE.RUNOFF || room.runoffSentenceIds.includes(s.id);
      return {
        ...base,
        isOwn,
        inRound,
        votable: !base.isStarter && !isOwn && inRound,
      };
    }
    // LOBBY / WRITING / REVEAL — plain text, no author labels (keep voting fair).
    return base;
  });
}

function serializeRoom(room, forId) {
  const out = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    youId: forId,
    isHost: forId === room.hostId,
    players: orderedPlayers(room).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      gone: p.gone,
      isHost: p.id === room.hostId,
      isYou: p.id === forId,
    })),
    connectedCount: connectedPlayers(room).length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    story: serializeStory(room, forId),
  };

  if (room.phase === PHASE.LOBBY) {
    out.presets = PRESETS;
    out.starterText = room.starterText || null;
    out.canStart = !!room.starterText && connectedPlayers(room).length >= MIN_PLAYERS;
  }

  if (room.phase === PHASE.WRITING) {
    const cur = room.turnIndex < room.players.length ? room.players[room.turnIndex] : null;
    out.turn = {
      currentPlayerId: cur ? cur.id : null,
      currentPlayerName: cur ? cur.name : null,
      deadline: room.turnDeadline,
      isYourTurn: !!cur && cur.id === forId,
      turnNumber: room.turnIndex + 1,
      totalTurns: room.players.length,
    };
    out.allTurnsDone = !!room.allTurnsDone;
    out.canReveal = !!room.allTurnsDone;
  }

  if (room.phase === PHASE.VOTING || room.phase === PHASE.RUNOFF) {
    const required = connectedPlayers(room).filter((p) => canVote(room, p));
    const voted = required.filter((p) => room.votes.has(p.id));
    const me = playerById(room, forId);
    out.voting = {
      isRunoff: room.phase === PHASE.RUNOFF,
      votedCount: voted.length,
      totalVoters: required.length,
      youVoted: room.votes.has(forId),
      yourVote: room.votes.get(forId) || null,
      youCanVote: me ? canVote(room, me) : false,
    };
  }

  if (room.phase === PHASE.RESULTS) {
    const tally = room.tally || {};
    out.results = {
      sharedWin: (room.winners || []).length > 1,
      noVotes: (room.winners || []).length === 0,
      totalVotes: Object.values(tally).reduce((a, b) => a + b, 0),
      winners: (room.winners || []).map((sid) => {
        const s = room.story.find((x) => x.id === sid);
        const author = s && s.authorId ? playerById(room, s.authorId) : null;
        return {
          sentenceId: sid,
          text: s ? s.text : '',
          authorName: author ? author.name : null,
          votes: tally[sid] || 0,
        };
      }),
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Room / timer lifecycle
// ---------------------------------------------------------------------------
function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}
function clearAutoReveal(room) {
  if (room.autoRevealTimer) {
    clearTimeout(room.autoRevealTimer);
    room.autoRevealTimer = null;
  }
}
function clearEmptyTimer(room) {
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

function destroyRoom(room) {
  clearTurnTimer(room);
  clearAutoReveal(room);
  clearEmptyTimer(room);
  for (const p of room.players) {
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  }
  rooms.delete(room.code);
}

function maybeScheduleEmptyDestroy(room) {
  if (connectedPlayers(room).length > 0) {
    clearEmptyTimer(room);
    return;
  }
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    if (connectedPlayers(room).length === 0) destroyRoom(room);
  }, EMPTY_ROOM_MS);
}

// ---------------------------------------------------------------------------
// WRITING phase: turns
// ---------------------------------------------------------------------------
function startTurnAt(room) {
  // Skip over players who have left the game.
  while (room.turnIndex < room.players.length && room.players[room.turnIndex].gone) {
    room.turnIndex++;
  }
  if (room.turnIndex >= room.players.length) {
    finishWriting(room);
    return;
  }
  const player = room.players[room.turnIndex];
  room.turnDeadline = now() + TURN_MS;
  clearTurnTimer(room);
  room.turnTimer = setTimeout(() => onTurnTimeout(room, player.id), TURN_MS);

  io.to(player.id).emit('your_turn', { deadline: room.turnDeadline });
  io.to(room.code).emit('turn_changed', {
    currentPlayerId: player.id,
    currentPlayerName: player.name,
    deadline: room.turnDeadline,
  });
  broadcastRoom(room);
}

function onTurnTimeout(room, playerId) {
  if (room.phase !== PHASE.WRITING) return;
  const cur = room.players[room.turnIndex];
  if (!cur || cur.id !== playerId) return; // stale
  clearTurnTimer(room);
  toastRoom(room, 'info', `انتهى وقت ${cur.name} — تم التخطّي`);
  room.turnIndex++;
  startTurnAt(room);
}

function finishWriting(room) {
  clearTurnTimer(room);
  room.turnDeadline = null;
  room.allTurnsDone = true;
  broadcastRoom(room);

  // Auto-fallback reveal if the host doesn't act.
  clearAutoReveal(room);
  room.autoRevealTimer = setTimeout(() => {
    if (room.phase === PHASE.WRITING && room.allTurnsDone) doReveal(room);
  }, AUTO_REVEAL_MS);
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------
function startGame(room) {
  if (!room.starterText) return;
  if (connectedPlayers(room).length < MIN_PLAYERS) return;

  room.phase = PHASE.WRITING;
  room.allTurnsDone = false;
  room.story = [{ id: genId(), authorId: null, text: room.starterText, index: 0 }];
  room.turnIndex = 0;
  room.votes = new Map();
  room.runoffSentenceIds = [];
  room.tally = null;
  room.winners = null;

  io.to(room.code).emit('phase_changed', { phase: room.phase });
  startTurnAt(room);
}

function doReveal(room) {
  clearAutoReveal(room);
  if (authoredSentences(room).length === 0) {
    // Everyone was skipped — nothing to vote on.
    resetToLobby(room, 'ما انكتبت أي جملة، جرّبوا مرة ثانية');
    return;
  }
  room.phase = PHASE.REVEAL;
  room.allTurnsDone = false;
  broadcastPhase(room);
}

function openVoting(room) {
  if (authoredSentences(room).length === 0) {
    resetToLobby(room, 'ما انكتبت أي جملة، جرّبوا مرة ثانية');
    return;
  }
  room.phase = PHASE.VOTING;
  room.votes = new Map();
  room.runoffSentenceIds = [];
  broadcastPhase(room);
}

function tallyVotes(room) {
  const tally = {};
  for (const sid of room.votes.values()) {
    tally[sid] = (tally[sid] || 0) + 1;
  }
  return tally;
}

function maybeFinalizeVoting(room) {
  const required = connectedPlayers(room).filter((p) => canVote(room, p));
  if (required.length === 0) {
    finalizeVoting(room);
    return;
  }
  const allVoted = required.every((p) => room.votes.has(p.id));
  if (allVoted) finalizeVoting(room);
}

function finalizeVoting(room) {
  const tally = tallyVotes(room);
  const counts = Object.values(tally);
  const max = counts.length ? Math.max(...counts) : 0;

  let winners = [];
  if (max > 0) {
    winners = Object.keys(tally).filter((sid) => tally[sid] === max);
  }

  if (winners.length > 1 && room.phase === PHASE.VOTING) {
    // Tie for first → exactly one runoff among the tied sentences.
    room.phase = PHASE.RUNOFF;
    room.runoffSentenceIds = winners.slice();
    room.votes = new Map();
    toastRoom(room, 'info', 'تعادل! جولة حسم بين الجمل المتعادلة');
    broadcastPhase(room);
    return;
  }

  // Single winner, shared win (runoff still tied), or no votes at all.
  room.phase = PHASE.RESULTS;
  room.tally = tally;
  room.winners = winners;
  broadcastPhase(room);

  io.to(room.code).emit('voting_results', {
    tally,
    winners,
    story: room.story.map((s) => {
      const author = s.authorId ? playerById(room, s.authorId) : null;
      return {
        id: s.id,
        index: s.index,
        text: s.text,
        isStarter: s.authorId === null,
        authorName: author ? author.name : null,
        votes: tally[s.id] || 0,
        isWinner: winners.includes(s.id),
      };
    }),
  });
}

function resetToLobby(room, message) {
  clearTurnTimer(room);
  clearAutoReveal(room);
  room.phase = PHASE.LOBBY;
  room.story = [];
  room.turnIndex = 0;
  room.turnDeadline = null;
  room.allTurnsDone = false;
  room.votes = new Map();
  room.runoffSentenceIds = [];
  room.tally = null;
  room.winners = null;
  room.starterText = null;
  // Drop players who left for good; keep the rest.
  room.players = room.players.filter((p) => !p.gone);
  if (!playerById(room, room.hostId)) migrateHost(room);
  if (message) toastRoom(room, 'info', message);
  broadcastPhase(room);
}

function migrateHost(room) {
  const candidate = orderedPlayers(room).find((p) => p.connected && !p.gone)
    || orderedPlayers(room).find((p) => !p.gone);
  if (candidate) {
    room.hostId = candidate.id;
    toastRoom(room, 'info', `صار ${candidate.name} المضيف الجديد`);
  }
}

// ---------------------------------------------------------------------------
// Player connect / disconnect
// ---------------------------------------------------------------------------
function attachSocket(socket, room, player) {
  player.connected = true;
  player.socketId = socket.id;
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  socket.join(player.id); // personal room → emit to this player regardless of socket
  clearEmptyTimer(room);
}

function handleDisconnect(socket) {
  const { roomCode, playerId } = socket.data || {};
  if (!roomCode || !playerId) return;
  const room = rooms.get(roomCode);
  if (!room) return;
  const player = playerById(room, playerId);
  if (!player) return;
  if (player.socketId !== socket.id) return; // a newer socket already took over

  player.connected = false;
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => onGraceExpired(room, player.id), GRACE_MS);

  broadcastRoom(room);
  maybeScheduleEmptyDestroy(room);
}

function onGraceExpired(room, playerId) {
  const player = playerById(room, playerId);
  if (!player || player.connected) return;
  player.disconnectTimer = null;

  if (room.phase === PHASE.LOBBY) {
    // Fully remove from the lobby.
    room.players = room.players.filter((p) => p.id !== playerId);
    if (room.hostId === playerId) migrateHost(room);
    if (room.players.length === 0) {
      maybeScheduleEmptyDestroy(room);
      return;
    }
    broadcastRoom(room);
    maybeScheduleEmptyDestroy(room);
    return;
  }

  // Mid-game: keep their sentences, but drop them from future turns / votes.
  player.gone = true;
  const wasHost = room.hostId === playerId;
  if (wasHost) migrateHost(room);

  if (room.phase === PHASE.WRITING && !room.allTurnsDone) {
    const cur = room.players[room.turnIndex];
    if (cur && cur.id === playerId) {
      clearTurnTimer(room);
      room.turnIndex++;
      startTurnAt(room);
    } else {
      broadcastRoom(room);
    }
  } else if (room.phase === PHASE.VOTING || room.phase === PHASE.RUNOFF) {
    broadcastRoom(room);
    maybeFinalizeVoting(room);
  } else {
    broadcastRoom(room);
  }

  maybeScheduleEmptyDestroy(room);
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('create_room', (payload, ack) => {
    const name = sanitizeName(payload && payload.name); // first player, no collisions
    const code = genRoomCode();
    const player = makePlayer(name);
    const room = {
      code,
      hostId: player.id,
      phase: PHASE.LOBBY,
      players: [player],
      story: [],
      turnIndex: 0,
      turnDeadline: null,
      turnTimer: null,
      autoRevealTimer: null,
      emptyTimer: null,
      votes: new Map(),
      runoffSentenceIds: [],
      tally: null,
      winners: null,
      starterText: null,
    };
    rooms.set(code, room);
    attachSocket(socket, room, player);
    if (typeof ack === 'function') ack({ roomCode: code, playerId: player.id, you: publicPlayer(player, room) });
    broadcastRoom(room);
  });

  socket.on('join_room', (payload, ack) => {
    const code = String((payload && payload.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ackErr(ack, 'لا توجد غرفة بهذا الكود');
    if (room.phase !== PHASE.LOBBY) return ackErr(ack, 'اللعبة بدأت بالفعل');
    if (room.players.length >= MAX_PLAYERS) return ackErr(ack, 'الغرفة ممتلئة (7 لاعبين كحد أقصى)');

    const name = uniqueName(room, sanitizeName(payload && payload.name));
    const player = makePlayer(name);
    room.players.push(player);
    attachSocket(socket, room, player);
    if (typeof ack === 'function') ack({ roomCode: code, playerId: player.id, you: publicPlayer(player, room) });
    broadcastRoom(room);
  });

  socket.on('rejoin', (payload, ack) => {
    const code = String((payload && payload.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ackErr(ack, 'انتهت الغرفة');
    const player = playerById(room, payload && payload.playerId);
    if (!player || player.gone) return ackErr(ack, 'انتهت مهلة العودة');

    attachSocket(socket, room, player);
    if (typeof ack === 'function') ack({ roomCode: code, playerId: player.id, you: publicPlayer(player, room) });
    broadcastRoom(room);

    // Re-arm the current player's turn cue if they just came back to their own turn.
    if (room.phase === PHASE.WRITING && !room.allTurnsDone) {
      const cur = room.players[room.turnIndex];
      if (cur && cur.id === player.id && room.turnDeadline) {
        io.to(player.id).emit('your_turn', { deadline: room.turnDeadline });
      }
    }
  });

  socket.on('choose_starter', (payload) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return toastTo(player.id, 'error', 'المضيف فقط يختار البداية');
    if (room.phase !== PHASE.LOBBY) return;

    let text = '';
    if (payload && payload.presetId) {
      const preset = PRESETS.find((p) => p.id === payload.presetId);
      if (preset) text = preset.text;
    } else if (payload && payload.text != null) {
      text = sanitizeSentence(payload.text);
    }
    if (!text) return toastTo(player.id, 'error', 'اكتب جملة بداية صالحة');
    room.starterText = text;
    broadcastRoom(room);
  });

  socket.on('start_game', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return toastTo(player.id, 'error', 'المضيف فقط يبدأ اللعبة');
    if (room.phase !== PHASE.LOBBY) return;
    if (!room.starterText) return toastTo(player.id, 'error', 'اختر جملة البداية أولًا');
    if (connectedPlayers(room).length < MIN_PLAYERS) {
      return toastTo(player.id, 'error', `تحتاج ${MIN_PLAYERS} لاعبين على الأقل`);
    }
    startGame(room);
  });

  socket.on('submit_sentence', (payload) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.phase !== PHASE.WRITING) return;
    const cur = room.players[room.turnIndex];
    if (!cur || cur.id !== player.id) return toastTo(player.id, 'error', 'ليس دورك الآن');

    const text = sanitizeSentence(payload && payload.text);
    if (!text) return toastTo(player.id, 'error', 'اكتب جملة قبل الإرسال');

    clearTurnTimer(room);
    const sentence = { id: genId(), authorId: player.id, text, index: room.story.length };
    room.story.push(sentence);
    io.to(room.code).emit('story_updated', { story: serializeStory(room, null) });
    room.turnIndex++;
    startTurnAt(room);
  });

  socket.on('reveal_story', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return toastTo(player.id, 'error', 'المضيف فقط يكشف القصة');
    if (room.phase !== PHASE.WRITING || !room.allTurnsDone) return;
    doReveal(room);
  });

  socket.on('open_voting', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return toastTo(player.id, 'error', 'المضيف فقط يفتح التصويت');
    if (room.phase !== PHASE.REVEAL) return;
    openVoting(room);
  });

  socket.on('cast_vote', (payload) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.phase !== PHASE.VOTING && room.phase !== PHASE.RUNOFF) return;
    if (player.gone) return;
    if (room.votes.has(player.id)) return toastTo(player.id, 'error', 'صوّتّ بالفعل');

    const sid = payload && payload.sentenceId;
    const sentence = room.story.find((s) => s.id === sid);
    if (!sentence || sentence.authorId === null) return toastTo(player.id, 'error', 'اختيار غير صالح');
    if (sentence.authorId === player.id) return toastTo(player.id, 'error', 'لا يمكنك التصويت لجملتك');
    if (room.phase === PHASE.RUNOFF && !room.runoffSentenceIds.includes(sid)) {
      return toastTo(player.id, 'error', 'هذه الجملة ليست في جولة الحسم');
    }

    room.votes.set(player.id, sid);
    broadcastRoom(room);
    maybeFinalizeVoting(room);
  });

  socket.on('force_end_voting', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return toastTo(player.id, 'error', 'المضيف فقط');
    if (room.phase !== PHASE.VOTING && room.phase !== PHASE.RUNOFF) return;
    finalizeVoting(room);
  });

  socket.on('new_game', () => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    if (room.hostId !== player.id) return toastTo(player.id, 'error', 'المضيف فقط يبدأ لعبة جديدة');
    if (room.phase !== PHASE.RESULTS) return;
    resetToLobby(room, null);
  });

  socket.on('send_reaction', (payload) => {
    const { room, player } = ctx(socket);
    if (!room || !player) return;
    const emoji = String((payload && payload.emoji) || '').slice(0, 8);
    if (!emoji) return;
    const t = now();
    if (player.lastReactionAt && t - player.lastReactionAt < REACTION_THROTTLE_MS) return;
    player.lastReactionAt = t;
    io.to(room.code).emit('reaction_burst', { emoji, fromName: player.name });
  });

  socket.on('disconnect', () => handleDisconnect(socket));
});

// ---------------------------------------------------------------------------
// Tiny utilities used by handlers
// ---------------------------------------------------------------------------
function makePlayer(name) {
  return {
    id: genId(),
    name,
    connected: false,
    gone: false,
    joinedAt: now(),
    socketId: null,
    disconnectTimer: null,
    lastReactionAt: 0,
  };
}

function publicPlayer(player, room) {
  return { id: player.id, name: player.name, isHost: player.id === room.hostId };
}

function ctx(socket) {
  const { roomCode, playerId } = socket.data || {};
  const room = rooms.get(roomCode);
  if (!room) return { room: null, player: null };
  return { room, player: playerById(room, playerId) || null };
}

function ackErr(ack, message) {
  if (typeof ack === 'function') ack({ error: message });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`قصة جماعية — listening on http://0.0.0.0:${PORT}`);
});
