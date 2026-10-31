// Plays full 2- and 4-player games through the same server logic the Edge Function uses.
import { createGame, isOver, getLegalMoves } from '../engine.js';
import { stepState, autoState, IDLE_LIMIT } from '../supabase/functions/_shared/play.js';
import { readFileSync } from 'fs';
if (readFileSync('engine.js', 'utf8') !== readFileSync('supabase/functions/_shared/engine.js', 'utf8')) { console.log('ENGINE COPY OUT OF SYNC'); process.exit(1); }
let finished = 0, evOk = true, rejects = 0;
for (let g = 0; g < 40; g++) {
  const n = g % 2 ? 4 : 2, colors = ['red', 'green', 'yellow', 'blue'].filter((_, i) => n === 4 || i % 2 === 0);
  let s = { ...createGame(colors), ev: { n: 0 } }, steps = 0;
  while (!s.winners.length && steps++ < 100000) {
    if (stepState(s, 'move', 0) && s.dice == null) rejects++;           // moving before rolling must be refused
    if (s.dice != null && stepState(s, 'roll')) rejects++;              // rolling twice must be refused
    const nx = autoState(s); if (nx.ev.n !== s.ev.n + 1) evOk = false; s = nx;
  }
  if (s.winners.length) finished++;
}
console.log('games finished:', finished, '/ 40 | event numbers consecutive:', evOk, '| illegal actions accepted:', rejects);

// A player who walks away must forfeit, never win, and never block the others.
let ok2 = true, ok4 = true;
for (const n of [2, 4]) for (let g = 0; g < 20; g++) {
  const colors = ['red', 'green', 'yellow', 'blue'].filter((_, i) => n === 4 || i % 2 === 0);
  let s = { ...createGame(colors), ev: { n: 0 } }, steps = 0, gone = false;
  while (!s.winners.length && steps++ < 100000) {
    const cur = s.colors[s.turn];
    if (cur === 'yellow' || cur === 'green' && n === 2) { s = autoState(s); }           // 'yellow' is the idle player (red/yellow in a 2-player game)
    else if (s.dice == null) s = stepState(s, 'roll', 0);
    else s = stepState(s, 'move', getLegalMoves(s, s.dice)[0]);
    if (s.out?.includes('yellow')) { gone = true; if (s.tokens.yellow.some((t) => t !== -1)) (n === 2 ? ok2 = false : ok4 = false); }
  }
  const yellowWon = s.winners[0] === 'yellow';
  if (!gone || yellowWon || !s.winners.length) (n === 2 ? ok2 = false : ok4 = false);
}
console.log('idle player forfeits, pieces removed, never wins:  2-player', ok2, '| 4-player', ok4, '| limit', IDLE_LIMIT);
