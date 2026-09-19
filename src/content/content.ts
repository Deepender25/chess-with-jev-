import { InPageHUD } from './hud';
import { ChessBoardObserver } from './observer';
import { findChessBoardElement } from '../lib/domScanner';
import { BoardState, Color, ExtensionMessage, JevRecommendationState } from '../types';

console.log('[Chess with Jev] Content script initializing...');

let hud: InPageHUD | null = null;
let observer: ChessBoardObserver | null = null;
let isHudVisible = true;
let isConnectedToBackend = false;

/** The side the human is playing. */
let playerColor: Color = 'w';
/** The side we are currently willing to advise, resolved per position. */
let activePerspective: Color = 'w';

/**
 * The FEN of the request currently outstanding, and when it was sent. The
 * timestamp is what makes a lost reply recoverable instead of fatal.
 */
let pendingFen: string | null = null;
let pendingSince = 0;
/** The FEN whose recommendation is being displayed right now. */
let displayedFen: string | null = null;

/**
 * How long to wait for a reply before giving up on it. Search plus model is
 * 2-4 seconds in practice, so this is generous; its purpose is only to guarantee
 * that a dropped message, an asleep service worker or a crashed backend cannot
 * leave the panel stuck on "Analyzing..." forever.
 */
const REQUEST_TIMEOUT_MS = 15000;

/** FENs we have already asked about and given up on. Emptied when a reply arrives. */
let abandonedFen: string | null = null;
/** When the current abandonment happened. The watchdog retries after this cooldown. */
let abandonedAt = 0;

/**
 * Minimum silence after the watchdog gives up on a request before the same
 * position is asked for again. Without a cooldown a dead backend turns into an
 * infinite request loop; without a retry it turns into a permanently frozen
 * panel. Thirty seconds is the middle of that trade-off.
 */
const RETRY_COOLDOWN_MS = 30000;

function clearPending(): void {
  pendingFen = null;
  pendingSince = 0;
}

/** Compact snapshot of the request machinery, for tests and the console. */
export function requestProgress(): string {
  const short = (fen: string | null) => (fen === null ? null : fen.slice(0, 24));
  return JSON.stringify({
    pendingFen: short(pendingFen),
    displayedFen: short(displayedFen),
    abandonedFen: short(abandonedFen),
    playerColor,
    activePerspective,
    connected: isConnectedToBackend
  });
}

/**
 * Totally resets the request machinery. Only the colour lock survives, because
 * that is a deliberate human choice rather than transient machinery state.
 * Covered by unit tests that step through stuck scenarios one guard at a time.
 */
export function resetRequestMachineryForTest(): void {
  clearPending();
  displayedFen = null;
  abandonedFen = null;
  abandonedAt = 0;
  isConnectedToBackend = false;
  isHudVisible = true;
}

/** A reply arrived: anything we had given up on is worth trying again. */
function noteReplyArrived(): void {
  clearPending();
  abandonedFen = null;
  abandonedAt = 0;
}

