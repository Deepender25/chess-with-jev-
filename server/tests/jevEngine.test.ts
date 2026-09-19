import { describe, it, expect, beforeEach } from 'vitest';
import { JevChessEngine } from '../src/jevClient.js';
import { BoardStatePayload } from '../src/types.js';

describe('JevChessEngine Multi-Primitive Matrix', () => {
  let engine: JevChessEngine;

  beforeEach(() => {
    engine = new JevChessEngine();
  });

  it('should evaluate initial position and return candidates with rationale and coordinates', async () => {
    const payload: BoardStatePayload = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      turn: 'w',
      fullMoveNumber: 1,
      moves: []
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.recommendedMove).toBeTruthy();
    expect(decision.fromSquare).toBeTruthy();
    expect(decision.toSquare).toBeTruthy();
    expect(decision.topCandidates.length).toBeGreaterThan(0);
    expect(decision.strategicRationale).toBeTruthy();
    expect(decision.confidence).toBeGreaterThan(0);
  }, 15000);

  it('should find tactical checkmate move when available with checkmate rationale', async () => {
    const payload: BoardStatePayload = {
      fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
      turn: 'w',
      fullMoveNumber: 4,
      moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.recommendedMove).toBe('Qxf7#');
    expect(decision.fromSquare).toBe('h5');
    expect(decision.toSquare).toBe('f7');
    expect(decision.isCheckmateOpportunity).toBe(true);
    expect(decision.strategicRationale).toContain('checkmate');
  }, 15000);

  it('should flag tactical danger and generate defensive rationale in check', async () => {
    const payload: BoardStatePayload = {
      fen: 'rnb1kbnr/pppp1ppp/8/4p3/7q/5P2/PPPPP1PP/RNBQKBNR w KQkq - 1 3',
      turn: 'w',
      fullMoveNumber: 3,
      moves: ['f3', 'e5', 'Kf2', 'Qh4+']
    };

    const decision = await engine.evaluatePosition(payload);

    expect(decision.isTacticalDanger).toBe(true);
    expect(decision.recommendedMove).toBe('g3');
    expect(decision.fromSquare).toBe('g2');
    expect(decision.toSquare).toBe('g3');
    expect(['defense', 'defend_threat', 'development']).toContain(decision.strategicTheme);
  }, 15000);
});

