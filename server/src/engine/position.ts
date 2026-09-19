import {
  BISHOP,
  BISHOP_OFFSETS,
  BLACK,
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  Color,
  EMPTY,
  KING,
  KING_OFFSETS,
  KNIGHT,
  KNIGHT_OFFSETS,
  LETTER_PIECE,
  PROMO_NONE,
  PAWN,
  PIECE_LETTER,
  QUEEN,
  ROOK,
  ROOK_OFFSETS,
  WHITE,
  fileOf,
  isCastle,
  isDoublePush,
  isEnPassant,
  makePiece,
  moveCaptured,
  moveFrom,
  movePromotion,
  moveTo,
  onBoard,
  opponent,
  pieceColor,
  pieceType,
  promotionPieceType,
  rankOf,
  squareName,
  squareOf
} from './constants.js';
import {
  Z_CASTLE_HI,
  Z_CASTLE_LO,
  Z_EP_HI,
  Z_EP_LO,
  Z_PIECE_HI,
  Z_PIECE_LO,
  Z_SIDE_HI,
  Z_SIDE_LO
} from './zobrist.js';

interface UndoRecord {
  move: number;
  captured: number;
  capturedSquare: number;
  castling: number;
  epSquare: number;
  halfmove: number;
  hashLo: number;
  hashHi: number;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Castling rights that survive a move that starts on (or lands on) a square.
 * `15` keeps everything; moving the king or a rook off its home square, or
 * capturing a rook on its home square, clears just the affected right.
 */
const CASTLING_RIGHTS_MASK: number[] = (() => {
  const mask = new Array<number>(128).fill(15);
  mask[squareOf(4, 0)] = 15 & ~(CASTLE_WK | CASTLE_WQ); // e1
  mask[squareOf(0, 0)] = 15 & ~CASTLE_WQ; // a1
  mask[squareOf(7, 0)] = 15 & ~CASTLE_WK; // h1
  mask[squareOf(4, 7)] = 15 & ~(CASTLE_BK | CASTLE_BQ); // e8
  mask[squareOf(0, 7)] = 15 & ~CASTLE_BQ; // a8
  mask[squareOf(7, 7)] = 15 & ~CASTLE_BK; // h8
  return mask;
})();

/**
 * A self-contained chess position with make/unmake, legal move generation,
 * attack detection and incremental dual Zobrist hashing.
 *
 * The engine does all of its tree work here: `chess.js` generates only about
 * 8.5k nodes/second, which is far too slow to be a search backbone, so it is
 * used only at the edge of the system to render SAN for the UI.
 */
export class Position {
  public board: Int8Array = new Int8Array(128);
  public turn: Color = WHITE;
  public castling = 0;
  public epSquare = -1;
  public halfmove = 0;
  public fullmove = 1;
  public kingSquare: [number, number] = [-1, -1];

  public hashLo = 0;
  public hashHi = 0;

  protected undoStack: UndoRecord[] = [];
  protected hashLoHistory: number[] = [];
  protected hashHiHistory: number[] = [];

  constructor(fen: string = START_FEN) {
    this.loadFen(fen);
  }

  /* ---------------------------------------------------------------------- */
  /* FEN                                                                    */
  /* ---------------------------------------------------------------------- */

  public loadFen(fen: string): void {
    this.board.fill(EMPTY);
    this.kingSquare = [-1, -1];
    this.undoStack = [];
    this.hashLoHistory = [];
    this.hashHiHistory = [];

    const parts = fen.trim().split(/\s+/);
    const rows = (parts[0] ?? '8/8/8/8/8/8/8/8').split('/');

    for (let row = 0; row < 8 && row < rows.length; row++) {
      const rank = 7 - row;
      let file = 0;
      for (const ch of rows[row]) {
        if (ch >= '1' && ch <= '8') {
          file += ch.charCodeAt(0) - 48;
          continue;
        }
        const piece = LETTER_PIECE[ch];
        if (piece === undefined) continue;
        const square = squareOf(file, rank);
        this.board[square] = piece;
        if (pieceType(piece) === KING) {
          this.kingSquare[pieceColor(piece)] = square;
        }
        file++;
      }
    }

    this.turn = parts[1] === 'b' ? BLACK : WHITE;

    this.castling = 0;
    const rights = parts[2] ?? '-';
    if (rights.includes('K')) this.castling |= CASTLE_WK;
    if (rights.includes('Q')) this.castling |= CASTLE_WQ;
    if (rights.includes('k')) this.castling |= CASTLE_BK;
    if (rights.includes('q')) this.castling |= CASTLE_BQ;

    const ep = parts[3] ?? '-';
    this.epSquare = ep && ep !== '-' ? squareOf(ep.charCodeAt(0) - 97, ep.charCodeAt(1) - 49) : -1;

    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;

    this.computeHash();
  }

