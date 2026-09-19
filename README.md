# Chess with Jev

A Chrome extension that reads the board on Chess.com plus a local Node backend that
decides what to play. The decision engine combines a real chess search with
**Jev**, TypeSafe AI's System One model.

---

## 1. Design in one picture

```
   SYSTEM 2 - deterministic, in server/src/engine/
   0x88 board, legal movegen, Zobrist TT, tapered eval,
   negamax alpha-beta + quiescence, iterative deepening.
   Decides what is TRUE: legal moves, tactical safety, the
   evaluation, whether there is a forced mate. Produces the
   shortlist of verified candidates.
                        |
                        | top N moves, each with an exact score and a real PV
                        v
   SYSTEM 1 - Jev, in server/src/brain/
   ONE batched request of narrow typed questions:
     choice  plan              (over candidates + "none_of_these")
     choice  strategic_priority
     score   position_balance / forcing_level
     noul    opponent_threat / attack_available
     choice  position_character
   Decides which verified move fits the STRATEGIC PLAN.
                        |
                        v
   CODE OWNS THE DECISION - fuseDecision
     forced mate              -> play it
     opening book             -> play theory
     engine far ahead / in check -> play the engine move
     otherwise -> Jev may pick, inside a trust window that grows
                  with its own confidence and is capped by an
                  absolute blunder ceiling
```

The rule the whole system follows: **the model supplies judgment, the search
supplies truth, and ordinary code makes the choice.**

---

## 2. Why the previous engine played badly

The previous `jevClient.ts` asked Jev to *"select the single best tactical and
strategic move"* from a flat list of **every legal move** (~35 options), with a
handful of hardcoded penalties behind it as a safety net. Measured problems:

| Symptom in the logs | Cause |
| --- | --- |
| The same FEN returned `Rd6`, `Rc8`, `Rd7`, `Bf5` across repeated calls | A long flat list of near-identical options gives the model almost nothing to discriminate on. TypeSafe's own skill-suggestion cookbook documents exactly this failure mode. |
| Confidence 0.13-0.40 | The model was genuinely torn, because nothing in the request told it which moves were safe. |
| Rook sorties in a position where Black was **already down a queen** | There was no search and no evaluation, so the engine could not tell a lost position from a level one. |
| `strategicTheme: king_hunt` on move 1 of a quiet game | The instructions pushed aggression ("if the enemy King is EXPOSED, prioritise Queen activation and direct attack") and the `king_hunt` criteria read as the attractive option. |
| `moveNumber: 1` on move 13 | `payload.moveCount` was usually unset, so phase detection (`moveCount <= 8` -> opening) was permanently stuck on "opening". |
| Hardcoded guardrails kept firing (`-1000` for back-rank rook moves, magic `heuristicScore` thresholds) | Those rules existed to compensate for the missing search. |

Also relevant: **`chess.js` generates only ~8.5k nodes/second** (measured:
perft(4) from the start position takes 23 s), so it cannot serve as a search
backbone at all.
---

## 3. What the new engine does

### System 2 - `server/src/engine/`

| File | Purpose |
| --- | --- |
| `constants.ts` | 0x88 squares, piece codes, packed move encoding, offset tables |
| `zobrist.ts` | Two independent 32-bit Zobrist hash tables from a fixed seed |
| `position.ts` | Board, FEN, make/unmake, attack detection, mobility, repetition |
| `movegen.ts` | Pseudo-legal generation, legality filtering, castling, en passant, perft |
| `pst.ts` | Piece-square tables (the published "simplified evaluation" set) |
| `evaluation.ts` | Tapered evaluation: material, PSTs, mobility, bishop pair, rook files, pawn structure, king shelter, tempo |
| `search.ts` | Negamax alpha-beta, iterative deepening, transposition table, quiescence, MVV-LVA, killers/history, check extension, null-move pruning, late move reductions, mate scores |

Measured speed: **~7.3M nodes/second** for perft, roughly **860x faster than
`chess.js`** - which is what makes depth 6-8 reachable inside a 2.5 s budget.

`chess.js` is still a dependency, but only at the edge: rendering SAN for the UI
and validating the opening book.

### System 1 - `server/src/brain/`

| File | Purpose |
| --- | --- |
| `typesafeClient.ts` | Typed System One client: retries, timeouts, answer normalisation |
| `positionFacts.ts` | Deterministic factual context: phase, king safety, passed pawns, loose pieces, material |
| `notation.ts` | SAN rendering and PV rendering |
| `jevStrategy.ts` | Builds the structured `state` and the batched question set |
| `openingBook.ts` | 36 theory lines, replayed and validated at startup |
| `chessBrain.ts` | Orchestration, decision fusion, rationale, scoring |

### Guardrails - the only place a move is chosen

