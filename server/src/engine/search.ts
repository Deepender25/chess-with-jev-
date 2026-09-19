import {
  EMPTY,
  KING,
  PROMO_NONE,
  pieceType,
  promotionPieceType,
  moveCaptured,
  moveFrom,
  movePromotion,
  moveTo
} from './constants.js';
import { evaluate } from './evaluation.js';
import { generateLegalMoves } from './movegen.js';
import { Position } from './position.js';
import { PIECE_VALUE } from './pst.js';

/** Mate is scored as `MATE - ply`, so shorter mates always outrank longer ones. */
export const MATE_SCORE = 30000;
export const MATE_THRESHOLD = MATE_SCORE - 200;
const INFINITY = 40000;
const MAX_PLY = 64;

const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

/**
 * Root moves are searched with a window this wide below the best score so far.
 * Anything inside the window gets an exact score, which is what makes candidate
 * comparisons meaningful; anything outside it is a clearly-worse move and is
 * only reported as an upper bound.
 */
const ROOT_WINDOW = 500;

export interface RootMove {
  move: number;
  /** Centipawns from the root side's point of view. */
  score: number;
  depth: number;
  /** False when the score is an upper bound (the move failed low at the root). */
  exact: boolean;
}

export interface SearchLimits {
  maxDepth?: number;
  timeMs?: number;
  maxNodes?: number;
}

export interface SearchResult {
  bestMove: number;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  /** All root moves, best first. Scores within the root window are exact. */
  rootMoves: RootMove[];
  /** Principal variation after `bestMove`, as encoded moves. */
  pv: number[];
  /** Distance to forced mate in plies, when the score is a mate score. */
  mateInPlies?: number;
  /** False when the final iteration was cut short by the time limit. */
  completed: boolean;
}

interface TTEntry {
  keyLo: number;
  keyHi: number;
  move: number;
  score: number;
  depth: number;
  flag: number;
}

class TranspositionTable {
  private readonly mask: number;
  private readonly entries: TTEntry[];

  constructor(bits: number) {
    const size = 1 << bits;
    this.mask = size - 1;
    this.entries = new Array<TTEntry>(size);
    for (let i = 0; i < size; i++) {
      this.entries[i] = { keyLo: 0, keyHi: 0, move: 0, score: 0, depth: -1, flag: 0 };
    }
  }

  public probe(keyLo: number, keyHi: number): TTEntry | null {
    const entry = this.entries[keyLo & this.mask];
    if (entry.depth >= 0 && entry.keyLo === keyLo && entry.keyHi === keyHi) return entry;
    return null;
  }

  public store(keyLo: number, keyHi: number, move: number, score: number, depth: number, flag: number): void {
    const index = keyLo & this.mask;
    const existing = this.entries[index];
    const samePosition = existing.depth >= 0 && existing.keyLo === keyLo && existing.keyHi === keyHi;
    // Depth-preferred replacement: keep deeper information for the same
    // position, otherwise replace (the table is one entry per slot).
    if (samePosition && existing.depth > depth) {
      if (move !== 0) existing.move = move;
      return;
    }
    existing.keyLo = keyLo;
    existing.keyHi = keyHi;
    existing.move = move;
    existing.score = score;
    existing.depth = depth;
    existing.flag = flag;
  }

  public clear(): void {
    for (const entry of this.entries) {
      entry.depth = -1;
      entry.keyLo = 0;
      entry.keyHi = 0;
      entry.move = 0;
      entry.score = 0;
      entry.flag = 0;
    }
  }

  public getMove(keyLo: number, keyHi: number): number {
    const entry = this.probe(keyLo, keyHi);
    return entry ? entry.move : 0;
  }
}
/**
 * Negamax alpha-beta search with iterative deepening.
 *
 * The point of this class is that the tactical truth about a position is
 * decided here, deterministically, rather than by a language model. Everything
 * downstream (Jev's strategic re-ranking, the UI rationales) consumes the
 * verified root scores this produces.
 */
export class SearchEngine {
  private readonly tt: TranspositionTable;
  private readonly killers: Int32Array = new Int32Array(MAX_PLY * 2);
  private readonly history: Int32Array = new Int32Array(15 * 128);
  /** Per-ply ordering scores; 256 slots is above the 218-move legal maximum. */
  private readonly moveScores: Int32Array = new Int32Array(MAX_PLY * 256);

  private nodes = 0;
  private startTime = 0;
  private timeLimitMs = 0;
  private maxNodes = Number.POSITIVE_INFINITY;
  private stop = false;

  constructor(ttBits = 18) {
    this.tt = new TranspositionTable(ttBits);
  }

  public clearTable(): void {
    this.tt.clear();
  }

