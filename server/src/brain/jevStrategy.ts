import { EMPTY, PIECE_LETTER, moveFrom, moveTo, pieceType, squareName } from '../engine/constants.js';
import type { Position } from '../engine/position.js';
import type { RootMove, SearchEngine } from '../engine/search.js';
import { moveToSan, renderPv } from './notation.js';
import { analyzePosition, type PositionFacts } from './positionFacts.js';
import type { QuestionSet, TypeSafeClient } from './typesafeClient.js';

/**
 * The strategic half of the brain.
 *
 * Only the three documented System One primitives are used, and everything the
 * model is asked is asked in one batched request (the "speculative fan-out"
 * pattern). Each candidate move arrives carrying the engine's verified
 * evaluation and principal variation, so Jev chooses between *facts* instead of
 * guessing about tactics it cannot see. Every question names the exact field of
 * `state` it is about, and every option is described with a structured object
 * rather than a short label.
 */

export interface CandidateMove {
  move: number;
  uci: string;
  san: string;
  rank: number;
  /** Engine score in centipawns, from the mover's point of view. */
  scoreCp: number;
  /** Centipawns below the best root move; 0 for the best move. */
  evalLossCp: number;
  exact: boolean;
  isCheck: boolean;
  isCapture: boolean;
  isCastle: boolean;
  isPromotion: boolean;
  isMate: boolean;
  /** Our pieces left attacked-and-undefended once this move is played. */
  looseAfter: string[];
  /** Facts about the position that arises after this move. */
  after: PositionFacts;
  expectedReply: string | null;
  pvSan: string[];
  pvText: string;
  purpose: string;
  risk: string;
}

export interface StrategyInput {
  fen: string;
  facts: PositionFacts;
  candidates: CandidateMove[];
  search: {
    depth: number;
    nodes: number;
    scoreCp: number;
    mateInPlies?: number;
    bestSan: string;
    pvSan: string[];
    pvText: string;
  };
  moves: string[];
}

export interface StrategyOutput {
  model: string;
  /** Option key Jev picked for the plan question, or null if unanswered. */
  planChoice: string | null;
  planConfidence: number;
  planProbabilities: Record<string, number>;
  strategicPriority: string | null;
  /** Jev's 0..1 view of the position from our side; null when unanswered. */
  positionBalance: number | null;
  /** Probability the opponent has a concrete threat we must address. */
  opponentThreat: number | null;
  /** Probability we have a viable attack on the enemy king. */
  attackAvailable: number | null;
  positionCharacter: string | null;
  /** 0 quiet, 1 normal, 2 forcing. */
  forcingLevel: number | null;
  latencyMs: number;
  requestId?: string;
  inputTokens?: number;
}

/** The closed vocabulary of strategic priorities, with descriptions for Jev. */
export const STRATEGIC_PRIORITIES: Record<string, Record<string, string>> = {
  king_hunt: {
    what: 'Coordinate heavy pieces to attack the enemy king',
    when: 'The enemy king has little cover, few escape squares, or several of your pieces already attack its zone',
    not_for: 'A quiet position where the enemy king is safe behind an intact pawn shield'
  },
  promote_passed_pawn: {
    what: 'Advance a passed pawn towards promotion',
    when: 'You own a passed pawn that can be supported, especially once few pieces remain',
    not_for: 'Pushing a pawn the opponent can blockade or win immediately'
  },
  defend_threat: {
    what: 'Neutralise a concrete threat against you',
    when: 'The opponent is threatening mate, a winning capture or a promotion right now',
    not_for: 'Prophylaxis against something the opponent cannot actually execute'
  },
  mobilize_arsenal: {
    what: 'Bring a dormant rook, bishop or queen into active play',
    when: 'You still have undeveloped or passive heavy pieces while the opponent is active',
    not_for: 'Moving a piece that is already the most active one on the board'
  },
  development: {
    what: 'Develop pieces and complete king safety',
    when: 'The game is still in the opening and pieces are sitting on their starting squares',
    not_for: 'The middlegame and endgame, where moves must achieve something concrete'
  },
  positional_squeeze: {
    what: 'Improve the structure and restrict the opponent without forcing matters',
    when: 'The position is balanced and neither side has a forcing continuation',
    not_for: 'Positions where a concrete tactic or an exposed king demands a forcing move'
  },
  endgame_conversion: {
    what: 'Use the king actively and convert a material or structural edge',
    when: 'Few pieces remain and pawn play plus king activity decide the game',
    not_for: 'Middlegames where the king would walk into an attack'
  },
  prophylaxis: {
    what: 'Prevent the opponent from carrying out their plan before starting your own',
    when: 'The opponent has an obvious next idea that would equalise or take over',
    not_for: 'Positions where you can simply execute a stronger immediate threat'
  }
};

