import { describe, it, expect, beforeEach } from 'vitest';
import {
  FENTracker,
  STANDARD_START_LAYOUT,
  deriveCastlingRights,
  layoutOf,
  replayMoves,
  resolveBoardState,
  validateLayout
} from '../src/lib/fenTracker';

describe('FEN Tracker', () => {
  let tracker: FENTracker;

  beforeEach(() => {
    tracker = new FENTracker();
  });

  it('should initialize with standard starting FEN', () => {
    const state = tracker.updateFromMoves([]);
    expect(state.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(state.turn).toBe('w');
    expect(state.castlingRights).toBe('KQkq');
    expect(state.enPassantSquare).toBe('-');
    expect(state.moveCount).toBe(0);
    expect(state.isGameOver).toBe(false);
  });

  it('should correctly track 1. e4', () => {
    const state = tracker.updateFromMoves(['e4']);
    expect(state.fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(state.turn).toBe('b');
    expect(state.moveCount).toBe(1);
    expect(state.lastMove?.san).toBe('e4');
  });

  it('should correctly track Castling rights when Kingside castle is played', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O
    const state = tracker.updateFromMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
    expect(state.turn).toBe('b');
    // White castled kingside, so White can no longer castle, Black still has 'kq'
    expect(state.castlingRights).toBe('kq');
    expect(state.moves.length).toBe(7);
  });

  it('should correctly handle Scholar\'s Mate (Checkmate)', () => {
    // 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#
    const state = tracker.updateFromMoves(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    expect(state.isCheck).toBe(true);
    expect(state.isCheckmate).toBe(true);
    expect(state.isGameOver).toBe(true);
    expect(state.turn).toBe('b');
  });

  it('should correctly track en-passant target square and capture', () => {
    // 1. e4 d5 2. e5 f5 -> en-passant target is f6
    const stateBeforeCapture = tracker.updateFromMoves(['e4', 'd5', 'e5', 'f5']);
    expect(stateBeforeCapture.turn).toBe('w');
    expect(stateBeforeCapture.enPassantSquare).toBe('f6');

    // 3. exf6 (en-passant capture)
    const stateAfterCapture = tracker.updateFromMoves(['e4', 'd5', 'e5', 'f5', 'exf6']);
    expect(stateAfterCapture.turn).toBe('b');
    expect(stateAfterCapture.moves.length).toBe(5);
    expect(stateAfterCapture.lastMove?.san).toBe('exf6');
  });

  it('should correctly handle pawn promotion', () => {
    // Custom sequence leading to promotion
    const state = tracker.updateFromMoves([
      'e4', 'd5', 'exd5', 'Nf6', 'd4', 'Nxd5', 'c4', 'Nb6', 'c5', 'Nd5',
      'Bc4', 'c6', 'Nc3', 'Bf5', 'Qb3', 'Qd7', 'Nxd5', 'cxd5', 'Bxd5', 'Nc6',
      'Bxf7+', 'Kd8', 'Nf3', 'e6', 'Bh5', 'g6', 'Bg5+', 'Be7', 'Bxe7+', 'Kxe7',
      'd5', 'exd5', 'O-O', 'gxh5', 'Rfe1+', 'Kf8', 'Rad1', 'Rd8', 'Qc3', 'd4',
      'Qc4', 'Qd5', 'Qb5', 'Rd7', 'b4', 'Rg8', 'Nh4', 'Bh3', 'g3', 'Bg4',
      'Rd2', 'Re7', 'Rxe7', 'Kxe7', 'Qxb7+', 'Bd7', 'b5', 'Rb8', 'Qa6', 'Qxc5',
      'bxc6', 'Rb1+', 'Kg2', 'Bxc6+', 'Nf3', 'Qc3', 'Qe2+', 'Kd8', 'Rd3', 'Qc4',
      'h3', 'Rb2', 'Qxb2', 'Qxd3', 'Qb8+', 'Ke7', 'Qxa7+', 'Ke6', 'Qxh7', 'Qxf3+',
      'Kf1', 'Qd1#'
    ]);
    expect(state.isCheckmate).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Position resolution invariants                                             */
/* -------------------------------------------------------------------------- */

describe('position resolution invariants', () => {
  /** A real Sicilian line. Ten plies is five full moves, so White is to move. */
  const MIDGAME = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
  const midgameState = new FENTracker().updateFromMoves(MIDGAME);
  const midgameLayout = layoutOf(midgameState.fen);

  it('treats a complete move list as authoritative', () => {
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [...MIDGAME, 'Nf3'],
      domLayout: '',
      orientation: 'w',
      now: 1
    });

    expect(state.sources).toBe('move-list');
    expect(state.isComplete).toBe(true);
    expect(state.moveCount).toBe(11);
  });

  it('never reverts to the starting position when the move list is unreadable', () => {
    // This is the exact failure that produced advice during the opponent's turn:
    // an unreadable move list used to be reported as "the start position,
    // White to move".
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [],
      domLayout: midgameLayout,
      orientation: 'w',
      now: 2
    });

    expect(state.sources).toBe('carried-over');
    expect(state.fen).toBe(midgameState.fen);
    expect(state.turn).toBe('w');
    expect(state.moveCount).toBe(MIDGAME.length);
  });

  it('keeps the correct side to move even when the board cannot be read', () => {
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [],
      domLayout: '',
      orientation: 'b',
      now: 3
    });

    // The display orientation is 'b' here, yet the tracked side to move must
    // still come from the verified move list, not from how the board looks.
    expect(state.turn).toBe('w');
    expect(state.sources).toBe('carried-over');
  });

  it('refuses to regress to a shorter replay of the same board', () => {
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: MIDGAME.slice(0, 8),
      domLayout: midgameLayout,
      orientation: 'w',
      now: 4
    });

    expect(state.sources).toBe('carried-over');
    expect(state.fen).toBe(midgameState.fen);
  });

  it('accepts a truncation that is still longer than before, and flags it incomplete', () => {
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [...MIDGAME, 'Nf3', 'e5', 'garbage'],
      domLayout: 'r1bqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R',
      orientation: 'w',
      now: 5
    });

    expect(state.sources).toBe('move-list');
    expect(state.isComplete).toBe(false);
    expect(state.moveCount).toBe(12);
  });

  it('recognises a genuine new game and clears the replay watermark', () => {
    const { state, bestMoveCount } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [],
      domLayout: STANDARD_START_LAYOUT,
      orientation: 'w',
      now: 6
    });

    expect(state.sources).toBe('start');
    expect(state.moveCount).toBe(0);
    expect(state.turn).toBe('w');
    expect(bestMoveCount).toBe(0);
  });

  it('rebuilds from the pieces with derived castling rights and the turn advanced one ply', () => {
    const layout = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R';
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [],
      domLayout: layout,
      orientation: 'w',
      now: 7
    });

    expect(state.sources).toBe('dom-fallback');
    // Castling rights are read from the board instead of being erased.
    expect(state.castlingRights).toBe('KQkq');
    // White was to move, so after one more ply it is Black's turn.
    expect(state.turn).toBe('b');
  });

  it('keeps the last good position when the piece layout is nonsense', () => {
    const { state } = resolveBoardState({
      previous: midgameState,
      previousBestMoveCount: MIDGAME.length,
      parsedMoves: [],
      domLayout: '9/8/8/8/8/8/8/8',
      orientation: 'w',
      now: 8
    });

    expect(state.sources).toBe('carried-over');
    expect(state.fen).toBe(midgameState.fen);
  });
});