| Rule | Effect |
| --- | --- |
| Forced mate found | Played immediately, the model is not consulted |
| Only one legal move | Played |
| Position is in the opening book | Book move played |
| Engine best is 120 cp ahead, or the king is in check | Engine move played |
| Jev's confidence < 0.30 | Model ignored, it is guessing |
| Jev's pick loses > 70 cp against the best | Rejected, engine move played |
| Jev's pick loses more than `40 * (0.5 + confidence)` cp | Rejected, engine move played |
| Jev answers `none_of_these` | Engine move played, Jev's strategic read retained |
| API unreachable or erroring | Engine moves only, the flow never breaks |

Every rejection is recorded in `jevOverrideReason` and printed in the rationale,
so the log explains itself instead of hiding a silent substitution.

---

## 4. The TypeSafe contract actually used

Verified against the official documentation at <https://docs.typesafe.ai> and the
Elixir client cheatsheet at <https://typesafe-api.hexdocs.pm/cheatsheet.html>:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json

{ "state": <string | object>, "model": "jev-latest",
  "questions": { "<id>": { "type": ..., "instructions": ..., "criteria": ... } } }
```

* Exactly three primitives exist: `noul` (P(true), no confidence), `choice` (1-255
  options; winner + full distribution + confidence), `score` (2-10 ordered levels;
  a fractional score + confidence).
* `instructions` is optional everywhere and may be a structured object. Field names
  such as `what`, `not_for` and `examples` are free-form and chosen by us.
* Many questions can go in **one** request (they are answered together and never see
  each other). That is the documented *speculative fan-out* pattern.
* `confidence` measures how peaked the distribution is, **not** correctness, so it is
  used here purely as a gate - the documented *confidence-gated routing* pattern.
* Jev is a snap-judgment model: no free-text output, no multi-step reasoning, no tool
  use. It is fed facts and asked for judgments, never asked to calculate.

---

## 5. Running it

```bash
npm run server            # backend, loads .env for TYPESAFE_API_KEY
npm run server:test       # hermetic test suite: 33 tests, no network
npm run server:test:live  # live end-to-end check against the real API
npm run server:build      # type-check
```

Both suites (`npm test` for the extension, `npm run server:test` for the backend)
are green.

---

## 6. Tuning

`ChessBrain` accepts options; the defaults live in `DEFAULT_OPTIONS` in
`server/src/brain/chessBrain.ts`.

```ts
new ChessBrain({
  searchTimeMs: 2200,        // engine budget per move
  searchMaxDepth: 12,        // hard depth cap
  candidateCount: 5,         // how many verified moves Jev sees
  trustWindowCp: 40,         // base latitude for Jev's pick
  maxAcceptableLossCp: 70,   // absolute blunder ceiling
  minPlanConfidence: 0.3,    // confidence gate
  forcingGapCp: 120,         // gap at which the engine decides alone
  useBook: true,
  bookPlies: 14
});
```

To compare `jev_plan` play against engine-only play, pass `useJev: false`. The
engine answers alone and every existing consumer keeps working unchanged.

---

## 7. Verification

| Check | Result |
| --- | --- |
| Perft against the 6 standard reference positions | All counts match, up to perft(5) = 4,865,609 from the start position |
| Differential legality test against `chess.js` over randomly played games | Move sets and resulting FENs identical at every ply |
| Evaluation colour symmetry (mirror test) | Identical scores for mirrored positions |
| Incremental Zobrist hash vs freshly computed | Identical after every move of a 60-ply random walk |
| Tactics: back-rank mate, scholar's mate, hanging queen, piece rescue | All found |
| Fusion guardrails (window, ceiling, confidence gate, rejection) | All behave as specified |
| Opening book legality at every node | No illegal suggestion, no unreplayable line |
| Live API | `jev-1.13.0` answers the batched request; `jev_plan` chosen at 0.93-0.99 confidence |
---

## 8. Board-state synchronisation (why suggestions used to appear on the wrong turn)

A recommendation is only meaningful if the extension knows **which position is on
the board and whose turn it is**. That chain had several holes.

### The failure that was reported

Mid-game, with the opponent thinking, the HUD would suddenly show a move. The
cause was in `FENTracker.extractCurrentState`:

```
moves = parseMoveList(moveListEl)        // transiently returns []
state = updateFromMoves(moves)           // -> START POSITION, turn 'w', moveCount 0
if (moves.length === 0 && domLooksLikeStart) return state   // <-- published anyway
```

Chess.com re-renders its move list on every ply, and the observer fired on every
intermediate step of that re-render. One unparseable reading was interpreted as
*"the game is at the starting position with White to move"*. Since the player was
White, `state.turn === playerColor` was true, so the extension asked the backend
for a move — and the backend answered for the side to move, which was the
opponent.

### The fixes, in the order they matter

| Fix | Where | What it prevents |
| --- | --- | --- |
| Unusable move list **never** resets a game in progress; the last verified state is reused verbatim (identical FEN, so nothing re-fires) | `fenTracker.resolveBoardState` | The start position appearing mid-game |
| A **regression guard**: a move list shorter than the best list seen so far, on a board whose pieces have not changed, is a parse hiccup, not a rewind | `fenTracker.resolveBoardState` | The tracker silently trailing the real game by a ply, and therefore reporting the wrong side to move |
| Positions that cannot be verified are flagged `isComplete: false` and **no advice is requested** for them | `fenTracker` → `content.ts` | Guessing on a half-read board |
| The turn comes from the verified move replay, never from how the board is displayed | `fenTracker` | A flipped board inverting who is to move |
| Castling rights in the DOM fallback are **derived from the pieces**, not hardcoded to `-` | `fenTracker.deriveCastlingRights` | The engine believing nobody may castle, and evaluating the game wrongly |
| `playerColor` is inferred once per position from the board's flip state and never re-flipped to match the side to move; a manual choice locks it | `content.ts` | Advice being issued for the opponent's turn |
| Perspective is sent to the backend, which **declines** when it is not that side's move | `BoardStatePayload.perspective`, `jevClient.waitingResult` | The opponent's best move being returned as yours |
| One request in flight per position, plus a `pendingFen` correlation token; a reply whose `fen` no longer matches the board is discarded | `content.ts`, `background.ts` | A 2-4 second old answer being applied to the new position |
| Replies are broadcast tagged with `fen` and `perspective`; a "not your turn" answer goes only to the socket that asked | `server.ts`, `background.ts` | Cross-tab and cross-game leakage |

### Why clicking a piece used to start a calculation

Three separate self-inflicted loops fed each other:

1. `MutationObserver` watched **all of `document.body`** with `childList: true`
   and `attributeFilter: ['class', 'data-node', 'data-figurine', 'style']`. Every
   click adds `.highlight` nodes and toggles `selected` classes, so a click always
   triggered a re-read.
2. The extension wrote to the DOM it was watching — the overlay SVG is appended
   *inside the board* and `drawMove()` replaces its `innerHTML`; the HUD sets
   `style.display` on every update. So **drawing an arrow triggered another
   board read**.
3. `scanDOMBoard()` (a walk over every `.piece`) ran on every one of those, even
   when the move list had already answered. `setInterval(checkBoard, 1000)` was
   also never cleared by `stop()`.

Fixes: mutations inside `#jev-chess-hud` and `.jev-board-overlay-svg` are ignored;
`style` is no longer observed; text-only churn (clocks) is filtered; the piece
scan is now lazy and only runs when the move list cannot answer or a regression
is possible; the board and move list are cached and only re-resolved when
detached; and the poll timer is owned and cleared by `stop()`.

