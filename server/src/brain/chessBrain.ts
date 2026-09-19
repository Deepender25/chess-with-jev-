import { Chess } from 'chess.js';
import { Position } from '../engine/position.js';
import { SearchEngine, MATE_THRESHOLD, type SearchResult } from '../engine/search.js';
import { generateLegalMoves } from '../engine/movegen.js';
import {
  EMPTY,
  PIECE_LETTER,
  moveFrom,
  moveTo,
  pieceType,
  squareName
} from '../engine/constants.js';
import { moveToSan, renderPv } from './notation.js';
import { OpeningBook } from './openingBook.js';
import { analyzePosition, type PositionFacts } from './positionFacts.js';
import {
  askJev,
  buildCandidates,
  evalInPawns,
  STRATEGIC_PRIORITIES,
  type CandidateMove,
  type StrategyInput,
  type StrategyOutput
} from './jevStrategy.js';
import { TypeSafeClient } from './typesafeClient.js';
import { JevCircuitBreaker } from './circuitBreaker.js';

/**
 * The brain.
 *
 * Division of labour, which is the whole point of this module:
 *
 *   System 2 (deterministic):  `SearchEngine` decides what is *true* — which
 *                              moves are legal, which are safe, what the
 *                              evaluation is, and whether there is a forced
 *                              mate. It also picks the shortlist.
 *   System 1 (Jev):            decides *which* of the engine-verified shortlist
 *                              fits the strategic plan. One batched request.
 *   Code:                      owns the decision. The fusion, the trust window,
 *                              the confidence gate and the blunder ceiling below
 *                              are the only place a move is actually selected.
 *
 * Nothing about a specific position is hardcoded: the guardrails are general
 * rules about how much authority the model gets, not canned move corrections.
 */

export interface BrainOptions {
  /** Use the deterministic opening book while still in theory. */
  useBook?: boolean;
  /** Send the shortlist to Jev. Defaults to true when an API key is available. */
  useJev?: boolean;
  /**
   * Milliseconds allowed for one Jev request before it is aborted and the
   * engine answer used alone. Kept small on purpose: a slow upstream must
   * never push the total decision time past what the extension watchdog will
   * wait for.
   */
  jevTimeoutMs?: number;
  apiKey?: string;
  model?: string;
  /** Milliseconds allowed for the engine search at the root. */
  searchTimeMs?: number;
  /** Hard cap on search depth, regardless of the time budget. */
  searchMaxDepth?: number;
  /** How many engine-verified moves to offer Jev. */
  candidateCount?: number;
  /**
   * Base latitude, in centipawns, that Jev's pick may give up against the
   * engine's best move. The effective window scales with Jev's own confidence.
   */
  trustWindowCp?: number;
  /** Absolute ceiling: no move this much worse than the best is ever served. */
  maxAcceptableLossCp?: number;
  /** Below this plan confidence the model is understood to be guessing. */
  minPlanConfidence?: number;
  /** Centipawn gap at which the engine's best move is followed without Jev. */
  forcingGapCp?: number;
  /** Number of plies after which the opening book stops being consulted. */
  bookPlies?: number;
  /** Optional shared transposition table between calls (per-game caching). */
  engine?: SearchEngine;
}

export interface ResolvedBrainOptions extends Required<Omit<BrainOptions, 'engine' | 'apiKey' | 'model'>> {
  apiKey: string;
  model: string;
  engine: SearchEngine;
  book: OpeningBook;
}

export type DecisionPath =
  | 'checkmate'
  | 'only_move'
  | 'opening_book'
  | 'engine_forcing'
  | 'jev_plan'
  | 'engine_best'
  | 'game_over';

