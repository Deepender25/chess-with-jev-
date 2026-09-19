import { Chess } from 'chess.js';
import { BoardState, Color, PositionSource } from '../types';
import { scanDOMBoard } from './domScanner';
import { parseMoveList } from './moveListParser';

/**
 * Board state tracking.
 *
 * The whole file is built around one rule: **a position we already know must
 * never be replaced by a worse-informed guess.** The previous implementation
 * treated "the on-page move list could not be parsed" as "the game is at the
 * starting position", which reported `White to move` mid-game and made the
 * extension suggest a first move while the opponent was thinking.
 *
 * Everything decision-shaped lives in `resolveBoardState`, a pure function of
 * (previous state, parsed moves, DOM layout), so the invariants below are
 * covered directly by unit tests without needing a browser:
 *
 *   1. A complete move-list replay is authoritative.
 *   2. A partial replay is accepted only when it does not *regress* behind what
 *      we already knew, and it is flagged incomplete.
 *   3. An unusable move list never resets a game in progress to the start
 *      position. If the piece layout is unchanged, the last good state is reused
 *      verbatim (same FEN), so nothing downstream re-fires.
 *   4. When the layout really changed but the move list is unusable, the piece
 *      layout is accepted with castling rights *derived from the board* (never
 *      hardcoded away) and the turn advanced exactly one ply.
 *   5. Anything that cannot be verified is marked `isComplete: false`, and the
 *      caller withholds advice instead of guessing.
 */

export const STANDARD_START_LAYOUT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

/* -------------------------------------------------------------------------- */
/* Move-list replay                                                           */
/* -------------------------------------------------------------------------- */

export interface ReplayOutcome {
  chess: Chess;
  /** Moves that applied successfully. */
  appliedCount: number;
  /** Moves the parser handed us. */
  requestedCount: number;
  /** True only when every requested move applied cleanly. */
  complete: boolean;
  successfulMoves: string[];
  lastMove?: { from?: string; to?: string; san?: string };
}

/**
 * Normalises the notation variations that show up in a live page before they are
 * handed to chess.js: castling written with zeroes, an "en passant" suffix,
 * annotation marks, and the multiplication sign used for captures.
 */
export function normalizeMoveToken(token: string): string {
  let text = token.trim();
  // 0-0-0 must be rewritten before 0-0, or the short form would match first.
  text = text.replace(/0-0-0/gi, 'O-O-O').replace(/0-0/gi, 'O-O');
  text = text.replace(/[\u00d7x*]/g, 'x');
  text = text.replace(/\s*e\.?\s*p\.?\s*$/i, '');
  text = text.replace(/[!?]+$/g, '');
  return text;
}

function applySequence(moves: string[]): ReplayOutcome {
  const chess = new Chess();
  const successfulMoves: string[] = [];
  let lastMove: { from?: string; to?: string; san?: string } | undefined;
  let appliedCount = 0;

  for (const raw of moves) {
    let result: { from: string; to: string; san: string } | null = null;

    for (const candidate of [raw, normalizeMoveToken(raw)]) {
      try {
        const played = chess.move(candidate);
        result = played ? { from: played.from, to: played.to, san: played.san } : null;
      } catch {
        result = null;
      }
      if (result) break;
    }

    if (!result) break;
    successfulMoves.push(result.san);
    lastMove = result;
    appliedCount++;
  }

  return {
    chess,
    appliedCount,
    requestedCount: moves.length,
    complete: appliedCount === moves.length,
    successfulMoves,
    lastMove
  };
}

/**
 * Replays a SAN list from the standard starting position.
 *
 * Replay stops at the first move that will not apply, which on its own is a trap:
 * one stray token anywhere in the list would stall the replay for the rest of the
 * game and flag every position as incomplete. So if the direct pass does not get
 * through, a second pass drops exactly one token and keeps the longest successful
 * replay. That recovers the overwhelmingly common case — a trailing UI element,
 * such as the move the page is mid-way through rendering — without guessing at
 * the position.
 */