export const PRIORITY_KEYS: string[] = Object.keys(STRATEGIC_PRIORITIES);

const POSITION_CHARACTERS: Record<string, Record<string, string | string[]>> = {
  open_tactical: {
    what: 'Open position with exposed kings and loose pieces where concrete tactics decide',
    signals: ['Open files and diagonals', 'Kings without full pawn cover', 'Pieces attacking each other']
  },
  closed_positional: {
    what: 'Blocked pawn chains where slow manoeuvring and structure decide',
    signals: ['Locked or semi-locked pawn chains', 'Few open lines', 'Both kings reasonably safe']
  },
  maneuvering: {
    what: 'Balanced middlegame where both sides are improving pieces before committing',
    signals: ['Material level', 'No forcing continuation available', 'Pieces not yet on their ideal squares']
  },
  endgame_technical: {
    what: 'Few pieces left, where king activity and pawn promotion decide',
    signals: ['Queens traded or few pieces remaining', 'Passed pawns matter', 'King belongs in the centre']
  }
};
/** Full names, so a rationale reads "the knight" rather than "the n". */
const CAPTURE_NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king'
};

/** Human description of what a move accomplishes on its own terms. */
function describePurpose(pos: Position, move: number, isMate: boolean, factsAfter: PositionFacts): string {
  const board = pos.board;
  const from = moveFrom(move);
  const to = moveTo(move);
  const piece = board[from];
  const type = pieceType(piece);
  const captured = board[to] !== EMPTY ? board[to] : null;

  if (isMate) return 'Delivers immediate checkmate and ends the game';
  if (captured) {
    const letter = PIECE_LETTER[captured].toLowerCase();
    return `Captures the ${CAPTURE_NAMES[letter] ?? 'piece'} on ${squareName(to)}`;
  }
  if (type === 1) {
    const becomesPassed = factsAfter.passedPawns.some((p) => p.square === squareName(to));
    return becomesPassed
      ? `Advances a passed pawn to ${squareName(to)}`
      : `Advances a pawn to ${squareName(to)}`;
  }
  if (type === 2 || type === 3) {
    return `Develops the ${type === 2 ? 'knight' : 'bishop'} to ${squareName(to)}`;
  }
  if (type === 4) return `Activates the rook on ${squareName(to)}`;
  if (type === 5) return `Activates the queen on ${squareName(to)}`;
  if (type === 6) return 'Repositions the king';
  return `Sends a piece to ${squareName(to)}`;
}

function describeRisk(after: PositionFacts, colour: 'w' | 'b'): string {
  const loose = after.hangingPieces.filter((p) => p.side === colour);
  if (loose.length === 0) return 'No piece of yours is left attacked and undefended';
  const names = loose.slice(0, 3).map((p) => `your ${p.piece} on ${p.square}`);
  return `Leaves ${names.join(', ')} loose, so the opponent may be able to win material`;
}

function toUci(move: number): string {
  return squareName(moveFrom(move)) + squareName(moveTo(move));
}

