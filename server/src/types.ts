export type Color = 'w' | 'b';

export interface BoardStatePayload {
  fen: string;
  turn: Color;
  /**
   * The side the caller is asking for advice on behalf of.
   *
   * When present and it is not that side's turn, the engine declines to
   * recommend anything rather than answering for the opponent. This is what
   * makes a wrong-side suggestion structurally impossible instead of merely
   * unlikely.
   */
  perspective?: Color;
  turnDescription?: string;
  moveCount?: number;
  fullMoveNumber?: number;
  halfMoveClock?: number;
  castlingRights?: string;
  enPassantSquare?: string;
  lastMove?: {
    from?: string;
    to?: string;
    san?: string;
  };
  moves?: string[];
  isCheck?: boolean;
  isCheckmate?: boolean;
  isDraw?: boolean;
  isGameOver?: boolean;
  timestamp?: number;
}

export interface MoveCandidate {
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

export interface KingSafetyReport {
  square: string;
  isCastled: boolean;
  pawnShieldCount: number;
  isOpenFileAdjacent: boolean;
  distanceFromCenter: number;
  escapeSquaresCount: number;
  exposureDescription: string;
}

export interface ThreatRadarReport {
  hasEnemyPassedPawns: boolean;
  enemyPassedPawns: { square: string; stepsToPromotion: number }[];
  imminentPromotionRisk: boolean;
  threatSummary: string;
}

export interface PieceActivityReport {
  dormantMajorPieces: string[];
  recentRepeatedPieces: string[];
  activitySummary: string;
}

export interface JevDecisionResult {
  recommendedMove: string;
  fromSquare?: string;
  toSquare?: string;
  confidence: number;
  topCandidates: MoveCandidate[];
  allChoicesProbabilities?: Record<string, number>;
  positionScore: number; // 0.0 (losing) to 1.0 (winning)
  positionEvaluationLabel: string;
  isTacticalDanger: boolean;
  tacticalDangerProbability: number;
  isCheckmateOpportunity: boolean;
  checkmateOpportunityProbability: number;
  attackInitiativeProbability?: number;
  counterplayRiskProbability?: number;
  strategicPriority?: string;
  strategicTheme: string;
  strategicRationale: string;
  promotionAlert?: string;
  enemyKingExposure?: string;
  threatAlert?: string;
  materialDelta?: number;
  latencyMs: number;
  /** True when no move was recommended because it is not `perspective`'s turn. */
  waitingForOpponent?: boolean;
  isSimulated: boolean;
  timestamp: number;

  /* ---------------------------------------------------------------------- */
  /* Engine transparency. All optional so older consumers keep working.      */
  /* ---------------------------------------------------------------------- */

  /** Which rule produced the move: mate, book, forcing, Jev's plan, engine. */
  decisionPath?: string;
  /** Depth the alpha-beta search completed. */
  engineDepth?: number;
  /** Search evaluation in pawns, from the mover's point of view. */
  engineEvalPawns?: number;
  engineNodes?: number;
  /** Verified principal variation in SAN. */
  enginePvSan?: string[];
  /** The option Jev picked for the plan question, when it was consulted. */
  jevPlan?: string;
  jevPlanConfidence?: number;
  jevModel?: string;
  jevLatencyMs?: number;
  /** Why Jev's suggestion was not played, when the engine's move was kept. */
  jevOverrideReason?: string;
  /** Search and model time, so latency can be attributed. */
  latencyBreakdown?: { searchMs: number; jevMs: number };
}

export interface EvaluateResponse {
  success: boolean;
  fen: string;
  decision?: JevDecisionResult;
  error?: string;
}

export interface TelemetryLogEntry {
  gameId?: string;
  moveNumber: number;
  fen: string;
  sideToMove: Color;
  recommendedMove: string;
  fromSquare?: string;
  toSquare?: string;
  confidence: number;
  topCandidates?: MoveCandidate[];
  positionScore: number;
  isTacticalDanger: boolean;
  strategicTheme?: string;
  strategicRationale?: string;
  latencyMs: number;
  isSimulated: boolean;
  timestamp: string;
}

