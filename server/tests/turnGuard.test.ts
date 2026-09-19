import { describe, it, expect } from 'vitest';
import { JevChessEngine } from '../src/jevClient.js';
import type { BoardStatePayload } from '../src/types.js';

/**
 * The turn guard.
 *
 * The extension asks for advice on behalf of one side. If the position is not
 * that side's turn, the engine must decline rather than hand back the opponent's
 * best move, because a recommendation shown for the wrong side is worse than no
 * recommendation at all.
 *
 * Jev is disabled and the search is kept small so this suite is hermetic and
 * fast; the guard runs before either is reached in the declining case anyway.
 */
const engine = new JevChessEngine({
  brain: { useJev: false, searchTimeMs: 600, searchMaxDepth: 6, useBook: false }
});

/** Black to move: the Sicilian after White's fifth move. */
const BLACK_TO_MOVE = 'r1bqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 6';

describe('turn authority guard', () => {
  it('declines when it is not the requesting side to move', async () => {
    const payload: BoardStatePayload = {
      fen: BLACK_TO_MOVE,
      turn: 'b',
      perspective: 'w',
      moves: []
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.waitingForOpponent).toBe(true);
    expect(decision.recommendedMove).toBe('');
    expect(decision.fromSquare).toBeUndefined();
    expect(decision.toSquare).toBeUndefined();
    expect(decision.topCandidates).toEqual([]);
    expect(decision.decisionPath).toBe('waiting_for_opponent');
    expect(decision.strategicRationale).toContain('not the side that asked');
  });

  it('answers normally when it is the requesting side to move', async () => {
    const payload: BoardStatePayload = {
      fen: BLACK_TO_MOVE,
      turn: 'b',
      perspective: 'b',
      moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.waitingForOpponent).toBeUndefined();
    expect(decision.recommendedMove).toBeTruthy();
    expect(decision.fromSquare).toBeTruthy();
    expect(decision.toSquare).toBeTruthy();
    expect(decision.engineDepth).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('stays backwards compatible when no perspective is supplied', async () => {
    const payload: BoardStatePayload = {
      fen: BLACK_TO_MOVE,
      turn: 'b',
      moves: []
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.recommendedMove).toBeTruthy();
  }, 20000);

  it('still reports a finished game rather than a move', async () => {
    const payload: BoardStatePayload = {
      fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
      turn: 'w',
      perspective: 'w',
      moves: ['f3', 'e5', 'g4', 'Qh4#']
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.decisionPath).toBe('game_over');
    expect(decision.positionEvaluationLabel).toBe('Checkmate');
    expect(decision.recommendedMove).toBe('');
  });
});