/** Builds the enriched candidate list handed to Jev. */
export function buildCandidates(
  pos: Position,
  fen: string,
  rootMoves: RootMove[],
  limit: number,
  engine?: SearchEngine
): CandidateMove[] {
  const bestScore = rootMoves[0]?.score ?? 0;
  const candidates: CandidateMove[] = [];

  for (const rootMove of rootMoves.slice(0, limit)) {
    const san = moveToSan(fen, rootMove.move);
    if (!san) continue;

    const board = pos.board;
    const isCapture = board[moveTo(rootMove.move)] !== EMPTY;

    pos.makeMove(rootMove.move);
    const isCheck = pos.inCheck();
    const factsAfter = analyzePosition(pos, []);
    // The search left a transposition entry for every position it reached, so
    // the expected reply can be read straight out of the table.
    const reply = engine ? engine.extractPv(pos, 4) : [];
    pos.undoMove();

    const pv = renderPv(fen, [rootMove.move, ...reply]);
    const isMate = rootMove.score > 29000;

    candidates.push({
      move: rootMove.move,
      uci: toUci(rootMove.move),
      san,
      rank: candidates.length + 1,
      scoreCp: rootMove.score,
      evalLossCp: Math.max(0, bestScore - rootMove.score),
      exact: rootMove.exact,
      isCheck,
      isCapture,
      isCastle: san === 'O-O' || san === 'O-O-O',
      isPromotion: san.includes('='),
      isMate,
      looseAfter: factsAfter.hangingPieces
        .filter((p) => p.side === factsAfter.sideToMove)
        .map((p) => `${p.piece} on ${p.square}`),
      after: factsAfter,
      expectedReply: pv.san[1] ?? null,
      pvSan: pv.san,
      pvText: pv.text,
      purpose: describePurpose(pos, rootMove.move, isMate, factsAfter),
      risk: describeRisk(factsAfter, factsAfter.sideToMove)
    });
  }

  return candidates;
}

