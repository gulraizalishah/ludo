// Plays full 2- and 4-player games through the same server logic the Edge Function uses.
import { createGame, isOver } from '../engine.js';
import { stepState, autoState } from '../supabase/functions/_shared/play.js';
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