function init() {
  hud = new InPageHUD((selectedColor) => {
    playerColor = selectedColor;
    playerColorIsManual = true;
    activePerspective = selectedColor;
    console.log('[Chess with Jev] Player colour set by hand:', playerColor);

    // A manual change invalidates anything in flight and on screen.
    pendingFen = null;
    displayedFen = null;
    hud?.clearRecommendation();
    hud?.setPlayerColor(playerColor);

    const currentState = observer?.getCurrentState();
    if (currentState) handleBoardState(currentState);
  });

  chrome.runtime.sendMessage({ type: 'GET_CURRENT_STATE' }, (response) => {
    if (response && response.serverConnected !== undefined) {
      isConnectedToBackend = response.serverConnected;
      hud?.setServerStatus(response.serverConnected);
    }
  });

  observer = new ChessBoardObserver(handleBoardState);
  observer.start();

  // The watchdog normally runs off board updates, but when the board goes quiet
  // — exactly when the panel is most suspicious — nothing calls it. A cheap
  // two-second pulse closes the last route to a permanently frozen UI.
  window.setInterval(() => {
    try {
      const state = observer?.getCurrentState();
      if (state) handleBoardState(state);
      else watchdog(Date.now());
    } catch (err) {
      console.debug('[Chess with Jev] Watchdog pulse error:', err);
    }
  }, 2000);

  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (message.type === 'SERVER_STATUS_CHANGED') {
      isConnectedToBackend = message.payload.connected;
      hud?.setServerStatus(message.payload.connected);
      sendResponse({ status: 'ok' });
      return true;
    }

    if (message.type === 'RECOMMENDATION_UPDATED') {
      acceptRecommendation(message.payload as JevRecommendationState);
      sendResponse({ status: 'ok' });
      return true;
    }

    if (message.type === 'GET_CURRENT_STATE') {
      const currentState = observer?.getCurrentState();
      sendResponse({
        state: currentState,
        serverConnected: isConnectedToBackend,
        playerColor,
        perspective: activePerspective
      });
      return true;
    }

    if (message.type === 'GET_CURRENT_RECOMMENDATION') {
      sendResponse({ recommendation: hud?.getLatestRecommendation() ?? null });
      return true;
    }

    if (message.type === 'DIAGNOSTICS') {
      sendResponse({
        progress: requestProgress(),
        hudAvailable: hud !== null,
        boardSource: observer?.describeSource() ?? null,
        state: observer?.getCurrentState() ?? null
      });
      return true;
    }

    if (message.type === 'FORCE_REEVALUATE') {
      const currentState = observer?.getCurrentState();
      if (currentState) {
        displayedFen = null;
        abandonedFen = null;
        abandonedAt = 0;
        handleBoardState(currentState);
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    if (message.type === 'TOGGLE_HUD') {
      isHudVisible = message.payload !== undefined ? message.payload : !isHudVisible;
      hud?.setVisible(isHudVisible);
      sendResponse({ visible: isHudVisible });
      return true;
    }
  });

  console.log('[Chess with Jev] Content script active & synchronized.');
}

/* -------------------------------------------------------------------------- */
/* Perspective                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which side the human is playing, read from how the board is displayed.
 *
 * On Chess.com your own pieces are always at the bottom, so the board's flip
 * state is the authoritative signal. The walk covers a few ancestors because the
 * flip class sometimes lives on a wrapper rather than the board element itself.
 *
 * Returns null when nothing could be read; callers must treat that as "unknown"
 * rather than guessing, because guessing is what previously produced advice
 * while the opponent was still thinking.
 */
export function detectBoardOrientation(boardEl: HTMLElement | null): Color | null {
  return orientationFromSignals(readOrientationSignals(boardEl), boardEl);
}

/**
 * Turns raw orientation signals into a colour. Split out so the priority —
 * flip marker beats attribute beats inner-grid class beats default — is tested
 * directly instead of only through a live page.
 */
export function orientationFromSignals(
  signals: { flipped: boolean; orientation: string | null },
  boardEl: HTMLElement | null
): Color | null {
  // 1. An explicit flip marker anywhere up to three levels above the board.
  if (signals.flipped) return 'b';

  // 2. Chess.com's white/black orientation attribute, read the same way.
  if (signals.orientation === 'black') return 'b';
  if (signals.orientation === 'white') return 'w';

  // 3. As a last resort, the class is sometimes only on the inner square grid.
  if (boardEl && boardEl.querySelector('.flipped')) return 'b';

  return boardEl ? 'w' : null;
}

/** Every orientation signal, read once so callers and tests can reuse it. */
export function readOrientationSignals(boardEl: HTMLElement | null): {
  flipped: boolean;
  orientation: string | null;
  checked: number;
} {
  let flipped = false;
  let orientation: string | null = null;
  let checked = 0;

  let el: HTMLElement | null = boardEl;
  for (let depth = 0; el && depth < 4; depth++) {
    checked++;
    if (el.classList?.contains('flipped')) flipped = true;
    const attr = el.getAttribute?.('orientation');
    if (attr === 'black' || attr === 'white') orientation = attr;
    el = el.parentElement;
  }

  return { flipped, orientation, checked };
}

