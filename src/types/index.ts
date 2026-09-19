export type Color = 'w' | 'b';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** How the extension obtained a position. */
export type PositionSource =
  /** Replayed from the on-page move list — authoritative. */
  | 'move-list'
  /** Rebuilt from the piece elements on the board (last resort). */
  | 'dom-fallback'
  /** Nothing new could be learned, so the last good position is reused. */
  | 'carried-over'
  /** A fresh game sitting on the standard starting position. */
  | 'start';

export interface PiecePlacement {
  type: PieceType;
  color: Color;
  square: string; // e.g., 'e4', 'a1'
  file: number;   // 1 to 8 (a=1, h=8)
  rank: number;   // 1 to 8 (1=1, 8=8)
}

export interface BoardState {
  fen: string;
  turn: Color;
  turnDescription: string;
  moveCount: number;
  fullMoveNumber: number;
  halfMoveClock: number;
  castlingRights: string;
  enPassantSquare: string;
  lastMove?: {
    from?: string;
    to?: string;
    san?: string;
  };
  moves: string[]; // List of all played SAN moves
  isCheck: boolean;
  isCheckmate: boolean;
  isDraw: boolean;
  isGameOver: boolean;
  timestamp: number;

  /* ---------------------------------------------------------------------- */
  /* Provenance and perspective.                                            */
  /* ---------------------------------------------------------------------- */

  /** Where this position came from, so callers can judge how much to trust it. */
  sources: PositionSource;
  /**
   * False when the position could not be fully verified (for example a move in
   * the on-page list could not be parsed, or the turn had to be guessed). Advice
   * is withheld for incomplete positions rather than guessed at.
   */
  isComplete: boolean;
  /** Which side the board is currently displayed for. */
  orientation: Color;
  /** The side the extension believes the human is playing. */
  perspective?: Color;
}

export interface MoveCandidate {
  move: string;
  from: string;
  to: string;
  probability: number;
  piece?: string;
  captured?: string;
}

export interface JevDecisionResult {
  recommendedMove: string;
  fromSquare?: string;
  toSquare?: string;
  confidence: number;
  topCandidates: MoveCandidate[];
  allChoicesProbabilities?: Record<string, number>;
  positionScore: number;
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
  isSimulated: boolean;
  timestamp: number;
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

export interface JevRecommendationState {
  recommendedMove?: string;
  fromSquare?: string;
  toSquare?: string;
  confidence?: number;
  topCandidates?: MoveCandidate[];
  positionScore?: number;
  positionEvaluationLabel?: string;
  isTacticalDanger?: boolean;
  tacticalDangerProbability?: number;
  isCheckmateOpportunity?: boolean;
  attackInitiativeProbability?: number;
  counterplayRiskProbability?: number;
  strategicPriority?: string;
  strategicTheme?: string;
  strategicRationale?: string;
  promotionAlert?: string;
  enemyKingExposure?: string;
  threatAlert?: string;
  materialDelta?: number;
  latencyMs?: number;
  isSimulated?: boolean;
  status: 'idle' | 'analyzing' | 'ready' | 'error';
  errorMessage?: string;

  /* ---------------------------------------------------------------------- */
  /* Correlation and transparency.                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The position this recommendation was computed for. The content script
   * discards any reply whose `fen` no longer matches the board, which is what
   * stops a slow answer for an old position from being displayed as the move.
   */
  fen?: string;
  /** The side this recommendation was computed for. */
  perspective?: Color;
  /** True when the engine declined because it is not the human's turn. */
  waitingForOpponent?: boolean;
  decisionPath?: string;
  engineDepth?: number;
  engineEvalPawns?: number;
  jevPlan?: string;
  jevPlanConfidence?: number;
  jevOverrideReason?: string;
}

export type ExtensionMessage =
  | { type: 'BOARD_STATE_UPDATED'; payload: BoardState }
  | { type: 'GET_CURRENT_STATE' }
  | { type: 'TOGGLE_HUD'; payload?: boolean }
  | { type: 'TOGGLE_OVERLAY'; payload?: boolean }
  | { type: 'RECOMMENDATION_UPDATED'; payload: JevRecommendationState }
  | { type: 'SERVER_STATUS_CHANGED'; payload: { connected: boolean; url?: string } }
  | { type: 'EVALUATE_POSITION'; payload: BoardState }
  | {
      type: 'DIAGNOSTICS';
      payload: {
        progress: string;
        hudAvailable: boolean;
        boardSource: string | null;
        state: BoardState | null;
      };
    }
  | { type: 'FORCE_REEVALUATE' }
  | { type: 'GET_CURRENT_RECOMMENDATION' };