export interface BrainDecision {
  fen: string;
  sideToMove: 'w' | 'b';
  moveNumber: number;
  /** Chosen move, in the same shape the extension and dashboard already use. */
  recommendedMove: string;
  fromSquare: string;
  toSquare: string;
  decisionPath: DecisionPath;
  confidence: number;
  /** Candidate list, best first, with the served move first. */
  candidates: CandidateMove[];
  facts: PositionFacts;
  search: SearchResult;
  strategy: StrategyOutput | null;
  /** Set when the model was consulted and answered. */
  /** True when the model was actually consulted and answered. */
  jevUsed: boolean;
  latencyMs: number;
  /** Human-readable reason for the choice. */
  rationale: string;
  /** Verified principal variation in SAN, best line first. */
  pvSan: string[];
  strategicTheme: string;
  /** 0..1 evaluation from the mover's point of view. */
  positionScore: number;
  isTacticalDanger: boolean;
  isCheckmateOpportunity: boolean;
  mateInPlies?: number;
  /** Top candidates with the served move first, ready for the UI. */
  topCandidates: CandidatePayload[];
  positionEvaluationLabel: string;
  attackInitiativeProbability: number;
  counterplayRiskProbability: number;
  promotionAlert?: string;
  enemyKingExposure: string;
  threatAlert?: string;
  materialDelta: number;
  /** Explains why Jev's suggestion was not played, when that happened. */
  jevOverrideReason?: string;
  latencyBreakdown: { searchMs: number; jevMs: number };
}

const DEFAULT_OPTIONS = {
  useBook: true,
  useJev: true,
  jevTimeoutMs: 6000,
  searchTimeMs: 2200,
  searchMaxDepth: 12,
  candidateCount: 5,
  trustWindowCp: 40,
  maxAcceptableLossCp: 70,
  minPlanConfidence: 0.3,
  forcingGapCp: 120,
  bookPlies: 14
};

/** Turns an engine score into a 0..1 figure using a logistic curve. */
export function scoreToUnit(cp: number): number {
  return 1 / (1 + Math.exp(-cp / 320));
}

export function unitToLabel(score: number): string {
  if (score >= 0.78) return 'Decisively Winning';
  if (score >= 0.58) return 'Slight Advantage';
  if (score >= 0.42) return 'Equal / Balanced';
  if (score >= 0.22) return 'Slight Disadvantage';
  return 'Decisively Losing';
}

export function describeTheme(theme: string): string {
  const entry = STRATEGIC_PRIORITIES[theme];
  return entry?.what ?? 'Improve the position';
}

export { MATE_THRESHOLD, evalInPawns, moveToSan };

const SHARED_BOOK = new OpeningBook();

interface FusionOutcome {
  move: number;
  san: string;
  path: DecisionPath;
  confidence: number;
  overrideReason?: string;
}

/**
 * Chooses between Jev's plan and the engine's evaluation.
 *
 * This is the only function in the system that picks a move, and its rules are
 * general: a forced win is played, the book is followed, a clearly-best move is
 * taken, and otherwise the model may pick within a window that widens with its
 * own confidence and is capped by an absolute blunder ceiling.
 */