### The settle gate

The observer no longer publishes a position the moment it reads one. A reading
must stand still for `SETTLE_MS` (300 ms) before it is published. If the reading
flaps between two values, **nothing is published at all** until it stabilises,
and a reading that matches what was last published cancels the pending one. A
flapping position can therefore no longer produce a request, a redraw, or a turn
change.

### New invariants covered by tests

`tests/fenTracker.test.ts` pins all of this down against the pure
`resolveBoardState` function, including the exact reported scenario:

* an unreadable move list mid-game keeps the previous FEN, turn and move count;
* an unreadable move list with an unreadable board keeps the correct side to move;
* a shorter-but-valid move list on an unchanged board does not rewind the position;
* a genuinely new game (pieces back on the start squares) is still detected;
* the DOM fallback derives `KQkq` instead of erasing castling rights;
* malformed layouts are rejected rather than turned into a bogus FEN.

`server/tests/turnGuard.test.ts` pins the backend behaviour: it declines when the
position is not the requesting side's turn, answers normally when it is, stays
backwards compatible when no perspective is supplied, and still reports a
finished game as game over.

### Watchdog and recovery

Every earlier freeze came from a guard that could block **forever**: a pending
request with no timeout, a cooldown that never expired, a debounce that never
fired. The new request machinery is built so that every guard is examined again
on each pulse (every 2 s), and the recovery rules are:

* `REQUEST_TIMEOUT_MS` (15 s) — a request older than this is abandoned; the FEN
  goes on a `RETRY_COOLDOWN_MS` (30 s) cooldown, after which the same position
  is re-asked automatically. A dead backend therefore costs one 15 s timeout
  plus one 30 s cooldown instead of freezing the panel forever.
* The watchdog re-examines the current state every pulse, so it also picks up
  positions that arrived *after* the request was abandoned.
* `noteReplyArrived()` clears both the pending token and the abandoned marker on
  any background reply, so recovery from a dead backend starts the moment the
  backend returns.
* A failed *send* (callback receives `chrome.runtime.lastError`) releases the
  token immediately — nothing left the tab, so retrying is safe.
* The debounce is coalescing (first mutation wins) rather than trailing, so
  mutation bursts cannot starve the board updates entirely; a 1.2 s poll is kept
  as a last-resort safety net, and a board-element swap resets the tracker.
* The HUD status shows *why* it is quiet: "Analyzing…" while a request is in
  flight, "Opponent's turn" for the other side, and the actual error text on
  failure — a stuck state is diagnosable instead of just looking broken.
* For manual recovery from the popup/console there are `FORCE_REEVALUATE` and
  `DIAGNOSTICS` extension messages, and `resetRequestMachineryForTest()`
  (covered by unit tests that step through each stuck scenario one guard at a
  time).