describe('layout and castling helpers', () => {
  it('rejects malformed layouts', () => {
    expect(validateLayout('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP')).toBe(false);
    expect(validateLayout('8/8/8/8/8/8/8/8')).toBe(false);
    expect(validateLayout('9/8/8/8/8/8/8/8')).toBe(false);
    expect(validateLayout('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')).toBe(true);
  });

  it('derives castling rights from the pieces on the board', () => {
    expect(deriveCastlingRights('r3k2r/8/8/8/8/8/8/R3K2R', null)).toBe('KQkq');
    // White has lost the queenside rook, so the Q right is gone.
    expect(deriveCastlingRights('r3k2r/8/8/8/8/8/8/4K2R', null)).toBe('Kkq');
    // Nothing on its home square.
    expect(deriveCastlingRights('4k3/8/8/8/8/8/8/4K3', null)).toBe('-');
    // The home squares are occupied, but we already knew the right was lost.
    expect(deriveCastlingRights('r3k2r/8/8/8/8/8/8/R3K2R', 'kq')).toBe('kq');
  });

  it('stops replaying at the first move that will not apply', () => {
    const outcome = replayMoves(['e4', 'e5', 'NotAMove', 'Nc6']);

    expect(outcome.appliedCount).toBe(2);
    expect(outcome.requestedCount).toBe(4);
    expect(outcome.complete).toBe(false);
    expect(outcome.chess.turn()).toBe('w');
  });
});
