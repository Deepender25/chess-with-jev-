import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { fuseDecision, scoreToUnit, unitToLabel } from '../src/brain/chessBrain.js';
import { OpeningBook, BOOK_LINES } from '../src/brain/openingBook.js';
import {
  buildState,
  buildQuestions,
  type CandidateMove,
  type StrategyOutput
} from '../src/brain/jevStrategy.js';
import { analyzePosition } from '../src/brain/positionFacts.js';
import { Position } from '../src/engine/position.js';
import { SearchEngine } from '../src/engine/search.js';

/* -------------------------------------------------------------------------- */
/* Opening book                                                               */
/* -------------------------------------------------------------------------- */

describe('opening book', () => {
  const book = new OpeningBook();

  it('has no unreplayable lines', () => {
    expect(book.getRejected()).toEqual([]);
  });

  it('indexes the start position and offers only sound first moves', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const moves = book.movesFor(start);
    expect(moves.length).toBeGreaterThan(0);
    for (const san of moves) {
      const chess = new Chess();
      expect(() => chess.move(san)).not.toThrow();
      expect(['e4', 'd4', 'Nf3', 'c4']).toContain(san);
    }
  });

  it('never suggests an illegal book move, at any point along its own lines', () => {
    for (const line of BOOK_LINES) {
      const chess = new Chess();
      for (const san of line.split(' ')) {
        for (const suggestion of book.movesFor(chess.fen())) {
          const probe = new Chess(chess.fen());
          expect(() => probe.move(suggestion), `${suggestion} after ${line}`).not.toThrow();
        }
        chess.move(san);
      }
    }
  });

  it('is deterministic for a given position and ply', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(book.pick(start, 0)).toBe(book.pick(start, 0));
  });
});

/* -------------------------------------------------------------------------- */
/* Position facts                                                             */
/* -------------------------------------------------------------------------- */

