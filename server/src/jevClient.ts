import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';
import { BoardStatePayload, JevDecisionResult, MoveCandidate } from './types.js';
import { ChessBrain, type BrainOptions, type BrainDecision } from './brain/chessBrain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });
dotenv.config({ path: path.resolve(__dirname, '../../server/.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export interface JevEngineOptions {
  brain?: BrainOptions;
}

/**
 * Compatibility facade over `ChessBrain`.
 *
 * The HTTP server, the Chrome extension and the dashboard all speak
 * `JevDecisionResult`, so that shape is preserved exactly. What changed is what
 * produces it. The previous implementation asked Jev to choose from a flat list
 * of ~35 legal moves, with a handful of hardcoded penalties as the safety net.
 * This one runs a real alpha-beta search first, hands Jev a short list of
 * engine-verified candidates carrying their evaluations and principal
 * variations, and lets ordinary code combine the two.
 */
export class JevChessEngine {
  private readonly brain: ChessBrain;

  constructor(options: JevEngineOptions = {}) {
    this.brain = new ChessBrain(options.brain);
    const config = this.brain.describeConfiguration();
    console.log(
      `[JevEngine] Initialized. Model=${config.model} Jev=${config.jevEnabled ? 'on' : 'off (no API key)'} ` +
        `Book=${config.bookPositions} positions, search=${config.searchTimeMs}ms / maxDepth ${config.searchMaxDepth}`
    );
  }

  /** Diagnostics for `/health` and the dashboard. */
  public describeConfiguration(): Record<string, unknown> {
    return this.brain.describeConfiguration();
  }

  public async evaluatePosition(payload: BoardStatePayload): Promise<JevDecisionResult> {
    const startTime = Date.now();
    const chess = new Chess(payload.fen);

    // If the caller told us whose move it is looking for advice on, and it is
    // not that side's turn, decline. Recommending the opponent's best move and
    // presenting it as the player's is the single most damaging thing this
    // service can do, so it refuses instead of guessing.
    if (payload.perspective && chess.turn() !== payload.perspective) {
      return waitingResult(chess, startTime);
    }

    if (chess.moves().length === 0) {
      return terminalResult(chess, startTime);
    }

    const decision = await this.brain.decide({ fen: payload.fen, moves: payload.moves ?? [] });
    return toLegacyResult(decision);
  }
}

/** Returned when it is not the caller's turn, so nothing is recommended. */
function waitingResult(chess: Chess, startTime: number): JevDecisionResult {
  const turn = chess.turn();
  return {
    recommendedMove: '',
    waitingForOpponent: true,
    confidence: 0,
    topCandidates: [],
    positionScore: 0.5,
    positionEvaluationLabel: 'Waiting',
    isTacticalDanger: chess.isCheck(),
    tacticalDangerProbability: chess.isCheck() ? 0.8 : 0,
    isCheckmateOpportunity: false,
    checkmateOpportunityProbability: 0,
    strategicTheme: 'waiting',
    strategicRationale: `It is ${turn === 'w' ? 'White' : 'Black'} to move, which is not the side that asked for advice.`,
    latencyMs: Date.now() - startTime,
    isSimulated: false,
    timestamp: Date.now(),
    decisionPath: 'waiting_for_opponent'
  };
}

/** Result for a finished game, where no move can be recommended. */
function terminalResult(chess: Chess, startTime: number): JevDecisionResult {
  const isMated = chess.isCheckmate();
  const label = isMated
    ? 'Checkmate'
    : chess.isStalemate()
      ? 'Stalemate'
      : chess.isInsufficientMaterial()
        ? 'Draw: insufficient material'
        : chess.isThreefoldRepetition()
          ? 'Draw: repetition'
          : chess.isDrawByFiftyMoves()
            ? 'Draw: fifty-move rule'
            : 'Draw';

  return {
    recommendedMove: '',
    confidence: 1.0,
    topCandidates: [],
    positionScore: isMated ? (chess.turn() === 'w' ? 0 : 1) : 0.5,
    positionEvaluationLabel: label,
    isTacticalDanger: isMated,
    tacticalDangerProbability: isMated ? 1 : 0,
    isCheckmateOpportunity: false,
    checkmateOpportunityProbability: 0,
    strategicTheme: 'game_over',
    strategicRationale: isMated
      ? 'The side to move is checkmated; the game is over.'
      : `${label} — the game is drawn.`,
    latencyMs: Date.now() - startTime,
    isSimulated: false,
    timestamp: Date.now(),
    decisionPath: 'game_over'
  };
}

/** Maps the rich brain result onto the shape the extension already consumes. */
function toLegacyResult(decision: BrainDecision): JevDecisionResult {
  const strategy = decision.strategy;
  const topCandidates: MoveCandidate[] = decision.topCandidates.map((candidate) => ({
    move: candidate.move,
    from: candidate.from,
    to: candidate.to,
    probability: candidate.probability,
    piece: candidate.piece,
    captured: candidate.captured,
    purpose: candidate.purpose,
    risk: candidate.risk,
    scoreCp: candidate.scoreCp,
    evalLossCp: candidate.evalLossCp
  }));

  return {
    recommendedMove: decision.recommendedMove,
    fromSquare: decision.fromSquare,
    toSquare: decision.toSquare,
    confidence: decision.confidence,
    topCandidates,
    allChoicesProbabilities: strategy?.planProbabilities,
    positionScore: decision.positionScore,
    positionEvaluationLabel: decision.positionEvaluationLabel,
    isTacticalDanger: decision.isTacticalDanger,
    tacticalDangerProbability: decision.counterplayRiskProbability,
    isCheckmateOpportunity: decision.isCheckmateOpportunity,
    checkmateOpportunityProbability: decision.isCheckmateOpportunity
      ? 1
      : decision.attackInitiativeProbability,
    attackInitiativeProbability: decision.attackInitiativeProbability,
    counterplayRiskProbability: decision.counterplayRiskProbability,
    strategicPriority: strategy?.strategicPriority ?? decision.strategicTheme,
    strategicTheme: decision.strategicTheme,
    strategicRationale: decision.rationale,
    promotionAlert: decision.promotionAlert,
    enemyKingExposure: decision.enemyKingExposure,
    threatAlert: decision.threatAlert,
    materialDelta: decision.materialDelta,
    latencyMs: decision.latencyMs,
    // Kept for compatibility: `false` means the Jev model took part in the
    // decision. When no API key is configured the engine answers alone, which is
    // the local fallback the HUD labels separately.
    isSimulated: !decision.jevUsed,
    timestamp: Date.now(),
    decisionPath: decision.decisionPath,
    engineDepth: decision.search.depth,
    engineEvalPawns: Number((decision.search.score / 100).toFixed(2)),
    engineNodes: decision.search.nodes,
    enginePvSan: decision.pvSan.length > 0 ? decision.pvSan : undefined,
    jevPlan: strategy?.planChoice ?? undefined,
    jevPlanConfidence: strategy?.planConfidence,
    jevModel: strategy?.model,
    jevLatencyMs: strategy?.latencyMs,
    jevOverrideReason: decision.jevOverrideReason,
    latencyBreakdown: decision.latencyBreakdown
  };
}