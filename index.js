// index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());

let currentRound = null;
let isCrashed = false;
let liveScore = 1.00;
let crashCounter = 0; // to track low crash count

function generateCrashPoint() {
  crashCounter++;

  if (crashCounter >= 7 && crashCounter <= 15 && Math.random() < 0.3) {
    crashCounter = 0; // reset after high value
    return +(Math.random() * 30 + 20).toFixed(2); // high value between 20x-50x
  }

  const roll = Math.random() * 100;
  if (roll < 55) return +(1 + Math.random()).toFixed(2);
  else if (roll < 80) return +(Math.random() * 8 + 2).toFixed(2);
  else if (roll < 95) return +(Math.random() * 20 + 10).toFixed(2);
  else return +(Math.random() * 20 + 30).toFixed(2); // max upto 50x
}

async function setupTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS luckyjet_round (
      id INT AUTO_INCREMENT PRIMARY KEY,
      roundId BIGINT,
      crashPoint FLOAT,
      isRunning BOOLEAN DEFAULT false,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS luckyjet_round_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      roundId BIGINT,
      crashPoint FLOAT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function prefillRounds() {
  const [rows] = await db.execute('SELECT COUNT(*) AS total FROM luckyjet_round');
  const remaining = 30 - rows[0].total;
  for (let i = 0; i < remaining; i++) {
    const roundId = Date.now() + i * 1000;
    const crashPoint = generateCrashPoint();
    await db.execute('INSERT INTO luckyjet_round (roundId, crashPoint) VALUES (?, ?)', [roundId, crashPoint]);
  }
  console.log('✅ Rounds pre-filled to 30');
}

async function getLast20Rounds() {
  const [rows] = await db.execute('SELECT * FROM luckyjet_round_log ORDER BY id DESC LIMIT 20');
  return rows;
}

async function maintainLogLimit() {
  await db.execute(`
    DELETE FROM luckyjet_round_log
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id FROM luckyjet_round_log ORDER BY id DESC LIMIT 200
      ) AS temp
    )
  `);
}

async function startGameLoop() {
  while (true) {
    const [rows] = await db.execute('SELECT * FROM luckyjet_round ORDER BY id ASC LIMIT 1');
    if (rows.length === 0) {
      console.log('⚠️ No round available, refilling...');
      await prefillRounds();
      continue;
    }

    currentRound = rows[0];
    isCrashed = false;
    liveScore = 1.00;

    await db.execute('UPDATE luckyjet_round SET isRunning = true WHERE id = ?', [currentRound.id]);

    const previousRounds = await getLast20Rounds();
    io.emit('roundStart', {
      roundId: currentRound.roundId,
      crashPoint: currentRound.crashPoint,
      previousRounds
    });

    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (isCrashed) return;

        if (liveScore < 1.5) liveScore += 0.01;
        else if (liveScore < 3) liveScore += 0.02;
        else if (liveScore < 5) liveScore += 0.05;
        else if (liveScore < 10) liveScore += 0.1;
        else if (liveScore < 50) liveScore += 0.15;
        else liveScore += 0.2;

        liveScore = +liveScore.toFixed(2);
        io.emit('liveScore', liveScore);

        if (liveScore >= currentRound.crashPoint) {
          isCrashed = true;
          io.emit('crashed', currentRound.crashPoint);
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    await db.execute('DELETE FROM luckyjet_round WHERE id = ?', [currentRound.id]);
    await db.execute('INSERT INTO luckyjet_round_log (roundId, crashPoint) VALUES (?, ?)', [currentRound.roundId, currentRound.crashPoint]);
    await maintainLogLimit();

    const newRoundId = Date.now();
    const newCrashPoint = generateCrashPoint();
    await db.execute('INSERT INTO luckyjet_round (roundId, crashPoint) VALUES (?, ?)', [newRoundId, newCrashPoint]);

    await new Promise(resolve => setTimeout(resolve, 8000));
  }
}

io.on('connection', async socket => {
  console.log('⚡ Client connected');
  const previousRounds = await getLast20Rounds();
  socket.emit('initData', {
    roundId: currentRound?.roundId,
    crashPoint: currentRound?.crashPoint,
    previousRounds,
    liveScore
  });
});

server.listen(3000, async () => {
  console.log('🚀 Server running on port 3000');
  await setupTables();
  await prefillRounds();
  startGameLoop();
});