describe('position facts', () => {
  it('detects a passed pawn and counts its steps to promotion', () => {
    const facts = analyzePosition(new Position('8/5k2/8/6P1/8/8/5K2/8 w - - 0 1'));
    const mine = facts.passedPawns.filter((pawn) => pawn.side === 'w');
    expect(mine.length).toBe(1);
    expect(mine[0].square).toBe('g5');
    // g5 -> g8 is three pawn moves.
    expect(mine[0].stepsToPromotion).toBe(3);
  });

  it('reports an undefended piece the opponent can take', () => {
    const facts = analyzePosition(new Position('4k3/8/8/3r4/8/8/8/3RK3 w - - 0 1'));
    expect(
      facts.hangingPieces.some(
        (piece) => piece.side === 'b' && piece.square === 'd5' && piece.value === 500
      )
    ).toBe(true);
  });

  it('recognises the opening, middlegame and endgame phases', () => {
    expect(analyzePosition(new Position()).phase).toBe('opening');
    expect(
      analyzePosition(new Position('r1bq1rk1/pp2ppbp/2np1np1/8/2N1P3/2P2N2/PP2BPPP/R1BQ1RK1 w - - 0 10'))
        .phase
    ).toBe('middlegame');
    expect(analyzePosition(new Position('8/5k2/8/6P1/8/8/5K2/8 w - - 0 1')).phase).toBe('endgame');
  });

  it('reports material from the side to move point of view', () => {

/* -------------------------------------------------------------------------- */
/* Jev request construction                                                   */
/* -------------------------------------------------------------------------- */

describe('jev request', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const pos = new Position(fen);
  const search = new SearchEngine(16).search(pos, { maxDepth: 4 });
  const best = search.rootMoves[0];

  const candidates: CandidateMove[] = [
    {
      move: best.move,
      uci: 'e1g1',
      san: 'O-O',
      rank: 1,
      scoreCp: best.score,
      evalLossCp: 0,
      exact: true,
      isCheck: false,
      isCapture: false,
      isCastle: true,
      isPromotion: false,
      isMate: false,
      looseAfter: [],
      after: analyzePosition(new Position(fen)),
      expectedReply: null,
      pvSan: ['O-O'],
      pvText: '1.O-O',
      purpose: 'Castles the king to safety',
      risk: 'No piece of yours is left attacked and undefended'
    }
  ];

  const input = {
    fen,
    facts: analyzePosition(pos, ['e4', 'e5', 'Bc4', 'Nc6', 'Nf3']),
    candidates,
    search: {
      depth: search.depth,
      nodes: search.nodes,
      scoreCp: best.score,
      bestSan: 'O-O',
      pvSan: ['O-O'],
      pvText: '1.O-O'
    },
    moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Nf3']
  };

  it('uses only the three documented question types', () => {
    const questions = buildQuestions(input);
    const types = new Set(Object.values(questions).map((question) => question.type));
    expect([...types].sort()).toEqual(['choice', 'noul', 'score']);
  });

  it('keeps every question inside the documented limits', () => {
    for (const question of Object.values(buildQuestions(input))) {
      if (question.type === 'choice') {
        const count = Object.keys(question.criteria).length;
        expect(count).toBeGreaterThanOrEqual(1);
        expect(count).toBeLessThanOrEqual(255);
      }
      if (question.type === 'score') {
        expect(question.criteria.length).toBeGreaterThanOrEqual(2);
        expect(question.criteria.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('offers a rejection option so the model is never forced into a listed move', () => {
    const plan = buildQuestions(input).plan;
    expect(plan.type).toBe('choice');
    if (plan.type === 'choice') expect(Object.keys(plan.criteria)).toContain('none_of_these');
  });

  it('carries every field its questions refer to, including the engine evidence', () => {
    const state = buildState(input);
    for (const key of ['your_king', 'enemy_king', 'structures', 'engine_search', 'candidate_moves']) {
      expect(state).toHaveProperty(key);
    }
    const moves = state.candidate_moves as Record<string, Record<string, unknown>>;
    expect(Object.keys(moves)).toContain('O-O');
    expect(moves['O-O']).toHaveProperty('engine_evaluation');
    expect(moves['O-O']).toHaveProperty('risk');

    for (const question of Object.values(buildQuestions(input))) {
      expect(JSON.stringify(question.instructions ?? '').length).toBeGreaterThan(0);
    }

/* -------------------------------------------------------------------------- */
/* Fusion: the guardrails that decide how much authority Jev gets             */
/* -------------------------------------------------------------------------- */

describe('decision fusion', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
  const pos = new Position(fen);
  const search = new SearchEngine(16).search(pos, { maxDepth: 4 });
  const second = search.rootMoves[1];

  const options = {
    trustWindowCp: 40,
    maxAcceptableLossCp: 70,
    minPlanConfidence: 0.3,
    forcingGapCp: 120
  };

  const candidate = (san: string, evalLossCp: number, rank: number, move: number): CandidateMove => ({
    move,
    uci: 'e1g1',
    san,
    rank,
    scoreCp: search.rootMoves[0].score - evalLossCp,
    evalLossCp,
    exact: true,
    isCheck: false,
    isCapture: false,
    isCastle: false,
    isPromotion: false,
    isMate: false,
    looseAfter: [],
    after: analyzePosition(pos),
    expectedReply: null,
    pvSan: [san],
    pvText: san,
    purpose: 'Improves the position',
    risk: 'No piece of yours is left attacked and undefended'
  });

  const strategy = (overrides: Partial<StrategyOutput>): StrategyOutput => ({
    model: 'jev-test',
    planChoice: null,
    planConfidence: 0,
    planProbabilities: {},
    strategicPriority: null,
    positionBalance: null,
    opponentThreat: null,
    attackAvailable: null,
    positionCharacter: null,
    forcingLevel: null,
    latencyMs: 5,
    ...overrides
  });

  it('plays the model plan when the move is inside the trust window', () => {
    const candidates = [
      candidate('Best1', 0, 1, search.rootMoves[0].move),
      candidate('Alt2', 20, 2, second.move)
    ];
    const outcome = fuseDecision(
      fen,
      search,
      candidates,
      strategy({ planChoice: 'Alt2', planConfidence: 0.8, planProbabilities: { Alt2: 0.8 } }),
      options
    );
    expect(outcome.path).toBe('jev_plan');
    expect(outcome.san).toBe('Alt2');
    expect(outcome.confidence).toBeGreaterThan(0.5);
  });

  it('keeps the engine move when the model pick drifts outside its confidence window', () => {
    const candidates = [
      candidate('Best1', 0, 1, search.rootMoves[0].move),
      candidate('Drift2', 60, 2, second.move)
    ];
    const outcome = fuseDecision(
      fen,
      search,
      candidates,
      strategy({ planChoice: 'Drift2', planConfidence: 0.5, planProbabilities: { Drift2: 0.5 } }),
      options
    );
    expect(outcome.path).toBe('engine_best');
    expect(outcome.overrideReason).toContain('window');
  });

  it('never serves a move past the absolute blunder ceiling', () => {
    const candidates = [
      candidate('Best1', 0, 1, search.rootMoves[0].move),
      candidate('Blunder2', 300, 2, second.move)
    ];
    const outcome = fuseDecision(
      fen,
      search,
      candidates,
      strategy({ planChoice: 'Blunder2', planConfidence: 0.95, planProbabilities: { Blunder2: 0.95 } }),
      options
    );
    expect(outcome.path).toBe('engine_best');
    expect(outcome.overrideReason).toContain('ceiling');
  });

  it('ignores a torn model, because confidence is used as a gate', () => {
    const candidates = [
      candidate('Best1', 0, 1, search.rootMoves[0].move),
      candidate('Alt2', 10, 2, second.move)
    ];
    const outcome = fuseDecision(
      fen,
      search,
      candidates,
      strategy({ planChoice: 'Alt2', planConfidence: 0.1, planProbabilities: { Alt2: 0.35 } }),
      options
    );
    expect(outcome.path).toBe('engine_best');
    expect(outcome.overrideReason).toContain('torn');
  });

  it('honours an explicit rejection of every candidate', () => {
    const candidates = [candidate('Best1', 0, 1, search.rootMoves[0].move)];
    const outcome = fuseDecision(
      fen,
      search,
      candidates,
      strategy({ planChoice: 'none_of_these', planConfidence: 0.9 }),
      options
    );
    expect(outcome.path).toBe('engine_best');
    expect(outcome.overrideReason).toContain('rejected');
  });

  it('falls back to the engine when the model answered nothing', () => {
    const candidates = [candidate('Best1', 0, 1, search.rootMoves[0].move)];
    expect(fuseDecision(fen, search, candidates, null, options).path).toBe('engine_best');
    expect(fuseDecision(fen, search, candidates, strategy({}), options).path).toBe('engine_best');
  });
});

/* -------------------------------------------------------------------------- */
/* Scoring helpers                                                            */
/* -------------------------------------------------------------------------- */

describe('scoring helpers', () => {
  it('maps centipawns onto a symmetric 0..1 scale', () => {
    expect(scoreToUnit(0)).toBeCloseTo(0.5, 5);
    expect(scoreToUnit(320) + scoreToUnit(-320)).toBeCloseTo(1, 5);
    expect(scoreToUnit(2000)).toBeGreaterThan(0.99);
  });

  it('labels evaluations sensibly', () => {
    expect(unitToLabel(0.5)).toBe('Equal / Balanced');
    expect(unitToLabel(0.9)).toBe('Decisively Winning');
    expect(unitToLabel(0.1)).toBe('Decisively Losing');
  });
});
  });
});
    const facts = analyzePosition(new Position('4k3/8/8/8/8/8/8/3QK3 b - - 0 1'));
    expect(facts.sideToMove).toBe('b');
    expect(facts.materialDeltaPawns).toBe(-9);
  });
});