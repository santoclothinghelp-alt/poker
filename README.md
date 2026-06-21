# Oxy's Hold'em — Multiplayer

Real-time multiplayer Texas Hold'em, powered by Node.js + Socket.io.

## Quick Deploy to Railway (free)

### 1. Push to GitHub
```bash
cd oxys-holdem
git init
git add .
git commit -m "Oxy's Hold'em multiplayer"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/oxys-holdem.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to **https://railway.app** and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `oxys-holdem` repo
4. Railway auto-detects Node.js and deploys — done!
5. Click **Settings → Networking → Generate Domain** to get your public URL
6. Share that URL with friends 🎉

That's it. Railway gives you a live URL like `oxys-holdem-production.up.railway.app`.

---

## Run locally (for testing)

```bash
npm install
npm start
# Open http://localhost:3000
```

---

## How it works

```
Browser (Player 1) ──┐
Browser (Player 2) ──┤── Socket.io ──▶ server.js (Node.js on Railway)
Browser (Player 3) ──┘                  holds all game state
```

- **Server** (`server.js`) — manages rooms, runs the dealer, controls bots, and broadcasts state to every player after each action.
- **Client** (`public/index.html`) — renders the table, sends player actions to the server via Socket.io.

## Features
- Up to 8 players per table
- Online multiplayer with shareable room codes
- Bots (easy / medium / hard) fill empty seats
- Full Texas Hold'em: preflop → flop → turn → river → showdown
- All-in side pots, card reveal animations
- Hide-your-cards button for IRL play

## File structure
```
oxys-holdem/
├── server.js          ← Node.js server (game logic + Socket.io)
├── package.json
├── railway.json       ← Railway deployment config
└── public/
    └── index.html     ← Full client (HTML/CSS/JS, no framework)
```