  /**
   * Searches `pos` and returns every root move with its score. Root moves are
   * searched with a window wide enough to keep the ordering of all plausible
   * candidates exact, which is what lets the brain compare a model's choice
   * against the engine's choice with real numbers.
   */
  public search(pos: Position, limits: SearchLimits = {}): SearchResult {
    const maxDepth = Math.min(limits.maxDepth ?? MAX_PLY - 2, MAX_PLY - 2);
    this.timeLimitMs = limits.timeMs ?? 0;
    this.maxNodes = limits.maxNodes ?? Number.POSITIVE_INFINITY;
    this.nodes = 0;
    this.stop = false;
    this.startTime = Date.now();
    this.killers.fill(0);
    this.history.fill(0);

    let ordered = generateLegalMoves(pos);
    if (ordered.length === 0) {
      throw new Error('SearchEngine.search called on a position with no legal moves');
    }

    let bestMove = ordered[0];
    let bestScore = -INFINITY;
    let rootMoves: RootMove[] = ordered.map((move) => ({ move, score: -INFINITY, depth: 0, exact: false }));
    let completedDepth = 0;
    let completed = false;

    const runIteration = (depth: number, enforceTime: boolean): boolean => {
      const scored: RootMove[] = [];
      let alpha = -INFINITY;
      let aborted = false;

      for (let i = 0; i < ordered.length; i++) {
        const move = ordered[i];
        // Every root move is searched with a window `ROOT_WINDOW` centipawns
        // below the best score so far. That keeps the ordering of every
        // plausible candidate exact (which is what the brain compares a model's
        // choice against) while still pruning lines that are already lost.
        const windowAlpha = alpha === -INFINITY ? -INFINITY : alpha - ROOT_WINDOW;
        pos.makeMove(move);
        const score = -this.negamax(pos, depth - 1, -INFINITY, -windowAlpha, 1);
        pos.undoMove();

        if (this.stop && enforceTime) {
          aborted = true;
          break;
        }
        scored.push({ move, score, depth, exact: score > windowAlpha });
        if (score > alpha) alpha = score;
      }

      if (scored.length === 0) return false;

      scored.sort((a, b) => b.score - a.score);
      rootMoves = scored;
      bestMove = scored[0].move;
      bestScore = scored[0].score;
      ordered = scored.map((entry) => entry.move);
      completedDepth = depth;
      completed = !aborted;
      return !aborted;
    };

    // Depth 1 always completes: it guarantees a legal, sane answer even when
    // the caller's time budget is tiny.
    const savedTimeLimit = this.timeLimitMs;
    this.timeLimitMs = 0;
    runIteration(1, false);
    this.timeLimitMs = savedTimeLimit;

    for (let depth = 2; depth <= maxDepth; depth++) {
      if (this.timeLimitMs > 0 && this.elapsed() >= this.timeLimitMs * 0.55) break;
      if (this.nodes >= this.maxNodes) break;
      if (Math.abs(bestScore) >= MATE_THRESHOLD) break;

      const finished = runIteration(depth, true);
      if (!finished) break;
      if (Math.abs(bestScore) >= MATE_THRESHOLD) break;
    }

    pos.makeMove(bestMove);
    // The principal variation starts with the root move, so it can be rendered
    // against the root FEN and read as a line a human would recognise.
    const pv = [bestMove, ...this.extractPv(pos, completedDepth + 3)];
    pos.undoMove();

    const mateInPlies =
      Math.abs(bestScore) >= MATE_THRESHOLD ? MATE_SCORE - Math.abs(bestScore) : undefined;

    return {
      bestMove,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      timeMs: this.elapsed(),
      rootMoves,
      pv,
      mateInPlies,
      completed
    };
  }

  /**
   * Walks transposition-table moves to recover the principal variation.
   *
   * A table this size is overwritten constantly during a deep search, so the
   * first move is re-derived with a small bounded search when the entry has been
   * evicted. Without that the PV can come back empty, and the PV is exactly the
   * evidence the model reasons over.
   */
  public extractPv(pos: Position, maxPlies: number): number[] {
    const pv: number[] = [];
    let made = 0;

    for (let i = 0; i < maxPlies; i++) {
      const legal = generateLegalMoves(pos);
      if (legal.length === 0) break;

      let move = this.tt.getMove(pos.hashLo, pos.hashHi);
      if (move === 0 || !legal.includes(move)) {
        if (i > 0) break;
        move = this.pvFallbackBestMove(pos, legal, 3);
        if (move === 0 || !legal.includes(move)) break;
      }

      pv.push(move);
      pos.makeMove(move);
      made++;
    }

    for (let i = 0; i < made; i++) pos.undoMove();
    return pv;
  }