export function replayMoves(moves: string[]): ReplayOutcome {
  const direct = applySequence(moves);
  if (direct.complete || moves.length === 0) return direct;

  let best = direct;
  for (let skip = 0; skip < moves.length; skip++) {
    const candidate = applySequence([...moves.slice(0, skip), ...moves.slice(skip + 1)]);
    if (candidate.appliedCount > best.appliedCount) best = candidate;
    if (best.complete) break;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                             */
/* -------------------------------------------------------------------------- */

/** The piece-placement field of a FEN: everything before the first space. */
export function layoutOf(fen: string): string {
  return fen.split(' ')[0] ?? '';
}

function flip(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/** Square -> piece letter, for a piece-placement field. */
export function layoutSquares(layout: string): Map<string, string> {
  const map = new Map<string, string>();
  const ranks = layout.split('/');
  for (let row = 0; row < ranks.length && row < 8; row++) {
    const rank = 8 - row;
    let file = 0;
    for (const ch of ranks[row]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      if (file < 8) {
        map.set(`${String.fromCharCode(97 + file)}${rank}`, ch);
      }
      file++;
    }
  }
  return map;
}
/**
 * Rejects obvious nonsense so a half-rendered board can never become a FEN:
 * wrong rank count, missing or duplicated kings, pawns on the first or last
 * rank, an impossible pawn count, or a rank that does not describe eight files.
 */
export function validateLayout(layout: string): boolean {
  if (!layout) return false;
  const ranks = layout.split('/');
  if (ranks.length !== 8) return false;

  let whiteKings = 0;
  let blackKings = 0;
  let whitePawns = 0;
  let blackPawns = 0;

  for (let row = 0; row < 8; row++) {
    const rank = 8 - row;
    let file = 0;
    for (const ch of ranks[row]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      if (ch === 'K') whiteKings++;
      else if (ch === 'k') blackKings++;
      else if (ch === 'P') {
        whitePawns++;
        if (rank === 1 || rank === 8) return false;
      } else if (ch === 'p') {
        blackPawns++;
        if (rank === 1 || rank === 8) return false;
      } else if (!'QRBNqrbn'.includes(ch)) {
        return false;
      }
      file++;
    }
    if (file !== 8) return false;
  }

  return whiteKings === 1 && blackKings === 1 && whitePawns <= 8 && blackPawns <= 8;
}

/**
 * Castling rights consistent with the pieces actually on the board.
 *
 * Castling needs the king and the matching rook on their home squares, so
 * inferring rights from the layout is always sound in one direction. When a
 * previous, move-list-derived value exists it is intersected in, which also
 * catches the "the king walked away and came back" case.
 *
 * `previousRights === null` means "no earlier information", so the home-square
 * test is used on its own.
 */
export function deriveCastlingRights(layout: string, previousRights: string | null): string {
  const squares = layoutSquares(layout);
  const rights: string[] = [];

  const candidates: Array<{ right: string; kingSquare: string; rookSquare: string }> = [
    { right: 'K', kingSquare: 'e1', rookSquare: 'h1' },
    { right: 'Q', kingSquare: 'e1', rookSquare: 'a1' },
    { right: 'k', kingSquare: 'e8', rookSquare: 'h8' },
    { right: 'q', kingSquare: 'e8', rookSquare: 'a8' }
  ];

  for (const { right, kingSquare, rookSquare } of candidates) {
    const isWhite = right === right.toUpperCase();
    if (squares.get(kingSquare) !== (isWhite ? 'K' : 'k')) continue;
    if (squares.get(rookSquare) !== (isWhite ? 'R' : 'r')) continue;
    if (previousRights !== null && !previousRights.includes(right)) continue;
    rights.push(right);
  }

  return rights.join('') || '-';
}

/* -------------------------------------------------------------------------- */
/* State construction                                                         */
/* -------------------------------------------------------------------------- */

function stateFromChess(
  chess: Chess,
  replay: ReplayOutcome,
  source: PositionSource,
  isComplete: boolean,
  orientation: Color,
  now: number
): BoardState {
  const fen = chess.fen();
  const tokens = fen.split(' ');
  const turn = chess.turn();

  return {
    fen,
    turn,
    turnDescription: turn === 'w' ? 'White to move' : 'Black to move',
    moveCount: replay.appliedCount,
    fullMoveNumber: parseInt(tokens[5] || '1', 10) || 1,
    halfMoveClock: parseInt(tokens[4] || '0', 10) || 0,
    castlingRights: tokens[2] || '-',
    enPassantSquare: tokens[3] || '-',
    lastMove: replay.lastMove,
    moves: replay.successfulMoves,
    isCheck: chess.isCheck(),
    isCheckmate: chess.isCheckmate(),
    isDraw: chess.isDraw(),
    isGameOver: chess.isGameOver(),
    timestamp: now,
    sources: source,
    isComplete,
    orientation
  };
}

/** The standard starting position, which is known with certainty. */
function startState(orientation: Color, now: number, isComplete: boolean): BoardState {
  const chess = new Chess();
  return stateFromChess(
    chess,
    { chess, appliedCount: 0, requestedCount: 0, complete: true, successfulMoves: [] },
    'start',
    isComplete,
    orientation,
    now
  );
}

/**
 * Reuses a position we already trust rather than downgrading it.
 *
 * The FEN and turn are copied verbatim — deliberately — so a transient DOM
 * hiccup produces an identical fingerprint and nothing downstream reacts to it.
 */
function carryOver(previous: BoardState, orientation: Color, now: number): BoardState {
  return { ...previous, orientation, sources: 'carried-over', timestamp: now };
}
/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolveInput {
  /** The last state we produced, or null on first run. */
  previous: BoardState | null;
  /** Longest move list that has ever replayed completely in this game. */
  previousBestMoveCount: number;
  /** SAN moves parsed from the page. Empty when the list is unreadable. */
  parsedMoves: string[];
  /** Piece-placement field scanned from the board, or '' when unreadable. */
  domLayout: string;
  /** Which way the board is displayed, used only as a last-resort turn hint. */
  orientation: Color;
  now: number;
}

export interface ResolveOutput {
  state: BoardState;
  bestMoveCount: number;
}

/** Decides which source of information to believe. Pure and fully testable. */
export function resolveBoardState(input: ResolveInput): ResolveOutput {
  const { previous, previousBestMoveCount, parsedMoves, domLayout, orientation, now } = input;
  const replay = replayMoves(parsedMoves);

  /* 1. A full replay. Authoritative, and the only path that advances the game —
   *    but "every move we were handed applied cleanly" is not the same as "this
   *    is the whole game". A list that is internally consistent yet *shorter*
   *    than what we already hold, on a board that has not changed, is a parse
   *    hiccup and must not rewind the position (a rewound position flips the
   *    side to move, which is the same class of bug as the original one). */
  if (replay.appliedCount > 0 && replay.complete) {
    const previousLayout = previous ? layoutOf(previous.fen) : '';
    const layoutChanged = domLayout !== '' && previous !== null && domLayout !== previousLayout;

    if (previous !== null && replay.appliedCount < previousBestMoveCount && !layoutChanged) {
      return { state: carryOver(previous, orientation, now), bestMoveCount: previousBestMoveCount };
    }

    // The watermark follows the accepted replay rather than only ever rising.
    // Every regression is caught above, so by this point a shorter list means the
    // board genuinely changed: a new game, or a take-back. Keeping the old high
    // value would leave the guard permanently tripped for the rest of the game,
    // forcing a piece scan on every tick and never rejecting anything.
    return {
      state: stateFromChess(replay.chess, replay, 'move-list', true, orientation, now),
      bestMoveCount: replay.appliedCount
    };
  }

  /* 2. A partial replay: at least one move in the list would not apply. */
  if (replay.appliedCount > 0) {
    const previousLayout = previous ? layoutOf(previous.fen) : '';
    const layoutChanged = domLayout !== '' && previous !== null && domLayout !== previousLayout;

    // Going backwards on a board that has not changed means the parse hiccuped,
    // not that the game was rewound. Keep the better-informed state.
    if (previous !== null && replay.appliedCount < previousBestMoveCount && !layoutChanged) {
      return { state: carryOver(previous, orientation, now), bestMoveCount: previousBestMoveCount };
    }

    // A truncated replay is still a real position, but it is missing a move, so
    // it is flagged and no advice will be requested for it.
    return {
      state: stateFromChess(replay.chess, replay, 'move-list', false, orientation, now),
      bestMoveCount: Math.max(previousBestMoveCount, replay.appliedCount)
    };
  }

  /* 3. The move list yielded nothing at all. */
  if (domLayout === '') {
    // The board could not be read either, so learn nothing and change nothing.
    if (previous !== null) {
      return { state: carryOver(previous, orientation, now), bestMoveCount: previousBestMoveCount };
    }
    return { state: startState(orientation, now, false), bestMoveCount: 0 };
  }

  const previousLayout = previous ? layoutOf(previous.fen) : '';

  if (domLayout === STANDARD_START_LAYOUT) {
    // Evidence of a fresh game, unless we were already sitting on the start.
    if (previous !== null && previous.moveCount > 0 && previousLayout !== STANDARD_START_LAYOUT) {
      return { state: startState(orientation, now, true), bestMoveCount: 0 };
    }
    if (previous !== null && previousLayout === STANDARD_START_LAYOUT) {
      return { state: carryOver(previous, orientation, now), bestMoveCount: previousBestMoveCount };
    }
    return { state: startState(orientation, now, true), bestMoveCount: previousBestMoveCount };
  }

  if (previous !== null && previousLayout === domLayout) {
    // The pieces have not moved, so only the move-list parse failed.
    return { state: carryOver(previous, orientation, now), bestMoveCount: previousBestMoveCount };
  }

  return buildFromDom(domLayout, previous, orientation, now);
}
/**
 * Last resort: rebuild from the piece elements. Used only when the move list is
 * unusable *and* the pieces actually changed.
 */
function buildFromDom(
  domLayout: string,
  previous: BoardState | null,
  orientation: Color,
  now: number
): ResolveOutput {
  if (!validateLayout(domLayout)) {
    if (previous !== null) {
      return { state: carryOver(previous, orientation, now), bestMoveCount: previous.moveCount };
    }
    return { state: startState(orientation, now, false), bestMoveCount: 0 };
  }

  // Exactly one ply has been played since the last good state, so the turn
  // advances by one. With no previous state there is nothing to reason from, so
  // the display orientation is the only hint available and the result is marked
  // as unverified.
  const turn: Color = previous ? flip(previous.turn) : orientation;
  const castlingRights = deriveCastlingRights(domLayout, previous ? previous.castlingRights : null);
  const fullMoveNumber = previous ? previous.fullMoveNumber + (previous.turn === 'b' ? 1 : 0) : 1;

  // The halfmove clock cannot be recovered from the pieces and only feeds the
  // fifty-move rule, so it restarts rather than claiming a draw it cannot prove.
  const fen = `${domLayout} ${turn} ${castlingRights} - 0 ${fullMoveNumber}`;

  try {
    const chess = new Chess(fen);
    return {
      state: stateFromChess(
        chess,
        {
          chess,
          appliedCount: previous ? previous.moveCount + 1 : 0,
          requestedCount: 0,
          complete: false,
          successfulMoves: previous ? previous.moves : []
        },
        'dom-fallback',
        previous ? previous.isComplete : false,
        orientation,
        now
      ),
      bestMoveCount: previous ? previous.moveCount : 0
    };
  } catch {
    if (previous !== null) {
      return { state: carryOver(previous, orientation, now), bestMoveCount: previous.moveCount };
    }
    return { state: startState(orientation, now, false), bestMoveCount: 0 };
  }
}

/* -------------------------------------------------------------------------- */
/* DOM adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which way the board is displayed. Two cheap DOM reads, so it can be called on
 * every observer tick without scanning the pieces.
 */
export function readBoardOrientation(boardEl?: HTMLElement | null): Color {
  if (!boardEl) return 'w';
  const flipped =
    boardEl.classList?.contains('flipped') || boardEl.getAttribute('orientation') === 'black';
  return flipped ? 'b' : 'w';
}

export class FENTracker {
  private chess: Chess;
  private lastKnownState: BoardState | null = null;
  /** Longest complete replay seen this game, for the regression guard. */
  private bestMoveCount = 0;

  constructor() {
    this.chess = new Chess();
  }

  /** Forgets the current game. Called when a new board appears. */
  public reset(): void {
    this.chess = new Chess();
    this.lastKnownState = null;
    this.bestMoveCount = 0;
  }

  /**
   * Replays an explicit SAN list. Used by tests and by callers that already hold
   * an authoritative move list; it deliberately does not consult a previous
   * state.
   */
  public updateFromMoves(moves: string[]): BoardState {
    const replay = replayMoves(moves);
    const state = stateFromChess(
      replay.chess,
      replay,
      moves.length === 0 ? 'start' : 'move-list',
      replay.complete,
      this.lastKnownState?.orientation ?? 'w',
      Date.now()
    );

    this.chess = new Chess(state.fen);
    this.lastKnownState = state;
    this.bestMoveCount = moves.length === 0 ? 0 : replay.appliedCount;
    return state;
  }

  /**
   * Produces the current state from a live page, delegating the judgement to
   * `resolveBoardState`.
   */
  public extractCurrentState(
    boardEl?: HTMLElement | null,
    moveListEl?: HTMLElement | null
  ): BoardState {
    const orientation = readBoardOrientation(boardEl);
    const parsedMoves = parseMoveList(moveListEl);
    const replay = replayMoves(parsedMoves);

    // Scanning the pieces is the expensive part, so it only happens when the
    // move list cannot answer on its own — or when the list came back shorter
    // than what we already hold, where the layout is needed to tell a parse
    // hiccup apart from a genuine take-back. During a normal game this never
    // runs, which is what makes clicking a piece cheap.
    const mightHaveRegressed = replay.appliedCount < this.bestMoveCount;
    const needsDomLayout = !(replay.appliedCount > 0 && replay.complete) || mightHaveRegressed;
    const domLayout = needsDomLayout ? scanDOMBoard(boardEl).piecePlacementFen : '';

    const { state, bestMoveCount } = resolveBoardState({
      previous: this.lastKnownState,
      previousBestMoveCount: this.bestMoveCount,
      parsedMoves,
      domLayout,
      orientation,
      now: Date.now()
    });

    this.bestMoveCount = bestMoveCount;
    if (state.sources !== 'carried-over') {
      this.chess = new Chess(state.fen);
    }
    this.lastKnownState = state;
    return state;
  }

  /**
   * Short description of how the last position was obtained, for the HUD. Makes
   * a stalled board diagnosable instead of just looking broken.
   */
  public describeSource(): string {
    const state = this.lastKnownState;
    if (!state) return 'no position yet';
    const quality = state.isComplete ? 'verified' : 'unverified';
    return `${state.sources}, ${quality}, ${state.moveCount} ply`;
  }

  public getLastKnownState(): BoardState | null {
    return this.lastKnownState;
  }

  public getBestMoveCount(): number {
    return this.bestMoveCount;
  }

  public getLegalMoves(): string[] {
    return this.chess.moves();
  }
}