export function evalInPawns(cp: number): string {
  const pawns = cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)} pawns for you`;
}
/** The structured `state` object Jev reasons over. */
export function buildState(input: StrategyInput): Record<string, unknown> {
  const { facts, candidates, search } = input;
  const side = facts.sideToMove === 'w' ? 'White' : 'Black';
  const opponent = facts.sideToMove === 'w' ? 'Black' : 'White';

  const candidateEntries: Record<string, unknown> = {};
  for (const candidate of candidates) {
    candidateEntries[candidate.san] = {
      play_this: `${candidate.san} (${candidate.uci})`,
      engine_rank: candidate.rank,
      engine_evaluation: evalInPawns(candidate.scoreCp),
      compared_to_engine_best:
        candidate.evalLossCp === 0
          ? 'This is the engine best move'
          : `The engine rates it ${(candidate.evalLossCp / 100).toFixed(2)} pawns below its best move`,
      nature: candidate.isMate
        ? 'checkmate'
        : candidate.isCapture
          ? 'capture'
          : candidate.isCastle
            ? 'castling'
            : candidate.isCheck
              ? 'check'
              : 'quiet move',
      strategic_purpose: candidate.purpose,
      risk: candidate.risk,
      engine_expected_line: candidate.pvText || candidate.san
    };
  }

  return {
    game: 'chess',
    you_play: side,
    opponent,
    position_fen: facts.fen,
    move_number: facts.fullmoveNumber,
    game_phase: facts.phase,
    material: {
      summary: facts.materialLabel,
      balance_in_pawns_from_your_side: facts.materialDeltaPawns
    },
    engine_search: {
      note: 'A full alpha-beta search with quiescence verified every candidate below. Treat these evaluations as fact and do not try to re-derive tactics.',
      depth_reached: search.depth,
      nodes_searched: search.nodes,
      engine_best_move: search.bestSan,
      engine_evaluation: evalInPawns(search.scoreCp),
      engine_main_line: search.pvText,
      forced_mate:
        search.mateInPlies !== undefined
          ? `Mate in ${Math.ceil(search.mateInPlies / 2)} moves`
          : 'none seen'
    },
    your_king: {
      square: facts.ourKing.square,
      status: facts.ourKing.exposure,
      shield_pawns: facts.ourKing.shieldPawns,
      escape_squares: facts.ourKing.escapeSquares,
      enemies_attacking_your_king_zone: facts.ourKing.attackers
    },
    enemy_king: {
      square: facts.enemyKing.square,
      status: facts.enemyKing.exposure,
      shield_pawns: facts.enemyKing.shieldPawns,
      escape_squares: facts.enemyKing.escapeSquares,
      your_pieces_attacking_their_king_zone: facts.enemyKing.attackers
    },
    structures: {
      passed_pawns: facts.passedPawns.length
        ? facts.passedPawns
            .map(
              (p) =>
                `${p.square} (${p.side === facts.sideToMove ? 'yours' : 'theirs'}, ${p.stepsToPromotion} step(s) to promotion)`
            )
            .join('; ')
        : 'none',
      pieces_attacked: facts.hangingPieces.length
        ? facts.hangingPieces
            .map((p) => `${p.side === facts.sideToMove ? 'yours' : 'theirs'}: ${p.piece} on ${p.square}`)
            .join('; ')
        : 'none'
    },
    recent_moves: input.moves.slice(-12).join(' ') || 'none',
    candidate_moves: candidateEntries
  };
}

/**
 * The whole request, in one batch.
 *
 * Two rules from the TypeSafe documentation drive the shape of this: questions
 * in the same call are independent and cannot see each other, so nothing here
 * depends on another answer; and a judgment that rests on several things is
 * split into one atomic question per thing, with the code — not the model —
 * deciding how much each one matters.
 */
export function buildQuestions(input: StrategyInput): QuestionSet {
  const { candidates, facts, search } = input;
  const side = facts.sideToMove === 'w' ? 'White' : 'Black';

  const planOptions: Record<string, unknown> = {};
  for (const candidate of candidates) {
    planOptions[candidate.san] = {
      what: `${candidate.san}: ${candidate.purpose}`,
      engine_evaluation: evalInPawns(candidate.scoreCp),
      engine_rank: candidate.rank,
      risk: candidate.risk,
      engine_expected_line: candidate.pvText || candidate.san
    };
  }
  planOptions.none_of_these = {
    what: 'None of the listed moves carries out the right plan',
    use_when:
      'Every candidate helps the opponent more than it helps you, and a quieter move the engine left out is what the position really needs',
    consequence: `Your code then plays the engine's own best move, ${search.bestSan}, and only keeps your strategic read`
  };

  const threatOptions: Record<string, unknown> = {
    true: {
      what: 'The opponent has a concrete threat that has to be dealt with on this move',
      examples: [
        'They are threatening mate next move',
        'They are attacking a piece of yours that would be lost',
        'They are about to promote a pawn'
      ]
    },
    false: {
      what: 'There is no threat that must be answered right now',
      not_for: 'A general worry about the opponent being active'
    }
  };

  const attackOptions: Record<string, unknown> = {
    true: {
      what: 'You have a real attack on the enemy king worth investing in now',
      examples: [
        'Several of your pieces already attack their king zone',
        'Their king has few escape squares'
      ]
    },
    false: {
      what: 'You have no realistic attack on the enemy king at the moment',
      not_for: 'A speculative idea that needs several more moves to prepare'
    }
  };

  return {
    plan: {
      type: 'choice',
      instructions: {
        question: `Which move best carries out the right plan for ${side} in this position?`,
        you_play: side,
        engine_note:
          'Every candidate below was verified by a full alpha-beta search with quiescence. Treat the evaluations as fact, and do not try to re-derive tactics.',
        focus:
          'Judge the strategic purpose of each move against the structure, the two kings and the material balance.',
        weigh_up: 'A small engine deficit is acceptable when the plan is clearly stronger and the risk is low.',
        avoid: [
          'A move that leaves one of your pieces loose',
          'Improving a piece that is already your best piece',
          'Trading into a worse endgame for no reason'
        ]
      },
      criteria: planOptions
    },
    strategic_priority: {
      type: 'choice',
      instructions: {
        question: `What is the single most important thing ${side} should be trying to do right now?`,
        inspect: 'the whole state, especially the two kings, the structures and the material balance',
        focus: 'Pick the plan that fits this position, not the one that sounds most aggressive.'
      },
      criteria: STRATEGIC_PRIORITIES
    },
    position_balance: {
      type: 'score',
      instructions: {
        question: `How does this position stand for ${side}?`,
        inspect: 'material, king safety, structures and piece activity together',
        focus: `Judge the position objectively from ${side}'s point of view.`
      },
      criteria: [
        'Clearly worse for you',
        'Slightly worse for you',
        'Balanced',
        'Slightly better for you',
        'Clearly better for you'
      ]
    },
    opponent_threat: {
      type: 'noul',
      instructions: {
        question: 'The opponent is threatening something that has to be answered on this move.',
        inspect: "the enemy king's reach, your loose pieces, and any passed pawn about to promote",
        focus: 'Only count threats the opponent can actually execute now or next move.'
      },
      criteria: threatOptions
    },
    attack_available: {
      type: 'noul',
      instructions: {
        question: 'You have a genuine attack on the enemy king available now.',
        inspect: 'your pieces attacking their king zone and how many escape squares their king has'
      },
      criteria: attackOptions
    },
    position_character: {
      type: 'choice',
      instructions: {
        question: 'What kind of position is this?',
        focus: 'Describe the position itself, not the move you would play.'
      },
      criteria: POSITION_CHARACTERS
    },
    forcing_level: {
      type: 'score',
      instructions: {
        question: 'How forcing and committal is the move you want to play?',
        focus:
          'A quiet improving move, a normal developing or repositioning move, or a forcing check, capture or mate threat.'
      },
      criteria: [
        'Quiet and flexible, keeping every option open',
        'A normal move that improves a piece or the structure',
        'Forcing: a check, a capture, or a direct mate threat'
      ]
    }
  };
}