  public toFen(): string {
    let placement = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this.board[squareOf(file, rank)];
        if (piece === EMPTY) {
          empty++;
        } else {
          if (empty > 0) {
            placement += empty;
            empty = 0;
          }
          placement += PIECE_LETTER[piece];
        }
      }
      if (empty > 0) placement += empty;
      if (rank > 0) placement += '/';
    }

    let rights = '';
    if (this.castling & CASTLE_WK) rights += 'K';
    if (this.castling & CASTLE_WQ) rights += 'Q';
    if (this.castling & CASTLE_BK) rights += 'k';
    if (this.castling & CASTLE_BQ) rights += 'q';
    if (!rights) rights = '-';

    const ep = this.epSquare >= 0 ? squareName(this.epSquare) : '-';
    return `${placement} ${this.turn === WHITE ? 'w' : 'b'} ${rights} ${ep} ${this.halfmove} ${this.fullmove}`;
  }

  public clone(): Position {
    return new Position(this.toFen());
  }

  protected computeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      const piece = this.board[sq];
      if (piece !== EMPTY) {
        lo ^= Z_PIECE_LO[piece][sq];
        hi ^= Z_PIECE_HI[piece][sq];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling & 15];
    hi ^= Z_CASTLE_HI[this.castling & 15];
    if (this.epSquare >= 0) {
      lo ^= Z_EP_LO[fileOf(this.epSquare)];
      hi ^= Z_EP_HI[fileOf(this.epSquare)];
    }
    if (this.turn === BLACK) {
      lo ^= Z_SIDE_LO;
      hi ^= Z_SIDE_HI;
    }
    this.hashLo = lo >>> 0;
    this.hashHi = hi >>> 0;
    this.hashLoHistory.push(this.hashLo);
    this.hashHiHistory.push(this.hashHi);
  }

  /* ---------------------------------------------------------------------- */
  /* Make / unmake                                                          */
  /* ---------------------------------------------------------------------- */

  private xorPiece(square: number, piece: number): void {
    this.hashLo ^= Z_PIECE_LO[piece][square];
    this.hashHi ^= Z_PIECE_HI[piece][square];
  }

  /**
   * Applies `move` without legality checks. Callers must only pass moves
   * produced by the generator, which already filters illegal moves.
   */
  public makeMove(move: number): void {
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = this.board[from];
    const us = this.turn;
    const them = opponent(us);
    const captured = moveCaptured(move);

    const undo: UndoRecord = {
      move,
      captured,
      capturedSquare: -1,
      castling: this.castling,
      epSquare: this.epSquare,
      halfmove: this.halfmove,
      hashLo: this.hashLo,
      hashHi: this.hashHi
    };
    this.undoStack.push(undo);

    if (captured !== EMPTY) {
      const capturedSquare = isEnPassant(move) ? (us === WHITE ? to - 16 : to + 16) : to;
      undo.capturedSquare = capturedSquare;
      this.board[capturedSquare] = EMPTY;
      this.xorPiece(capturedSquare, captured);
    }

    this.board[from] = EMPTY;
    this.xorPiece(from, piece);

    const promotion = movePromotion(move);
    const placed = promotion === PROMO_NONE ? piece : makePiece(us, promotionPieceType(promotion));
    this.board[to] = placed;
    this.xorPiece(to, placed);

    if (isCastle(move)) {
      const kingside = to > from;
      const rookFrom = kingside ? from + 3 : from - 4;
      const rookTo = kingside ? from + 1 : from - 1;
      const rook = this.board[rookFrom];
      this.board[rookFrom] = EMPTY;
      this.xorPiece(rookFrom, rook);
      this.board[rookTo] = rook;
      this.xorPiece(rookTo, rook);
    }

    if (pieceType(piece) === KING) {
      this.kingSquare[us] = to;
    }

    const nextCastling = this.castling & CASTLING_RIGHTS_MASK[from] & CASTLING_RIGHTS_MASK[to];
    if (nextCastling !== this.castling) {
      this.hashLo ^= Z_CASTLE_LO[this.castling & 15];
      this.hashHi ^= Z_CASTLE_HI[this.castling & 15];
      this.castling = nextCastling;
      this.hashLo ^= Z_CASTLE_LO[this.castling & 15];
      this.hashHi ^= Z_CASTLE_HI[this.castling & 15];
    }

    if (this.epSquare >= 0) {
      this.hashLo ^= Z_EP_LO[fileOf(this.epSquare)];
      this.hashHi ^= Z_EP_HI[fileOf(this.epSquare)];
      this.epSquare = -1;
    }
    if (isDoublePush(move)) {
      // Standard FEN only records an en-passant square when a capture is
      // actually available, and hashing a square nobody can use would only
      // create spurious transposition misses. After a double push the pawn
      // lands on `to`, so a capturing pawn must stand beside it on that rank.
      const left = to - 1;
      const right = to + 1;
      const enemyPawn = makePiece(opponent(us), PAWN);
      const capturable =
        (onBoard(left) && this.board[left] === enemyPawn) ||
        (onBoard(right) && this.board[right] === enemyPawn);
      if (capturable) {
        this.epSquare = us === WHITE ? from + 16 : from - 16;
        this.hashLo ^= Z_EP_LO[fileOf(this.epSquare)];
        this.hashHi ^= Z_EP_HI[fileOf(this.epSquare)];
      }
    }

    this.halfmove = captured !== EMPTY || pieceType(piece) === PAWN ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;

    this.turn = them;
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;

    // Keep both halves of the key unsigned so an incrementally maintained hash
    // always compares equal to one recomputed from scratch.
    this.hashLo >>>= 0;
    this.hashHi >>>= 0;

    this.hashLoHistory.push(this.hashLo);
    this.hashHiHistory.push(this.hashHi);
  }

  /** Reverses the most recent `makeMove`. */
  public undoMove(): void {
    const undo = this.undoStack.pop();
    if (!undo) return;

    if (undo.move === 0) {
      // Null move: nothing on the board changed, only the side to move did.
      this.hashLoHistory.pop();
      this.hashHiHistory.pop();
      this.hashLo = undo.hashLo;
      this.hashHi = undo.hashHi;
      this.castling = undo.castling;
      this.epSquare = undo.epSquare;
      this.halfmove = undo.halfmove;
      this.turn = opponent(this.turn);
      return;
    }

    const move = undo.move;
    const from = moveFrom(move);
    const to = moveTo(move);
    const us = opponent(this.turn);

    let moved = this.board[to];
    if (movePromotion(move) !== PROMO_NONE) {
      moved = makePiece(us, PAWN);
    }

    if (isCastle(move)) {
      const kingside = to > from;
      const rookFrom = kingside ? from + 3 : from - 4;
      const rookTo = kingside ? from + 1 : from - 1;
      const rook = this.board[rookTo];
      this.board[rookTo] = EMPTY;
      this.board[rookFrom] = rook;
    }

    this.board[to] = EMPTY;
    this.board[from] = moved;

    if (undo.captured !== EMPTY) {
      this.board[undo.capturedSquare] = undo.captured;
    }

    if (pieceType(moved) === KING) {
      this.kingSquare[us] = from;
    }

    this.hashLoHistory.pop();
    this.hashHiHistory.pop();

    this.hashLo = undo.hashLo;
    this.hashHi = undo.hashHi;
    this.castling = undo.castling;
    this.epSquare = undo.epSquare;
    this.halfmove = undo.halfmove;
    this.turn = us;
    if (us === BLACK) this.fullmove--;
  }

  public plyCount(): number {
    return this.undoStack.length;
  }

  /* ---------------------------------------------------------------------- */
  /* Attack detection                                                       */
  /* ---------------------------------------------------------------------- */

  /** True when `square` is attacked by any piece of colour `by`. */
  public isAttacked(square: number, by: Color): boolean {
    const board = this.board;

    // Pawns: a white pawn on s attacks s+15 and s+17, so `square` is attacked
    // by a white pawn sitting on square-15 or square-17.
    if (by === WHITE) {
      const a = square - 15;
      if (onBoard(a) && board[a] === makePiece(WHITE, PAWN)) return true;
      const b = square - 17;
      if (onBoard(b) && board[b] === makePiece(WHITE, PAWN)) return true;
    } else {
      const a = square + 15;
      if (onBoard(a) && board[a] === makePiece(BLACK, PAWN)) return true;
      const b = square + 17;
      if (onBoard(b) && board[b] === makePiece(BLACK, PAWN)) return true;
    }

    const knight = makePiece(by, KNIGHT);
    for (let i = 0; i < 8; i++) {
      const t = square + KNIGHT_OFFSETS[i];
      if (onBoard(t) && board[t] === knight) return true;
    }

    const king = makePiece(by, KING);
    for (let i = 0; i < 8; i++) {
      const t = square + KING_OFFSETS[i];
      if (onBoard(t) && board[t] === king) return true;
    }

    const bishop = makePiece(by, BISHOP);
    const queen = makePiece(by, QUEEN);
    for (let i = 0; i < 4; i++) {
      const dir = BISHOP_OFFSETS[i];
      let t = square + dir;
      while (onBoard(t)) {
        const piece = board[t];
        if (piece !== EMPTY) {
          if (piece === bishop || piece === queen) return true;
          break;
        }
        t += dir;
      }
    }

    const rook = makePiece(by, ROOK);
    for (let i = 0; i < 4; i++) {
      const dir = ROOK_OFFSETS[i];
      let t = square + dir;
      while (onBoard(t)) {
        const piece = board[t];
        if (piece !== EMPTY) {
          if (piece === rook || piece === queen) return true;
          break;
        }
        t += dir;
      }
    }

    return false;
  }

  /** Is `color`'s king currently in check? */
  public inCheck(color: Color = this.turn): boolean {
    const king = this.kingSquare[color];
    return king >= 0 && this.isAttacked(king, opponent(color));
  }

  /** Attacks counted for a knight/bishop/rook/queen, used by the evaluation. */
  public mobilityCount(square: number, piece: number): number {
    const type = pieceType(piece);
    const color = pieceColor(piece);
    let count = 0;

    if (type === KNIGHT) {
      for (let i = 0; i < 8; i++) {
        const t = square + KNIGHT_OFFSETS[i];
        if (!onBoard(t)) continue;
        const target = this.board[t];
        if (target === EMPTY || pieceColor(target) !== color) count++;
      }
      return count;
    }

    const dirs =
      type === BISHOP
        ? BISHOP_OFFSETS
        : type === ROOK
          ? ROOK_OFFSETS
          : [...BISHOP_OFFSETS, ...ROOK_OFFSETS];

    for (const dir of dirs) {
      let t = square + dir;
      while (onBoard(t)) {
        const target = this.board[t];
        if (target === EMPTY) {
          count++;
        } else {
          if (pieceColor(target) !== color) count++;
          break;
        }
        t += dir;
      }
    }
    return count;
  }

  /** Total repetitions of the current position, including the current one. */
  public repetitionCount(): number {
    const lo = this.hashLo;
    const hi = this.hashHi;
    const history = this.hashLoHistory;
    // A repetition needs at least four plies since the last irreversible move,
    // and never reaches back further than the halfmove clock — so bounding the
    // scan by it keeps this O(1) in practice instead of O(game length).
    const maxBack = Math.min(history.length - 1, this.halfmove);
    let count = 1;
    for (let back = 2; back <= maxBack; back += 2) {
      const i = history.length - 1 - back;
      if (i < 0) break;
      if (history[i] === lo && this.hashHiHistory[i] === hi) count++;
    }
    return count;
  }

  /** True when the side to move still owns a knight, bishop, rook or queen. */
  public hasNonPawnMaterial(color: Color = this.turn): boolean {
    for (let sq = 0; sq < 128; sq++) {
      const piece = this.board[sq];
      if (piece === EMPTY || pieceColor(piece) !== color) continue;
      const type = pieceType(piece);
      if (type !== PAWN && type !== KING) return true;
    }
    return false;
  }

  /** Passes the turn without moving, used by null-move pruning. */
  public makeNullMove(): void {
    this.undoStack.push({
      move: 0,
      captured: EMPTY,
      capturedSquare: -1,
      castling: this.castling,
      epSquare: this.epSquare,
      halfmove: this.halfmove,
      hashLo: this.hashLo,
      hashHi: this.hashHi
    });

    if (this.epSquare >= 0) {
      this.hashLo ^= Z_EP_LO[fileOf(this.epSquare)];
      this.hashHi ^= Z_EP_HI[fileOf(this.epSquare)];
      this.epSquare = -1;
    }

    this.turn = opponent(this.turn);
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
    this.hashLo >>>= 0;
    this.hashHi >>>= 0;
    this.halfmove++;
    this.hashLoHistory.push(this.hashLo);
    this.hashHiHistory.push(this.hashHi);
  }

  public isThreefoldRepetition(): boolean {
    return this.repetitionCount() >= 3;
  }

  /** True when neither side can possibly deliver mate (dead draw). */
  public isInsufficientMaterial(): boolean {
    const counts: Record<number, number> = {};
    const bishops: number[][] = [[], []];
    let total = 0;

    for (let sq = 0; sq < 128; sq++) {
      const piece = this.board[sq];
      if (piece === EMPTY) continue;
      const type = pieceType(piece);
      if (type === PAWN || type === ROOK || type === QUEEN) return false;
      counts[type] = (counts[type] ?? 0) + 1;
      if (type === BISHOP) bishops[pieceColor(piece)].push((fileOf(sq) + rankOf(sq)) & 1);
      total++;
    }

    if (total <= 3) return true; // K vs K, K+minor vs K
    if (total === 4 && counts[KNIGHT] === 2 && (counts[BISHOP] ?? 0) === 0) return true; // K+N+N vs K
    const wb = bishops[WHITE];
    const bb = bishops[BLACK];
    if (wb.length === 2 && bb.length === 0 && wb[0] === wb[1]) return true;
    if (bb.length === 2 && wb.length === 0 && bb[0] === bb[1]) return true;
    return false;
  }
}