  /**
   * Small bounded search used only to fill a gap in the principal variation. It
   * restores every counter it touches so it cannot disturb the real search.
   */
  private pvFallbackBestMove(pos: Position, moves: number[], depth: number): number {
    const savedNodes = this.nodes;
    const savedTimeLimit = this.timeLimitMs;
    const savedMaxNodes = this.maxNodes;
    const savedStop = this.stop;

    this.timeLimitMs = 0;
    this.maxNodes = 40000;
    this.stop = false;

    let best = moves[0];
    let bestScore = -INFINITY;

    for (const move of moves) {
      pos.makeMove(move);
      const score = -this.negamax(pos, depth - 1, -INFINITY, INFINITY, 2);
      pos.undoMove();
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
      if (this.nodes >= this.maxNodes) break;
    }

    this.nodes = savedNodes;
    this.timeLimitMs = savedTimeLimit;
    this.maxNodes = savedMaxNodes;
    this.stop = savedStop;
    return best;
  }

  public getNodeCount(): number {
    return this.nodes;
  }

  private elapsed(): number {
    return Date.now() - this.startTime;
  }

  /* ---------------------------------------------------------------------- */
  /* Move ordering                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Orders moves into `this.moveScores[ply * 256 ..]`: the transposition move
   * first, then good captures by MVV-LVA, then promotions, killers and finally
   * the history heuristic.
   */
  private scoreMoves(pos: Position, moves: number[], ply: number, ttMove: number): void {
    const base = ply * 256;
    const killer1 = this.killers[ply * 2];
    const killer2 = this.killers[ply * 2 + 1];

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (move === ttMove) {
        this.moveScores[base + i] = 1 << 24;
        continue;
      }

      const captured = moveCaptured(move);
      if (captured !== EMPTY) {
        const victim = PIECE_VALUE[pieceType(captured)];
        const attacker = PIECE_VALUE[pieceType(pos.board[moveFrom(move)])];
        this.moveScores[base + i] = (1 << 20) + victim * 16 - attacker;
        continue;
      }

      const promotion = movePromotion(move);
      if (promotion !== PROMO_NONE) {
        this.moveScores[base + i] = (1 << 19) + PIECE_VALUE[promotionPieceType(promotion)];
        continue;
      }

      if (move === killer1 || move === killer2) {
        this.moveScores[base + i] = 1 << 18;
        continue;
      }

      const piece = pos.board[moveFrom(move)];
      this.moveScores[base + i] = this.history[piece * 128 + moveTo(move)];
    }
  }

  /** Partial selection sort helper: swaps the best remaining move into `i`. */
  private pickBestMove(moves: number[], ply: number, i: number): void {
    const base = ply * 256;
    let bestIndex = i;
    for (let j = i + 1; j < moves.length; j++) {
      if (this.moveScores[base + j] > this.moveScores[base + bestIndex]) bestIndex = j;
    }
    if (bestIndex === i) return;
    const move = moves[i];
    moves[i] = moves[bestIndex];
    moves[bestIndex] = move;
    const score = this.moveScores[base + i];
    this.moveScores[base + i] = this.moveScores[base + bestIndex];
    this.moveScores[base + bestIndex] = score;
  }

  private recordCutoff(pos: Position, ply: number, move: number, depth: number): void {
    if (moveCaptured(move) !== EMPTY || movePromotion(move) !== PROMO_NONE) return;
    const slot = ply * 2;
    if (this.killers[slot] !== move) {
      this.killers[slot + 1] = this.killers[slot];
      this.killers[slot] = move;
    }
    const piece = pos.board[moveFrom(move)];
    const index = piece * 128 + moveTo(move);
    this.history[index] = Math.min(this.history[index] + depth * depth, 100000);
  }

  /* ---------------------------------------------------------------------- */
  /* Search                                                                 */
  /* ---------------------------------------------------------------------- */

  private checkLimits(): void {
    if ((this.nodes & 1023) !== 0) return;
    if (this.timeLimitMs > 0 && this.elapsed() >= this.timeLimitMs) {
      this.stop = true;
      return;
    }
    if (this.nodes >= this.maxNodes) {
      this.stop = true;
    }
  }

  private negamax(pos: Position, depth: number, alpha: number, beta: number, ply: number): number {
    this.nodes++;
    if ((this.nodes & 1023) === 0) this.checkLimits();
    if (this.stop) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    const inCheck = pos.inCheck();
    // Check extension: never let the search sit in a position where the side to
    // move is in check and about to be mated.
    if (inCheck && depth > 0 && ply < 40) depth++;
    if (depth <= 0) return this.quiescence(pos, alpha, beta, ply, 0);

    if (pos.halfmove >= 100 || pos.isInsufficientMaterial() || pos.repetitionCount() >= 2) return 0;

    const keyLo = pos.hashLo;
    const keyHi = pos.hashHi;
    const entry = this.tt.probe(keyLo, keyHi);
    let ttMove = 0;
    if (entry) {
      ttMove = entry.move;
      if (entry.depth >= depth) {
        let score = entry.score;
        if (score >= MATE_THRESHOLD) score -= ply;
        else if (score <= -MATE_THRESHOLD) score += ply;
        if (entry.flag === TT_EXACT) return score;
        if (entry.flag === TT_LOWER && score >= beta) return score;
        if (entry.flag === TT_UPPER && score <= alpha) return score;
      }
    }

    // Null-move pruning: if handing the opponent a free move still leaves them
    // worse, this branch is comfortably winning and can be cut immediately.
    if (!inCheck && depth >= 3 && ply > 0 && beta < MATE_THRESHOLD && pos.hasNonPawnMaterial()) {
      pos.makeNullMove();
      const score = -this.negamax(pos, depth - 3, -beta, -beta + 1, ply + 1);
      pos.undoMove();
      if (this.stop) return 0;
      if (score >= beta) return beta;
    }

    const moves = generateLegalMoves(pos);
    if (moves.length === 0) {
      return inCheck ? -MATE_SCORE + ply : 0;
    }

    this.scoreMoves(pos, moves, ply, ttMove);

    let bestScore = -INFINITY;
    let bestMove = 0;
    let raisedAlpha = false;

    for (let i = 0; i < moves.length; i++) {
      this.pickBestMove(moves, ply, i);
      const move = moves[i];

      const quiet = moveCaptured(move) === EMPTY && movePromotion(move) === PROMO_NONE;
      pos.makeMove(move);

      let score: number;
      if (depth >= 3 && !inCheck && quiet && i > 3) {
        // Late move reduction: late quiet moves are unlikely to be best, so
        // scout them with a shallower null-window search first.
        const reduction = i > 8 ? 2 : 1;
        score = -this.negamax(pos, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1);
        if (score > alpha) {
          score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1);
        }
      } else {
        score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1);
      }

      pos.undoMove();
      if (this.stop) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          raisedAlpha = true;
        }
      }

      if (alpha >= beta) {
        this.recordCutoff(pos, ply, move, depth);
        break;
      }
    }

    let storeScore = bestScore;
    if (storeScore >= MATE_THRESHOLD) storeScore += ply;
    else if (storeScore <= -MATE_THRESHOLD) storeScore -= ply;
    const flag = bestScore >= beta ? TT_LOWER : raisedAlpha ? TT_EXACT : TT_UPPER;
    this.tt.store(keyLo, keyHi, bestMove, storeScore, depth, flag);

    return bestScore;
  }

  /**
   * Quiescence search. At leaf nodes only captures and promotions are
   * considered, so the engine never evaluates a position in the middle of a
   * trade. When the side to move is in check every evasion is generated, which
   * is what lets the search find forced mates instead of blundering into them.
   */
  private quiescence(pos: Position, alpha: number, beta: number, ply: number, qdepth: number): number {
    this.nodes++;
    if ((this.nodes & 1023) === 0) this.checkLimits();
    if (this.stop) return 0;
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    const inCheck = pos.inCheck();
    let bestScore = -INFINITY;

    if (!inCheck) {
      bestScore = evaluate(pos);
      if (bestScore >= beta) return bestScore;
      if (bestScore > alpha) alpha = bestScore;
    }

    const maxDepth = inCheck ? 8 : 4;
    if (qdepth >= maxDepth) return inCheck ? Math.max(bestScore, evaluate(pos)) : bestScore;

    const moves = generateLegalMoves(pos, !inCheck);
    if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : bestScore;

    this.scoreMoves(pos, moves, ply, 0);

    for (let i = 0; i < moves.length; i++) {
      this.pickBestMove(moves, ply, i);
      const move = moves[i];
      const captured = moveCaptured(move);

      // Delta pruning: a capture that cannot possibly lift the score back to
      // alpha, even with a generous follow-up bonus, is not worth searching.
      if (!inCheck && captured !== EMPTY && movePromotion(move) === PROMO_NONE) {
        if (bestScore + PIECE_VALUE[pieceType(captured)] + 200 < alpha) continue;
      }

      pos.makeMove(move);
      const score = -this.quiescence(pos, -beta, -alpha, ply + 1, qdepth + 1);
      pos.undoMove();
      if (this.stop) return 0;

      if (score > bestScore) {
        bestScore = score;
        if (score > alpha) alpha = score;
      }
      if (alpha >= beta) break;
    }

    if (inCheck && bestScore === -INFINITY) return -MATE_SCORE + ply;
    return bestScore;
  }
}