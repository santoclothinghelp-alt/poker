const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS (mirrored from client) ───
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const PLAYER_COLORS = ['#c0392b','#27ae60','#e67e22','#8e44ad','#2980b9','#c9a84c','#16a085','#7f5539'];
const BOT_NAMES = ['Tom Bailey','Capesy','Mrs B','Bill','Regina','Carrick','Ryder','Isla','Kumar','Pierre','Fred','Jim','Steve','Archie','Tim Hood','Tracey','Calum Zammit','Jonesy'];

// ─── ROOMS MAP: roomCode → gameState ───
const rooms = {};

// ─── CARD UTILS ───
function makeDeck() {
  let d = [];
  for (let s of SUITS) for (let r of RANKS) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function handRank(cards) {
  const vals = cards.map(c => RANK_VAL[c.rank]).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const rc = {}; for (let v of vals) rc[v] = (rc[v] || 0) + 1;
  const counts = Object.values(rc).sort((a, b) => b - a);
  const uv = [...new Set(vals)].sort((a, b) => b - a);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = uv.length >= 5 && (uv[0] - uv[4] === 4 || (uv[0] === 14 && uv[1] === 5 && uv[4] === 2));
  if (isFlush && isStraight) return { rank: 8, name: 'Straight Flush', key: [8, ...vals] };
  if (counts[0] === 4) return { rank: 7, name: 'Four of a Kind', key: [7, ...vals] };
  if (counts[0] === 3 && counts[1] === 2) return { rank: 6, name: 'Full House', key: [6, ...vals] };
  if (isFlush) return { rank: 5, name: 'Flush', key: [5, ...vals] };
  if (isStraight) return { rank: 4, name: 'Straight', key: [4, ...vals] };
  if (counts[0] === 3) return { rank: 3, name: 'Three of a Kind', key: [3, ...vals] };
  if (counts[0] === 2 && counts[1] === 2) return { rank: 2, name: 'Two Pair', key: [2, ...vals] };
  if (counts[0] === 2) return { rank: 1, name: 'One Pair', key: [1, ...vals] };
  return { rank: 0, name: 'High Card', key: [0, ...vals] };
}

function cmpKey(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function bestHand(hole, comm) {
  const all = [...hole, ...comm];
  if (all.length < 5) return handRank(all);
  let best = null;
  for (let i = 0; i < all.length - 1; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const five = all.filter((_, idx) => idx !== i && idx !== j);
      const h = handRank(five.slice(0, 5));
      if (!best || cmpKey(h.key, best.key) > 0) best = h;
    }
  }
  return best || handRank(all.slice(0, 5));
}

// ─── COLOR ASSIGNMENT ───
function assignPlayerColors(players) {
  const pool = [...PLAYER_COLORS];
  for (let i = pool.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  players.forEach((p, i) => { p.color = pool[i % pool.length]; });
}

// ─── BOT AI ───
function preflopStrength(c1, c2) {
  const v1 = RANK_VAL[c1.rank], v2 = RANK_VAL[c2.rank];
  const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
  const pair = v1 === v2, suited = c1.suit === c2.suit, gap = hi - lo;
  let score;
  if (pair) {
    score = 0.45 + ((hi - 2) / 12) * 0.5;
  } else {
    score = ((hi - 2) / 12) * 0.5 + ((lo - 2) / 12) * 0.22;
    if (gap === 1) score += 0.05;
    else if (gap === 2) score += 0.03;
    else if (gap >= 6) score -= 0.06;
  }
  if (suited) score += 0.06;
  return Math.max(0.04, Math.min(0.97, score));
}

function postflopStrength(p, community) {
  const h = bestHand(p.cards, community);
  const base = [0.10,0.28,0.44,0.57,0.67,0.78,0.88,0.95,0.99][h.rank] ?? 0.5;
  const kicker = ((h.key[1] || 7) - 2) / 12;
  return Math.max(0.02, Math.min(0.995, base + (kicker - 0.5) * 0.06));
}

function estimateStrength(p, community) {
  return community.length === 0
    ? preflopStrength(p.cards[0], p.cards[1])
    : postflopStrength(p, community);
}

function botRaiseAmount(cur, maxBet, sizeFrac, pot, BB) {
  let target = maxBet + Math.max(BB, Math.round((pot * sizeFrac) / BB) * BB);
  target = Math.max(target, maxBet + BB, BB * 2);
  target = Math.min(target, cur.stack + cur.bet);
  return target;
}

function botDecision(cur, toCall, maxBet, G) {
  const strength = estimateStrength(cur, G.community);
  const potOdds = toCall > 0 ? toCall / (G.pot + toCall) : 0;
  const stackBB = cur.stack / G.BB;
  const diff = G.botDifficulty || 'medium';

  let bluffChance = diff === 'easy' ? 0.05 : diff === 'hard' ? 0.20 : 0.11;
  if (G.phase === 'river') bluffChance += 0.05;
  if (G.phase === 'turn') bluffChance += 0.02;
  const isBluffing = strength < 0.38 && Math.random() < bluffChance;
  const eff = isBluffing ? 0.72 + Math.random() * 0.23 : strength;
  const noiseScale = diff === 'hard' ? 0.06 : diff === 'easy' ? 0.28 : 0.14;
  const playStrength = Math.max(0, Math.min(1, eff + (Math.random() - 0.5) * noiseScale));

  if (toCall === 0) {
    if (playStrength > 0.62) return { action: 'bet', sizeFrac: 0.4 + playStrength * 0.7 };
    if (isBluffing && Math.random() < 0.55) return { action: 'bet', sizeFrac: 0.35 + Math.random() * 0.3 };
    return { action: 'check' };
  }

  const needed = potOdds * 1.15;
  if (playStrength < needed * 0.7 && !isBluffing) {
    if (toCall <= G.BB * 1.5 && stackBB > 15) return { action: 'call' };
    return { action: 'fold' };
  }
  if (playStrength < needed && !isBluffing) {
    if (toCall < cur.stack * 0.12) return { action: 'call' };
    return Math.random() < 0.72 ? { action: 'fold' } : { action: 'call' };
  }
  if (playStrength > 0.78 || isBluffing) {
    if (cur.stack <= toCall * 1.4 || stackBB < 8) return { action: 'allin' };
    return { action: 'raise', sizeFrac: 0.5 + playStrength * 0.6 };
  }
  return { action: 'call' };
}

// ─── GAME LOGIC ───
function collectBet(G, idx, amount) {
  const p = G.players[idx];
  const actual = Math.min(amount, p.stack);
  p.stack -= actual; p.bet += actual; G.pot += actual;
  if (p.stack === 0) p.allIn = true;
}

function dealHand(G) {
  G.deck = makeDeck();
  G.community = []; G.pot = 0;
  G.phase = 'preflop'; G.result = null; G.showRaise = false;
  G.log = []; G.dealPhaseIdx = 0;
  G.hostWaitingToDeal = false; G.newCardIdxs = []; G.allInReveal = false;
  G.acted = new Set();

  for (let p of G.players) {
    p.cards = [G.deck.pop(), G.deck.pop()];
    p.bet = 0; p.folded = false; p.allIn = false;
  }

  const sb = (G.dealerIdx + 1) % G.players.length;
  const bb = (G.dealerIdx + 2) % G.players.length;
  collectBet(G, sb, G.SB);
  collectBet(G, bb, G.BB);
  G.log.push(`${G.players[sb].name} posts SB $${G.SB} · ${G.players[bb].name} posts BB $${G.BB}`);
  G.raiseAmount = G.BB * 2;
  G.currentTurn = (bb + 1) % G.players.length;
}

function broadcastState(roomCode) {
  const G = rooms[roomCode];
  if (!G) return;

  // Send each socket their personalised view (with their own hole cards only)
  for (const [socketId, playerName] of Object.entries(G.socketMap)) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    // Build a sanitised state: hide other players' cards unless showdown/allIn
    const sanitised = {
      ...G,
      acted: [...G.acted],
      deck: [], // never send the deck
      players: G.players.map(p => {
        const isMe = p.name === playerName;
        const reveal = G.result || G.allInReveal;
        return {
          ...p,
          cards: isMe ? p.cards : (reveal && !p.folded ? p.cards : p.cards.map(() => null))
        };
      }),
      myName: playerName
    };

    socket.emit('state', sanitised);
  }

  // Also emit to spectators (bots have no socket, so just broadcast room list)
  io.to(roomCode).emit('players_update', G.players.map(p => ({
    name: p.name, stack: p.stack, isBot: p.isBot, color: p.color
  })));
}

function broadcastRoom(roomCode) {
  const G = rooms[roomCode];
  if (!G) return;
  io.to(roomCode).emit('room_update', {
    players: G.players.map(p => ({ name: p.name, isBot: p.isBot, color: p.color })),
    roomCode,
    hostName: G.hostName
  });
}

function advanceTurn(roomCode) {
  const G = rooms[roomCode];
  if (!G) return;

  const notFolded = G.players.filter(p => !p.folded);
  if (notFolded.length === 1) { endHand(roomCode, notFolded[0], 'Last player standing'); return; }

  const maxBet = Math.max(...G.players.map(p => p.bet || 0));
  const activePlayers = G.players.filter(p => !p.folded && !p.allIn);
  const allSettled = activePlayers.every(p => p.bet === maxBet && G.acted.has(G.players.indexOf(p)));

  const canAct = G.players.filter(p => !p.folded && !p.allIn);
  if (canAct.length === 0 && !G.result && !G.allInReveal) {
    if (G.phase === 'river') { showdown(roomCode); return; }
    runAllInBoard(roomCode); return;
  }

  let next = (G.currentTurn + 1) % G.players.length;
  let loops = 0;
  while ((G.players[next].folded || G.players[next].allIn) && loops < G.players.length) {
    next = (next + 1) % G.players.length; loops++;
  }

  if (allSettled || activePlayers.length === 0) {
    if (G.phase === 'river') { showdown(roomCode); return; }
    G.hostWaitingToDeal = true;
    broadcastState(roomCode);
    setTimeout(() => dealNextStreet(roomCode), 1000);
    return;
  }

  G.currentTurn = next;
  broadcastState(roomCode);
  scheduleBotTurn(roomCode, 700);
}

function dealNextStreet(roomCode) {
  const G = rooms[roomCode];
  if (!G || !G.hostWaitingToDeal) return;
  G.hostWaitingToDeal = false;
  for (let p of G.players) p.bet = 0;
  G.acted = new Set();

  if (G.phase === 'preflop') {
    G.newCardIdxs = [0, 1, 2];
    G.community = [G.deck.pop(), G.deck.pop(), G.deck.pop()];
    G.phase = 'flop'; G.dealPhaseIdx = 1;
    G.log.push('――― FLOP ―――');
  } else if (G.phase === 'flop') {
    G.newCardIdxs = [3];
    G.community.push(G.deck.pop());
    G.phase = 'turn'; G.dealPhaseIdx = 2;
    G.log.push('――― TURN ―――');
  } else if (G.phase === 'turn') {
    G.newCardIdxs = [4];
    G.community.push(G.deck.pop());
    G.phase = 'river'; G.dealPhaseIdx = 3;
    G.log.push('――― RIVER ―――');
  }

  let next = (G.dealerIdx + 1) % G.players.length;
  let lp = 0;
  while ((G.players[next].folded || G.players[next].allIn) && lp < G.players.length) {
    next = (next + 1) % G.players.length; lp++;
  }
  G.currentTurn = next;
  broadcastState(roomCode);

  setTimeout(() => { G.newCardIdxs = []; broadcastState(roomCode); }, 900);
  scheduleBotTurn(roomCode, 1100);
}

function runAllInBoard(roomCode) {
  const G = rooms[roomCode];
  if (!G) return;
  G.allInReveal = true;
  G.log.push('――― ALL IN — Cards revealed! ―――');
  broadcastState(roomCode);

  const streets = [];
  if (G.phase === 'preflop') streets.push('flop', 'turn', 'river');
  else if (G.phase === 'flop') streets.push('turn', 'river');
  else if (G.phase === 'turn') streets.push('river');

  let delay = 1200;
  for (const street of streets) {
    setTimeout(((st) => () => {
      if (!rooms[roomCode]) return;
      const g = rooms[roomCode];
      if (st === 'flop') {
        while (g.community.length < 3) g.community.push(g.deck.pop());
        g.newCardIdxs = [0, 1, 2]; g.phase = 'flop'; g.dealPhaseIdx = 1;
        g.log.push('――― FLOP ―――');
      } else if (st === 'turn') {
        g.community.push(g.deck.pop());
        g.newCardIdxs = [3]; g.phase = 'turn'; g.dealPhaseIdx = 2;
        g.log.push('――― TURN ―――');
      } else if (st === 'river') {
        g.community.push(g.deck.pop());
        g.newCardIdxs = [4]; g.phase = 'river'; g.dealPhaseIdx = 3;
        g.log.push('――― RIVER ―――');
      }
      broadcastState(roomCode);
      setTimeout(() => { if (rooms[roomCode]) { rooms[roomCode].newCardIdxs = []; broadcastState(roomCode); } }, 700);
    })(street), delay);
    delay += 2400;
  }

  setTimeout(() => {
    if (!rooms[roomCode]) return;
    rooms[roomCode].allInReveal = false;
    showdown(roomCode);
  }, delay + 800);
}

function showdown(roomCode) {
  const G = rooms[roomCode];
  if (!G) return;
  G.phase = 'showdown';
  const alive = G.players.filter(p => !p.folded);
  let winner = null, bestH = null;
  for (let p of alive) {
    const h = bestHand(p.cards, G.community);
    if (!bestH || cmpKey(h.key, bestH.key) > 0) { bestH = h; winner = p; }
  }
  endHand(roomCode, winner, bestH?.name || 'Best hand');
}

function endHand(roomCode, winner, handName) {
  const G = rooms[roomCode];
  if (!G) return;
  winner.stack += G.pot;
  G.result = { winner: winner.name, handName, amount: G.pot };
  G.log.push(`${winner.name} wins $${G.pot}!`);
  broadcastState(roomCode);
}

function scheduleBotTurn(roomCode, delay) {
  setTimeout(() => {
    const G = rooms[roomCode];
    if (!G || G.result || G.hostWaitingToDeal || G.allInReveal) return;
    const cur = G.players[G.currentTurn];
    if (!cur || !cur.isBot || cur.folded || cur.allIn) return;

    const curIdx = G.currentTurn;
    const maxBet = Math.max(...G.players.map(p => p.bet || 0));
    const toCall = maxBet - cur.bet;
    const decision = botDecision(cur, toCall, maxBet, G);

    setTimeout(() => {
      const g = rooms[roomCode];
      if (!g || g.result || g.hostWaitingToDeal) return;
      if (g.currentTurn !== curIdx) return;

      if (decision.action === 'check') {
        g.log.push(`${cur.name} checks`);
        g.acted.add(curIdx);
      } else if (decision.action === 'fold') {
        cur.folded = true; g.log.push(`${cur.name} folds`);
        g.acted.add(curIdx);
      } else if (decision.action === 'call') {
        const a = Math.min(toCall, cur.stack);
        cur.stack -= a; cur.bet += a; g.pot += a;
        if (cur.stack === 0) cur.allIn = true;
        g.log.push(a > 0 ? `${cur.name} calls $${a}` : `${cur.name} checks`);
        g.acted.add(curIdx);
      } else if (decision.action === 'bet' || decision.action === 'raise') {
        const target = botRaiseAmount(cur, maxBet, decision.sizeFrac, g.pot, g.BB);
        const extra = Math.min(target - cur.bet, cur.stack);
        cur.stack -= extra; cur.bet += extra; g.pot += extra;
        if (cur.stack === 0) cur.allIn = true;
        g.log.push(decision.action === 'bet' ? `${cur.name} bets $${cur.bet}` : `${cur.name} raises to $${cur.bet}`);
        g.acted = new Set([curIdx]);
      } else if (decision.action === 'allin') {
        const wasRaise = cur.stack + cur.bet > maxBet;
        g.pot += cur.stack; cur.bet += cur.stack; cur.stack = 0; cur.allIn = true;
        g.log.push(`${cur.name} goes all-in!`);
        if (wasRaise) g.acted = new Set([curIdx]); else g.acted.add(curIdx);
      }
      advanceTurn(roomCode);
    }, 450 + Math.random() * 800);
  }, delay);
}

// ─── SOCKET EVENTS ───
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Create a new room
  socket.on('create_room', ({ name, SB, BB, startStack, botDifficulty, botCount, gameMode }) => {
    // Generate unique room code
    let code;
    do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); } while (rooms[code]);

    const hostPlayer = { name, stack: startStack, cards: [], bet: 0, folded: false, allIn: false, isBot: false, color: PLAYER_COLORS[0] };
    const G = {
      roomCode: code,
      hostName: name,
      gameMode: gameMode || 'online',
      SB, BB, startStack,
      botDifficulty: botDifficulty || 'medium',
      players: [hostPlayer],
      deck: [], community: [], pot: 0,
      phase: 'preflop', currentTurn: 0, dealerIdx: 0,
      raiseAmount: BB * 2, showRaise: false,
      log: [], result: null,
      dealPhaseIdx: 0, hostWaitingToDeal: false,
      newCardIdxs: [], allInReveal: false,
      roster: [],
      gameOver: null,
      acted: new Set(),
      socketMap: { [socket.id]: name } // socketId → playerName
    };

    // Add bots immediately if bot mode
    if (gameMode === 'bots' && botCount > 0) {
      const shuffled = [...BOT_NAMES].sort(() => Math.random() - 0.5);
      for (let i = 0; i < Math.min(botCount, 7); i++) {
        G.players.push({
          name: shuffled[i], stack: startStack, cards: [], bet: 0,
          folded: false, allIn: false, isBot: true, color: PLAYER_COLORS[(i + 1) % PLAYER_COLORS.length]
        });
      }
    }

    assignPlayerColors(G.players);
    rooms[code] = G;
    socket.join(code);
    socket.emit('room_created', { roomCode: code, hostName: name });
    broadcastRoom(code);
  });

  // Join an existing room
  socket.on('join_room', ({ name, roomCode }) => {
    const code = roomCode.toUpperCase();
    const G = rooms[code];
    if (!G) { socket.emit('error', 'Room not found'); return; }
    if (G.players.length >= 8) { socket.emit('error', 'Table is full'); return; }
    if (G.phase !== 'preflop' || G.result !== null || G.players.some(p => p.cards && p.cards.length > 0 && !p.isBot)) {
      // game already started — reject (simplification: could allow late join as spectator)
      socket.emit('error', 'Game already in progress'); return;
    }
    if (G.players.some(p => p.name === name)) { socket.emit('error', 'Name already taken in this room'); return; }

    G.players.push({ name, stack: G.startStack, cards: [], bet: 0, folded: false, allIn: false, isBot: false });
    assignPlayerColors(G.players);
    G.socketMap[socket.id] = name;
    socket.join(code);
    socket.emit('room_joined', { roomCode: code, hostName: G.hostName });
    broadcastRoom(code);
  });

  // Add bot to room (host only)
  socket.on('add_bot', ({ roomCode }) => {
    const G = rooms[roomCode];
    if (!G) return;
    if (G.socketMap[socket.id] !== G.hostName) return;
    if (G.players.length >= 8) return;
    const usedNames = new Set(G.players.map(p => p.name));
    const available = BOT_NAMES.filter(n => !usedNames.has(n));
    const pool = available.length ? available : BOT_NAMES;
    const botName = pool[Math.floor(Math.random() * pool.length)];
    G.players.push({ name: botName, stack: G.startStack, cards: [], bet: 0, folded: false, allIn: false, isBot: true });
    assignPlayerColors(G.players);
    broadcastRoom(roomCode);
  });

  // Host starts the game
  socket.on('start_game', ({ roomCode }) => {
    const G = rooms[roomCode];
    if (!G) return;
    if (G.socketMap[socket.id] !== G.hostName) return;
    if (G.players.length < 2) return;

    G.roster = G.players.map(p => ({ name: p.name, isBot: p.isBot }));
    assignPlayerColors(G.players);
    dealHand(G);
    broadcastState(roomCode);
    scheduleBotTurn(roomCode, 900);
  });

  // Player action
  socket.on('action', ({ roomCode, action, raiseAmount }) => {
    const G = rooms[roomCode];
    if (!G) return;
    const playerName = G.socketMap[socket.id];
    if (!playerName) return;

    const me = G.players.find(p => p.name === playerName);
    const myIdx = G.players.indexOf(me);
    if (!me || G.currentTurn !== myIdx || me.folded || G.result || G.hostWaitingToDeal) return;

    const maxBet = Math.max(...G.players.map(p => p.bet || 0));
    const toCall = maxBet - me.bet;

    if (action === 'fold') {
      me.folded = true; G.log.push(`${me.name} folds`);
      G.acted.add(myIdx);
    } else if (action === 'check') {
      G.log.push(`${me.name} checks`);
      G.acted.add(myIdx);
    } else if (action === 'call') {
      const a = Math.min(toCall, me.stack);
      me.stack -= a; me.bet += a; G.pot += a;
      if (me.stack === 0) me.allIn = true;
      G.log.push(`${me.name} calls $${a}`);
      G.acted.add(myIdx);
    } else if (action === 'raise') {
      const target = raiseAmount || G.raiseAmount;
      const extra = Math.min(target - me.bet, me.stack);
      me.stack -= extra; me.bet += extra; G.pot += extra;
      if (me.stack === 0) me.allIn = true;
      G.log.push(`${me.name} raises to $${me.bet}`);
      G.acted = new Set([myIdx]);
    } else if (action === 'allin') {
      const wasRaise = me.stack + me.bet > maxBet;
      G.pot += me.stack; me.bet += me.stack; me.stack = 0; me.allIn = true;
      G.log.push(`${me.name} goes all-in!`);
      if (wasRaise) G.acted = new Set([myIdx]); else G.acted.add(myIdx);
    }

    G.showRaise = false;
    advanceTurn(roomCode);
  });

  // Next hand (host only)
  socket.on('next_hand', ({ roomCode }) => {
    const G = rooms[roomCode];
    if (!G) return;
    if (G.socketMap[socket.id] !== G.hostName) return;

    G.dealerIdx = (G.dealerIdx + 1) % G.players.length;
    G.players = G.players.filter(p => p.stack > 0);
    if (G.players.length < 2) {
      const winner = G.players[0];
      G.gameOver = { winner: winner?.name || 'Someone', amount: winner?.stack || 0 };
      G.result = null;
      broadcastState(roomCode);
      return;
    }
    dealHand(G);
    broadcastState(roomCode);
    scheduleBotTurn(roomCode, 900);
  });

  // Play again (host only)
  socket.on('play_again', ({ roomCode }) => {
    const G = rooms[roomCode];
    if (!G) return;
    if (G.socketMap[socket.id] !== G.hostName) return;
    G.gameOver = null; G.result = null;
    G.players = G.roster.map(r => ({
      ...r, stack: G.startStack, cards: [], bet: 0, folded: false, allIn: false,
      color: G.players.find(p => p.name === r.name)?.color || PLAYER_COLORS[0]
    }));
    G.dealerIdx = 0;
    assignPlayerColors(G.players);
    dealHand(G);
    broadcastState(roomCode);
    scheduleBotTurn(roomCode, 900);
  });

  // Exit to lobby
  socket.on('exit_lobby', ({ roomCode }) => {
    const G = rooms[roomCode];
    if (!G) return;
    const playerName = G.socketMap[socket.id];
    G.log.push(`__RED__${playerName} has left the table.`);
    // Remove player
    G.players = G.players.filter(p => p.name !== playerName);
    delete G.socketMap[socket.id];
    socket.leave(roomCode);

    // If host left, close room
    if (playerName === G.hostName) {
      io.to(roomCode).emit('room_closed', 'The host left the table.');
      delete rooms[roomCode];
    } else {
      broadcastState(roomCode);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);
    // Find which room this socket was in
    for (const [code, G] of Object.entries(rooms)) {
      if (G.socketMap[socket.id]) {
        const name = G.socketMap[socket.id];
        G.log.push(`__RED__${name} disconnected.`);
        delete G.socketMap[socket.id];
        // Don't remove player immediately — they might reconnect
        // But if the host disconnected, close after 30s
        if (name === G.hostName) {
          setTimeout(() => {
            if (rooms[code] && !Object.values(rooms[code].socketMap).includes(G.hostName)) {
              io.to(code).emit('room_closed', 'Host disconnected.');
              delete rooms[code];
            }
          }, 30000);
        }
        broadcastState(code);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Oxy's Hold'em running on port ${PORT}`));