export function fuseDecision(
  fen: string,
  search: SearchResult,
  candidates: CandidateMove[],
  strategy: StrategyOutput | null,
  options: Pick<
    ResolvedBrainOptions,
    'trustWindowCp' | 'maxAcceptableLossCp' | 'minPlanConfidence' | 'forcingGapCp'
  >
): FusionOutcome {
  const best = search.rootMoves[0];

  /** Falls back to the engine's own best move, recording why. */
  const engineOutcome = (overrideReason?: string): FusionOutcome => {
    const san =
      moveToSan(fen, best.move) ??
      `${squareName(moveFrom(best.move))}-${squareName(moveTo(best.move))}`;
    const gap = best.score - (search.rootMoves[1]?.score ?? best.score);
    return {
      move: best.move,
      san,
      path: 'engine_best',
      confidence: clampNumber(0.35 + 0.6 * clampNumber(gap / 150, 0, 1), 0.2, 0.95),
      overrideReason
    };
  };

  if (strategy && strategy.planChoice && strategy.planChoice !== 'none_of_these') {
    const chosen = candidates.find((candidate) => candidate.san === strategy.planChoice);
    if (!chosen) {
      return engineOutcome('The model named a move that was not on the verified shortlist');
    }

    const planProbability = strategy.planProbabilities[chosen.san] ?? 0;
    const effectiveWindow = options.trustWindowCp * (0.5 + strategy.planConfidence);

    if (strategy.planConfidence < options.minPlanConfidence) {
      return engineOutcome(
        `The model was torn between its options (confidence ${(strategy.planConfidence * 100).toFixed(0)}%), so the engine move was kept`
      );
    }

    if (chosen.evalLossCp > options.maxAcceptableLossCp) {
      return engineOutcome(
        `The model's move ${chosen.san} gives up ${(chosen.evalLossCp / 100).toFixed(2)} pawns against the engine's best move, past the ${(options.maxAcceptableLossCp / 100).toFixed(2)} pawn safety ceiling`
      );
    }

    if (chosen.evalLossCp > effectiveWindow) {
      return engineOutcome(
        `The model's move ${chosen.san} is ${(chosen.evalLossCp / 100).toFixed(2)} pawns behind the engine's best, outside the ${(effectiveWindow / 100).toFixed(2)} pawn window its confidence allows`
      );
    }

    return {
      move: chosen.move,
      san: chosen.san,
      path: 'jev_plan',
      confidence: clampNumber(0.25 + 0.5 * planProbability + 0.3 * strategy.planConfidence, 0.1, 0.95)
    };
  }

  if (strategy && strategy.planChoice === 'none_of_these') {
    return engineOutcome(
      'The model rejected every verified candidate, so the engine move was kept and only its strategic read was used'
    );
  }

  return engineOutcome(undefined);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface BrainInput {
  fen: string;
  /** SAN moves played so far, oldest first, used for context only. */
  moves?: string[];
}

/**
 * Orchestrates a whole decision: search, shortlist, one Jev request, fusion,
 * then a fully assembled result carrying every field the extension, HUD and
 * dashboard already render.
 */
export class ChessBrain {
  private readonly options: ResolvedBrainOptions;
  private readonly client: TypeSafeClient | null;
  /** Opens after repeated Jev timeouts so a dead upstream costs little. */
  private readonly jevBreaker = new JevCircuitBreaker(3, 60000);

  constructor(options: BrainOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    const hasKey = apiKey.trim().length > 5;

    this.options = {
      useBook: options.useBook ?? DEFAULT_OPTIONS.useBook,
      useJev: (options.useJev ?? DEFAULT_OPTIONS.useJev) && hasKey,
      jevTimeoutMs: options.jevTimeoutMs ?? DEFAULT_OPTIONS.jevTimeoutMs,
      searchTimeMs: options.searchTimeMs ?? DEFAULT_OPTIONS.searchTimeMs,
      searchMaxDepth: options.searchMaxDepth ?? DEFAULT_OPTIONS.searchMaxDepth,
      candidateCount: options.candidateCount ?? DEFAULT_OPTIONS.candidateCount,
      trustWindowCp: options.trustWindowCp ?? DEFAULT_OPTIONS.trustWindowCp,
      maxAcceptableLossCp: options.maxAcceptableLossCp ?? DEFAULT_OPTIONS.maxAcceptableLossCp,
      minPlanConfidence: options.minPlanConfidence ?? DEFAULT_OPTIONS.minPlanConfidence,
      forcingGapCp: options.forcingGapCp ?? DEFAULT_OPTIONS.forcingGapCp,
      bookPlies: options.bookPlies ?? DEFAULT_OPTIONS.bookPlies,
      apiKey,
      model: options.model ?? process.env.JEV_MODEL ?? 'jev-latest',
      engine: options.engine ?? new SearchEngine(),
      book: SHARED_BOOK
    };

    this.client = this.options.useJev
      ? new TypeSafeClient({
          apiKey,
          model: this.options.model,
          timeoutMs: this.options.jevTimeoutMs
        })
      : null;
  }

  public describeConfiguration(): Record<string, unknown> {
    return {
      model: this.options.model,
      jevEnabled: this.client !== null,
      jevTimeoutMs: this.options.jevTimeoutMs,
      bookEnabled: this.options.useBook,
      bookPositions: this.options.book.size(),
      searchTimeMs: this.options.searchTimeMs,
      searchMaxDepth: this.options.searchMaxDepth,
      candidateCount: this.options.candidateCount,
      trustWindowCp: this.options.trustWindowCp,
      maxAcceptableLossCp: this.options.maxAcceptableLossCp,
      minPlanConfidence: this.options.minPlanConfidence
    };
  }

  public async decide(input: BrainInput): Promise<BrainDecision> {
    const started = Date.now();
    const fen = input.fen;
    const moves = input.moves ?? [];
    const pos = new Position(fen);
    const legal = generateLegalMoves(pos);

    if (legal.length === 0) {
      throw new Error('ChessBrain.decide called on a position with no legal moves');
    }

    const searchStart = Date.now();
    const search = this.options.engine.search(pos, {
      timeMs: this.options.searchTimeMs,
      maxDepth: this.options.searchMaxDepth
    });
    const searchMs = Date.now() - searchStart;

    const facts = analyzePosition(pos, moves);
    const candidates = buildCandidates(
      pos,
      fen,
      search.rootMoves,
      this.options.candidateCount,
      this.options.engine
    );
    const bestScore = search.rootMoves[0].score;
    const secondScore = search.rootMoves[1]?.score ?? bestScore;
    const gap = bestScore - secondScore;

    let strategy: StrategyOutput | null = null;
    let jevMs = 0;
    let outcome: FusionOutcome | null = null;

    if (search.mateInPlies !== undefined && bestScore > 0) {
      // A forced win is a fact, not a judgment call.
      outcome = {
        move: search.bestMove,
        san: moveToSan(fen, search.bestMove) ?? '',
        path: 'checkmate',
        confidence: 0.98
      };
    } else if (legal.length === 1) {
      outcome = {
        move: legal[0],
        san: moveToSan(fen, legal[0]) ?? '',
        path: 'only_move',
        confidence: 0.95
      };
    } else if (this.options.useBook && moves.length < this.options.bookPlies) {
      const bookSan = this.options.book.pick(fen, moves.length);
      const bookMove = bookSan ? findMoveBySan(pos, fen, bookSan) : null;
      if (bookMove !== null && bookSan) {
        outcome = { move: bookMove, san: bookSan, path: 'opening_book', confidence: 0.6 };
      }
    }

    if (!outcome && (gap >= this.options.forcingGapCp || facts.isInCheck)) {
      // Either the engine's best move is far ahead of every alternative, or the
      // king is in check and the reply has to be exact. Both are tactical calls
      // where a positional opinion is not wanted.
      outcome = engineOnlyOutcome(fen, search);
      outcome.path = 'engine_forcing';
    }

    if (!outcome && this.client) {
      const searchSan = search.pv.length > 0 ? renderPv(fen, search.pv) : { san: [], text: '' };
      const strategyInput: StrategyInput = {
        fen,
        facts,
        candidates,
        search: {
          depth: search.depth,
          nodes: search.nodes,
          scoreCp: bestScore,
          mateInPlies: search.mateInPlies,
          bestSan: moveToSan(fen, search.bestMove) ?? '',
          pvSan: searchSan.san,
          pvText: searchSan.text
        },
        moves
      };

      const jevStart = Date.now();
      try {
        if (this.jevBreaker.canAttempt()) {
          strategy = await askJev(this.client, strategyInput);
          this.jevBreaker.recordSuccess();
        } else {
          // The breaker is open: upstream has timed out repeatedly, so answer
          // engine-only instead of paying the timeout again this move.
          strategy = null;
        }
      } catch (error) {
        // A model failure must never stop the engine from answering.
        strategy = null;
        this.jevBreaker.recordFailure();
        if (process.env.DEBUG_JEV === 'true') {
          console.warn('[ChessBrain] Jev request failed, using the engine only:', error);
        }
      }
      jevMs = Date.now() - jevStart;
    }

    if (!outcome) {
      outcome = fuseDecision(fen, search, candidates, strategy, this.options);
    }

    return this.assemble({
      fen,
      pos,
      facts,
      search,
      candidates,
      strategy,
      outcome,
      searchMs,
      jevMs,
      moves,
      started
    });
  }

  private assemble(input: AssembleInput): BrainDecision {
    const { fen, pos, facts, search, candidates, strategy, outcome, searchMs, jevMs, started } = input;
    const bestScore = search.rootMoves[0].score;
    const chosen = candidates.find((candidate) => candidate.move === outcome.move) ?? candidates[0];

    const theme = strategy?.strategicPriority ?? deriveTheme(facts, search, chosen);
    const engineUnit = scoreToUnit(bestScore);
    const positionScore =
      strategy?.positionBalance != null
        ? clampNumber(0.65 * engineUnit + 0.35 * strategy.positionBalance, 0.02, 0.98)
        : clampNumber(engineUnit, 0.02, 0.98);

    const ourLoose = facts.hangingPieces.filter((piece) => piece.side === facts.sideToMove);
    const opponentThreat = strategy?.opponentThreat ?? (ourLoose.length > 0 ? 0.5 : 0.15);
    const attackAvailable = strategy?.attackAvailable ?? 0;

    const ordered = [chosen, ...candidates.filter((candidate) => candidate.move !== chosen.move)];
    const topCandidates = toCandidatePayload(pos, ordered, strategy).slice(0, 3);

    const ourPromotion = facts.passedPawns.find(
      (pawn) => pawn.side === facts.sideToMove && pawn.stepsToPromotion <= 2
    );
    const theirPromotion = facts.passedPawns.find(
      (pawn) => pawn.side !== facts.sideToMove && pawn.stepsToPromotion <= 2
    );

    return {
      fen,
      sideToMove: facts.sideToMove,
      moveNumber: facts.fullmoveNumber,
      recommendedMove: outcome.san,
      fromSquare: squareName(moveFrom(outcome.move)),
      toSquare: squareName(moveTo(outcome.move)),
      decisionPath: outcome.path,
      confidence: Number(outcome.confidence.toFixed(2)),
      candidates,
      facts,
      search,
      strategy,
      jevUsed: strategy !== null,
      latencyMs: Date.now() - started,
      rationale: buildRationale(fen, chosen, search, strategy, outcome, facts),
      pvSan: renderPv(fen, search.pv).san,
      strategicTheme: theme,
      positionScore: Number(positionScore.toFixed(2)),
      isTacticalDanger:
        facts.isInCheck ||
        ourLoose.some((piece) => piece.value >= 300) ||
        opponentThreat >= 0.65 ||
        bestScore < -150,
      isCheckmateOpportunity: search.mateInPlies !== undefined && bestScore > 0,
      mateInPlies: search.mateInPlies,
      topCandidates,
      positionEvaluationLabel: unitToLabel(positionScore),
      attackInitiativeProbability: Number(attackAvailable.toFixed(2)),
      counterplayRiskProbability: Number(opponentThreat.toFixed(2)),
      promotionAlert: ourPromotion
        ? `Passed pawn on ${ourPromotion.square} is ${ourPromotion.stepsToPromotion} step(s) from promotion`
        : theirPromotion
          ? `Their passed pawn on ${theirPromotion.square} is ${theirPromotion.stepsToPromotion} step(s) from promotion`
          : undefined,
      enemyKingExposure: facts.enemyKing.exposure,
      threatAlert:
        ourLoose.length > 0
          ? `Loose for you: ${ourLoose
              .slice(0, 3)
              .map((piece) => `${piece.piece} on ${piece.square}`)
              .join(', ')}`
          : opponentThreat >= 0.6
            ? 'Jev reads a concrete threat that has to be answered'
            : undefined,
      materialDelta: facts.materialDeltaPawns,
      jevOverrideReason: outcome.overrideReason,
      latencyBreakdown: { searchMs, jevMs }
    };
  }
}
export interface CandidatePayload {
  move: string;
  from: string;
  to: string;
  probability: number;
  piece?: string;
  captured?: string;
  purpose?: string;
  risk?: string;
  scoreCp?: number;
  evalLossCp?: number;
}

interface AssembleInput {
  fen: string;
  pos: Position;
  facts: PositionFacts;
  search: SearchResult;
  candidates: CandidateMove[];
  strategy: StrategyOutput | null;
  outcome: FusionOutcome;
  searchMs: number;
  jevMs: number;
  moves: string[];
  started: number;
}

/**
 * Builds the candidate payload for the UI. Probability comes from Jev's own
 * distribution when it answered, and from the engine's scores otherwise, so the
 * numbers shown always mean something in the source that produced them.
 */
function toCandidatePayload(
  pos: Position,
  candidates: CandidateMove[],
  strategy: StrategyOutput | null
): CandidatePayload[] {
  const maxScore = Math.max(...candidates.map((candidate) => candidate.scoreCp));
  const weights = candidates.map((candidate) => Math.exp((candidate.scoreCp - maxScore) / 120));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  return candidates.map((candidate, index) => {
    const from = moveFrom(candidate.move);
    const to = moveTo(candidate.move);
    const capturedCode = pos.board[to];
    const jevProbability = strategy?.planProbabilities?.[candidate.san];

    return {
      move: candidate.san,
      from: squareName(from),
      to: squareName(to),
      probability: Number((jevProbability !== undefined ? jevProbability : weights[index] / total).toFixed(2)),
      piece: PIECE_LETTER[pos.board[from]].toLowerCase(),
      captured: capturedCode === EMPTY ? undefined : PIECE_LETTER[capturedCode].toLowerCase(),
      purpose: candidate.purpose,
      risk: candidate.risk,
      scoreCp: candidate.scoreCp,
      evalLossCp: candidate.evalLossCp
    };
  });
}

/** Falls back to the engine's own best move. */
function engineOnlyOutcome(fen: string, search: SearchResult): FusionOutcome {
  const best = search.rootMoves[0];
  const gap = best.score - (search.rootMoves[1]?.score ?? best.score);
  return {
    move: best.move,
    san: moveToSan(fen, best.move) ?? '',
    path: 'engine_best',
    confidence: clampNumber(0.4 + 0.55 * clampNumber(gap / 200, 0, 1), 0.3, 0.95)
  };
}

/** Deterministic theme, used when Jev did not answer. */
function deriveTheme(facts: PositionFacts, search: SearchResult, chosen: CandidateMove): string {
  const bestScore = search.rootMoves[0].score;
  if (search.mateInPlies !== undefined && bestScore > 0) return 'king_hunt';
  if (facts.isInCheck) return 'defend_threat';
  const ourPassed = facts.passedPawns.find((pawn) => pawn.side === facts.sideToMove);
  if (ourPassed && ourPassed.stepsToPromotion <= 3) return 'promote_passed_pawn';
  const theirPassed = facts.passedPawns.find((pawn) => pawn.side !== facts.sideToMove);
  if (theirPassed && theirPassed.stepsToPromotion <= 2) return 'defend_threat';
  if (facts.enemyKing.attackers >= 2 && facts.enemyKing.shieldPawns <= 1) return 'king_hunt';
  if (facts.phase === 'opening') return 'development';
  if (facts.phase === 'endgame') return 'endgame_conversion';
  if (chosen.isCapture) return 'positional_squeeze';
  return facts.enemyKing.escapeSquares <= 3 ? 'king_hunt' : 'positional_squeeze';
}

/** A factual, readable explanation of why this move was chosen. */
function buildRationale(
  fen: string,
  chosen: CandidateMove,
  search: SearchResult,
  strategy: StrategyOutput | null,
  outcome: FusionOutcome,
  facts: PositionFacts
): string {
  const parts: string[] = [];
  const matePlies = search.mateInPlies;

  if (outcome.path === 'checkmate' && matePlies !== undefined) {
    parts.push(`${chosen.san} delivers forced checkmate in ${Math.ceil(matePlies / 2)} move(s).`);
  } else {
    parts.push(
      `${chosen.san} is rated ${evalInPawns(chosen.scoreCp)} by the engine, which searched ${search.depth} plies (${search.nodes.toLocaleString()} positions).`
    );
  }

  parts.push(`${chosen.purpose}.`);

  if (chosen.pvSan.length > 1) {
    parts.push(`Expected continuation: ${chosen.pvText}.`);
  }

  if (outcome.path === 'opening_book') {
    parts.push('This is established opening theory, so it is played from the book.');
  }

  if (strategy?.strategicPriority) {
    parts.push(
      `Jev (${strategy.model}) reads the strategic priority as "${strategy.strategicPriority}" — ${describeTheme(strategy.strategicPriority)} — at ${(strategy.planConfidence * 100).toFixed(0)}% confidence.`
    );
  }

  if (strategy?.opponentThreat != null && strategy.opponentThreat >= 0.6) {
    parts.push(`It also flags an opponent threat that has to be answered.`);
  }

  const loose = facts.hangingPieces.filter((piece) => piece.side === facts.sideToMove);
  if (loose.length > 0) {
    parts.push(
      `Watch out: ${loose
        .slice(0, 2)
        .map((piece) => `your ${piece.piece} on ${piece.square}`)
        .join(' and ')} ${loose.length === 1 ? 'is' : 'are'} loose.`
    );
  } else {
    parts.push(chosen.risk + '.');
  }

  if (outcome.overrideReason) {
    parts.push(outcome.overrideReason + '.');
  }

  void fen;
  return parts.join(' ');
}

/** Finds the engine's encoding of a SAN move in a position. */
function findMoveBySan(pos: Position, fen: string, san: string): number | null {
  for (const move of generateLegalMoves(pos)) {
    if (moveToSan(fen, move) === san) return move;
  }
  return null;
}