/** Runs the single batched Jev request and normalises the answers. */
export async function askJev(
  client: TypeSafeClient,
  input: StrategyInput,
  signal?: AbortSignal
): Promise<StrategyOutput | null> {
  const state = buildState(input);
  const questions = buildQuestions(input);
  const result = await client.evaluate(state, questions, signal);

  const validMoves = new Set(input.candidates.map((candidate) => candidate.san));
  validMoves.add('none_of_these');

  const plan = result.answers.plan;
  let planChoice: string | null = null;
  let planConfidence = 0;
  const planProbabilities: Record<string, number> = {};
  if (plan && plan.type === 'choice') {
    planConfidence = plan.confidence;
    for (const [key, value] of Object.entries(plan.probabilities)) {
      if (validMoves.has(key)) planProbabilities[key] = value;
    }
    if (validMoves.has(plan.choice)) planChoice = plan.choice;
  }

  const priority = result.answers.strategic_priority;
  const strategicPriority =
    priority && priority.type === 'choice' && PRIORITY_KEYS.includes(priority.choice)
      ? priority.choice
      : null;

  const balance = result.answers.position_balance;
  const positionBalance = balance && balance.type === 'score' ? clamp(balance.score / 4, 0, 1) : null;

  const threat = result.answers.opponent_threat;
  const opponentThreat = threat && threat.type === 'noul' ? threat.noul : null;

  const attack = result.answers.attack_available;
  const attackAvailable = attack && attack.type === 'noul' ? attack.noul : null;

  const character = result.answers.position_character;
  const positionCharacter =
    character && character.type === 'choice' && character.choice in POSITION_CHARACTERS
      ? character.choice
      : null;

  const forcing = result.answers.forcing_level;
  const forcingLevel = forcing && forcing.type === 'score' ? clamp(forcing.score, 0, 2) : null;

  return {
    model: result.model,
    planChoice,
    planConfidence,
    planProbabilities,
    strategicPriority,
    positionBalance,
    opponentThreat,
    attackAvailable,
    positionCharacter,
    forcingLevel,
    latencyMs: result.latencyMs,
    requestId: result.requestId,
    inputTokens: result.usage?.inputTokens
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}