/**
 * Decides whose advice makes sense for this position.
 *
 * Note what this deliberately does *not* do: it never flips the perspective to
 * match the side to move. Doing so would make every position "our turn", which
 * is exactly the bug being fixed here. When the human's colour is genuinely
 * unknown the extension stays silent rather than guessing — a fail-safe, not a
 * fail-wrong.
 */
function resolvePerspective(): Color {
  return playerColor;
}
/** True once the human has chosen a side by hand; auto-detection stops then. */
let playerColorIsManual = false;

/* -------------------------------------------------------------------------- */
/* Board state handling                                                       */
/* -------------------------------------------------------------------------- */

function handleBoardState(state: BoardState): void {
  hud?.updateBoardState(state);

  // The position under observation changed: any previous give-up expires.
  // Holding a retry block past a position change is how the panel used to sit
  // on an error while the game moved on without it.
  if (state.fen !== abandonedFen) {
    abandonedFen = null;
    abandonedAt = 0;
  }

  // Enforce the request timeout and re-ask when it is genuinely our move but
  // nothing is outstanding. This is what stops every "stuck" state: no guard
  // can block and never release, because the watchdog re-examines the position
  // on every update.
  watchdog(Date.now());

  // A new game: forget everything tied to the previous one.
  if (state.sources === 'start' && state.moveCount === 0) {
    pendingFen = null;
    displayedFen = null;
    hud?.clearRecommendation();
  }

  // A carried-over state carries no new information at all. Do nothing, so a
  // transient DOM hiccup cannot clear or change what is on screen.
  if (state.sources === 'carried-over') {
    return;
  }

  // Keep the inferred player colour in step with how the board is displayed.
  if (!playerColorIsManual) {
    const boardElement = findChessBoardElement();
    const detected = detectBoardOrientation(boardElement);
    if (detected && detected !== playerColor) {
      const wasRequesting = pendingFen !== null;
      playerColor = detected;
      hud?.setPlayerColor(playerColor);
      // The colour changed, so anything outstanding or on screen belongs to the
      // other side. Asking again is safe: requestEvaluation short-circuits for
      // a FEN it has already requested or is already showing.
      clearPending();
      displayedFen = null;
      abandonedFen = null;
      abandonedAt = 0;
      hud?.clearRecommendation();
      if (wasRequesting) requestEvaluation(state, playerColor);
    }
  }

  const perspective = resolvePerspective();
  activePerspective = perspective;

  if (state.isGameOver) {
    pendingFen = null;
    displayedFen = null;
    hud?.updateRecommendation({ status: 'idle', errorMessage: 'Game over', fen: state.fen });
    return;
  }

  // The position could not be fully verified (a move failed to parse, or the
  // turn had to be inferred). Withholding advice is the only honest option.
  if (!state.isComplete) {
    pendingFen = null;
    hud?.updateRecommendation({
      status: 'idle',
      errorMessage: 'Syncing board...',
      fen: state.fen,
      perspective
    });
    return;
  }

  if (state.turn !== perspective) {
    // It is the opponent's move: never request, and clear any arrow left over.
    pendingFen = null;
    displayedFen = null;
    hud?.updateRecommendation({
      status: 'idle',
      errorMessage: "Opponent's turn",
      fen: state.fen,
      perspective
    });
    return;
  }

  requestEvaluation(state, perspective);
}

/**
 * The watchdog.
 *
 * Every stuck state this extension has ever had came from a guard that could
 * block and never release: a request token that was never cleared, a cached DOM
 * node that went stale, a withheld verdict that was never revisited. Rather than
 * trying to enumerate them, this runs on every board update and simply asks:
 * "if it is genuinely our move and we have nothing for this position, why are we
 * not asking?" — then asks. Any future guard that blocks too long heals itself
 * within one tick.
 */
