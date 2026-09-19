/**
 * Live end-to-end check against the real TypeSafe System One API.
 *
 * Run with:  npm run test:live      (from the server directory)
 *
 * Unlike the unit tests, this one talks to api.typesafe.ai using
 * TYPESAFE_API_KEY from the environment. It is deliberately excluded from the
 * normal suite so `npm test` stays hermetic and fast.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChessBrain } from './src/brain/chessBrain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface Scenario {
  label: string;
  fen: string;
  moves: string[];
  note: string;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'Position from the old telemetry log (Black is already down a queen)',
    // The old brain suggested Rc8, Rd6 and Bf5 here, each at 13-40% confidence,
    // because it was asked to choose from every legal move with no evaluation.
    // Black is a queen down; the only real question is which try keeps the game
    // alive longest.
    fen: '3rkb1r/pppbpppp/2n5/6n1/3P2N1/2P1PB1P/PP3PP1/R1BQ1RK1 b - - 0 1',
    moves: [
      'e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4',
      'Nxc6', 'bxc6', 'Bd3', 'd5', 'exd5', 'cxd5', 'O-O', 'O-O', 'h3', 'Bd6',
      'Re1', 'Re8', 'Bf4', 'Bxf4'
    ],
    note: 'A losing position: the engine should say so plainly instead of proposing a cheerful rook sortie.'
  },
  {
    label: 'Balanced middlegame (where a plan actually decides the game)',
    fen: 'r1bqk2r/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQK2R w KQkq - 0 9',
    moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],
    note: 'Many playable moves with nearly equal evaluations: exactly the case where Jev should steer the plan.'
  },
  {
    label: 'Balanced opening, many equal options',
    fen: 'rnbqkb1r/ppp1pppp/5n2/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3',
    moves: ['d4', 'd5', 'c4', 'Nf6'],
    note: 'Classical queen pawn structure: a planning decision with no tactical content at all.'
  }
];

async function main(): Promise<void> {
  const brain = new ChessBrain({ useJev: true, useBook: false, searchTimeMs: 2500, searchMaxDepth: 12 });
  console.log('Brain configuration:', brain.describeConfiguration());
  console.log('');

  for (const scenario of SCENARIOS) {
    console.log('='.repeat(78));
    console.log(scenario.label);
    console.log(scenario.note);
    console.log(`FEN: ${scenario.fen}`);
    console.log('-'.repeat(78));

    try {
      const decision = await brain.decide({ fen: scenario.fen, moves: scenario.moves });

      console.log(`decided by      : ${decision.decisionPath}`);
      console.log(`move            : ${decision.recommendedMove} (${decision.fromSquare}->${decision.toSquare})`);
      console.log(`confidence      : ${(decision.confidence * 100).toFixed(0)}%`);
      console.log(`engine          : depth ${decision.search.depth}, ${decision.search.nodes.toLocaleString()} nodes, ` +
        `${(decision.search.score / 100).toFixed(2)} pawns`);
      console.log(`main line       : ${decision.pvSan.join(' ')}`);
      console.log(
        `Jev consulted   : ${decision.jevUsed ? 'yes' : 'no'}` +
          (decision.strategy
            ? `  model=${decision.strategy.model} plan="${decision.strategy.planChoice}" ` +
              `planConfidence=${decision.strategy.planConfidence.toFixed(2)}`
            : '')
      );
      if (decision.strategy) {
        const p = decision.strategy.planProbabilities;
        const ranked = Object.entries(p)
          .sort((a, b) => b[1] - a[1])
          .map(([key, value]) => `${key}=${(value * 100).toFixed(0)}%`)
          .join(' ');
        console.log(`Jev distribution: ${ranked || 'none returned'}`);
        console.log(
          `Jev reads       : priority=${decision.strategy.strategicPriority ?? 'n/a'} ` +
            `balance=${decision.strategy.positionBalance?.toFixed(2) ?? 'n/a'} ` +
            `opponentThreat=${decision.strategy.opponentThreat?.toFixed(2) ?? 'n/a'} ` +
            `attackAvailable=${decision.strategy.attackAvailable?.toFixed(2) ?? 'n/a'} ` +
            `character=${decision.strategy.positionCharacter ?? 'n/a'}`
        );
      }
      if (decision.jevOverrideReason) console.log(`override        : ${decision.jevOverrideReason}`);
      console.log(`theme           : ${decision.strategicTheme}`);
      console.log(`rationale       : ${decision.rationale}`);
      console.log(`latency         : ${decision.latencyMs}ms ` +
        `(search ${decision.latencyBreakdown.searchMs}ms, Jev ${decision.latencyBreakdown.jevMs}ms)`);
      console.log(
        `candidates      : ${decision.topCandidates
          .map((candidate) => `${candidate.move}(${Math.round(candidate.probability * 100)}%)`)
          .join(' ')}`
      );
    } catch (error) {
      console.error('FAILED:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }

    console.log('');
  }
}

void main();