function watchdog(now: number): void {
  if (pendingFen !== null) {
    if (now - pendingSince < REQUEST_TIMEOUT_MS) return;
    // Timed out with nothing to show. Park this position behind a cooldown so a
    // dead backend is not hammered, but keep the door open: the next update
    // after the cooldown retries the exact same position.
    console.warn('[Chess with Jev] No reply for', pendingFen, '- backing off');
    abandonedFen = pendingFen;
    abandonedAt = now;
    clearPending();
    hud?.setServerStatus(false);
  }

  const state = observer?.getCurrentState();
  if (!state || state.isGameOver || state.sources === 'carried-over') return;
  if (!state.isComplete) return;
  if (state.turn !== activePerspective) return;
  if (displayedFen === state.fen) return;

  // A position whose answer timed out is not asked about constantly; it is
  // asked about again once, after the cooldown, in case the backend recovered.
  if (abandonedFen === state.fen && now - abandonedAt < RETRY_COOLDOWN_MS) return;

  requestEvaluation(state, activePerspective);
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

function requestEvaluation(state: BoardState, perspective: Color): void {
  // Already asked about this exact position (or already showing its answer).
  if (pendingFen === state.fen) return;
  if (displayedFen === state.fen) return;

  pendingFen = state.fen;
  pendingSince = Date.now();
  hud?.updateRecommendation({ status: 'analyzing', fen: state.fen, perspective });

  try {
    chrome.runtime.sendMessage(
      {
        type: 'BOARD_STATE_UPDATED',
        payload: { ...state, perspective }
      },
      (res) => {
        if (chrome.runtime.lastError) {
          // The send callback itself failing (for example a disconnected port)
          // means nothing left this tab at all. Release the token so the
          // watchdog can try again on the next tick, instead of sitting on a
          // request that never reached anyone.
          if (pendingFen === state.fen) clearPending();
          return;
        }
        if (res?.serverConnected === false) {
          // The send reached the worker but the backend is unreachable. Keep the
          // token until the watchdog times it out UNLESS the FEN changed; the
          // watchdog owns the retry, and releasing here would re-fire every tick.
          return;
        }
        if (res?.serverConnected !== undefined) {
          hud?.setServerStatus(res.serverConnected);
        }
      }
    );
  } catch (err) {
    clearPending();
    console.debug('[Chess with Jev] Background send error:', err);
  }
}

/**
 * Accepts a recommendation only if it is still about the board in front of the
 * player. Without this check a slow answer (search plus model is 2-4 seconds)
 * computed for an older position would be shown as the current move.
 */
function acceptRecommendation(rec: JevRecommendationState): void {
  const currentState = observer?.getCurrentState();
  if (!currentState) return;

  // A reply that proves itself to be for a different position while our own
  // request is still outstanding leaves our token alone: our answer may still
  // be travelling.
  if (rec.fen && pendingFen !== null && rec.fen !== pendingFen) {
    return;
  }

  // Any other terminal reply releases our request token. That covers our own
  // answer *and* legacy messages with no position attached: an error can never
  // grow into an answer, so sitting on the token past it would freeze the
  // panel on "Analyzing...". This single change closes the stuck-on-analyzing
  // failure.
  noteReplyArrived();

  if (rec.fen && rec.fen !== currentState.fen) {
    console.debug('[Chess with Jev] Discarding stale recommendation for', rec.fen);
    return;
  }

  if (rec.perspective && rec.perspective !== activePerspective) return;

  if (rec.waitingForOpponent) {
    // The backend declined because the position is not ours to move. Clear the
    // request token and the panel, so the UI cannot sit on "Analyzing..." for a
    // position nobody is going to answer.
    if (rec.fen && pendingFen === rec.fen) pendingFen = null;
    displayedFen = null;
    hud?.updateRecommendation({
      status: 'idle',
      errorMessage: "Opponent's turn",
      fen: rec.fen,
      perspective: activePerspective
    });
    return;
  }

  if (currentState.isGameOver) return;
  if (!currentState.isComplete) return;

  if (currentState.turn !== activePerspective) {
    // The turn moved on while the answer was travelling.
    if (rec.fen) displayedFen = null;
    return;
  }

  if (rec.status === 'ready' && rec.recommendedMove) {
    displayedFen = rec.fen ?? currentState.fen;
  } else if (rec.status === 'error') {
    displayedFen = null;
  }

  hud?.updateRecommendation(rec);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}