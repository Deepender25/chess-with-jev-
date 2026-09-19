import { BoardState, ExtensionMessage, JevDecisionResult, JevRecommendationState } from '../types';

let latestBoardState: BoardState | null = null;
let latestRecommendation: JevRecommendationState | null = null;
let isServerConnected = false;
let socket: WebSocket | null = null;
let reconnectTimer: any = null;

/**
 * Position of the request currently outstanding, and a monotonically increasing
 * request id. Both are used to drop out-of-order replies: a recommendation for
 * an older position must never overwrite a newer one, which is what previously
 * let a stale answer appear as the current move.
 */
let inFlightFen: string | null = null;
let requestSequence = 0;
let latestAppliedSequence = 0;

const SERVER_WS_URL = 'ws://localhost:8765';
const SERVER_HTTP_URL = 'http://localhost:8765/api/evaluate';

console.log('[Chess with Jev] Background service worker initialized.');

function broadcastToTabs(message: any) {
  chrome.tabs.query({ url: '*://*.chess.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  });
}

function connectBackend() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    socket = new WebSocket(SERVER_WS_URL);

    socket.onopen = () => {
      console.log('[Background] Connected to local backend WebSocket on port 8765.');
      isServerConnected = true;
      broadcastToTabs({
        type: 'SERVER_STATUS_CHANGED',
        payload: { connected: true, url: SERVER_WS_URL }
      });

      // Re-evaluate if we have an active board state — but only when it is
      // genuinely the human's turn. Without this guard, every socket reconnect
      // asked the backend for a move for whoever happened to be on move,
      // which is how the opponent's move ended up being shown as ours.
      if (
        latestBoardState &&
        !latestBoardState.isGameOver &&
        latestBoardState.perspective &&
        latestBoardState.turn === latestBoardState.perspective
      ) {
        evaluateViaBackend(latestBoardState);
      }
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'RECOMMENDATION' && data.payload?.decision) {
          const fen: string | undefined = data.payload.fen;
          handleDecision(data.payload.decision as JevDecisionResult, fen, latestBoardState?.perspective);
        }
      } catch (err) {
        console.error('[Background] Error parsing WebSocket message:', err);
      }
    };

    socket.onclose = () => {
      isServerConnected = false;
      broadcastToTabs({
        type: 'SERVER_STATUS_CHANGED',
        payload: { connected: false }
      });
      reconnectTimer = setTimeout(connectBackend, 2000);
    };

    socket.onerror = () => {
      isServerConnected = false;
      broadcastToTabs({
        type: 'SERVER_STATUS_CHANGED',
        payload: { connected: false }
      });
    };
  } catch (err) {
    isServerConnected = false;
    broadcastToTabs({
      type: 'SERVER_STATUS_CHANGED',
      payload: { connected: false }
    });
    reconnectTimer = setTimeout(connectBackend, 2000);
  }
}

/* -------------------------------------------------------------------------- */
/* Request / reply correlation                                                */
/* -------------------------------------------------------------------------- */

/**
 * Converts a backend decision into the shape the UI consumes, tagging it with
 * the position it was computed for.
 *
 * `fen` and `perspective` are the important additions: they let the content
 * script verify that a reply is about the board currently on screen before it
 * shows anything.
 */
function toRecommendationState(
  decision: JevDecisionResult,
  fen: string | undefined,
  perspective: 'w' | 'b' | undefined
): JevRecommendationState {
  return {
    recommendedMove: decision.recommendedMove,
    fromSquare: decision.fromSquare,
    toSquare: decision.toSquare,
    confidence: decision.confidence,
    topCandidates: decision.topCandidates,
    positionScore: decision.positionScore,
    positionEvaluationLabel: decision.positionEvaluationLabel,
    isTacticalDanger: decision.isTacticalDanger,
    tacticalDangerProbability: decision.tacticalDangerProbability,
    isCheckmateOpportunity: decision.isCheckmateOpportunity,
    strategicTheme: decision.strategicTheme,
    strategicRationale: decision.strategicRationale,
    promotionAlert: decision.promotionAlert,
    materialDelta: decision.materialDelta,
    latencyMs: decision.latencyMs,
    isSimulated: decision.isSimulated,
    status: decision.recommendedMove ? 'ready' : 'idle',
    fen,
    perspective,
    decisionPath: decision.decisionPath,
    engineDepth: decision.engineDepth,
    engineEvalPawns: decision.engineEvalPawns,
    jevPlan: decision.jevPlan,
    jevPlanConfidence: decision.jevPlanConfidence,
    jevOverrideReason: decision.jevOverrideReason
  };
}

/**
 * Forwards a decision to the tabs, after checking it is still relevant.
 *
 * Without this, a slow answer (search plus model is 2-4 seconds) computed for a
 * position the player has already left would be applied as if it were current.
 * The check is deliberately conservative: an unmatched position still reaches
 * the content script, which owns the authoritative board state and will reject
 * it there — but it is not stored as the latest recommendation, so the popup
 * cannot show a stale move either.
 */
function handleDecision(
  decision: JevDecisionResult,
  fen: string | undefined,
  perspective: 'w' | 'b' | undefined
): void {
  const recState = toRecommendationState(decision, fen, perspective);

  const isCurrentPosition = fen !== undefined && fen === latestBoardState?.fen;

  if (inFlightFen !== null && fen === inFlightFen) {
    inFlightFen = null;
  }

  if (isCurrentPosition) {
    latestAppliedSequence = requestSequence;
    latestRecommendation = recState;
  }

  broadcastToTabs({ type: 'RECOMMENDATION_UPDATED', payload: recState });
}

async function evaluateViaBackend(state: BoardState) {
  inFlightFen = state.fen;
  requestSequence++;

  // 1. Try WebSocket
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: 'EVALUATE_POSITION',
        payload: state
      })
    );
    return;
  }

  // 2. HTTP Fallback
  try {
    const res = await fetch(SERVER_HTTP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.decision) {
        isServerConnected = true;
        broadcastToTabs({
          type: 'SERVER_STATUS_CHANGED',
          payload: { connected: true }
        });
        handleDecision(data.decision as JevDecisionResult, state.fen, state.perspective);
        return;
      }
    }
  } catch (err) {
    console.debug('[Background] Backend evaluation error:', err);
    broadcastToTabs({
      type: 'SERVER_STATUS_CHANGED',
      payload: { connected: false }
    });
    broadcastToTabs({
      type: 'RECOMMENDATION_UPDATED',
      payload: { status: 'error', errorMessage: 'Backend offline' }
    });
  }
}

// Start connection
connectBackend();

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message.type === 'BOARD_STATE_UPDATED') {
    const incoming = message.payload as BoardState;
    latestBoardState = incoming;

    if (sender.tab?.id) {
      chrome.action.setBadgeText({
        text: incoming.fullMoveNumber ? `${incoming.fullMoveNumber}` : '',
        tabId: sender.tab.id
      });
      chrome.action.setBadgeBackgroundColor({
        color: incoming.turn === 'w' ? '#6366f1' : '#1e1b4b',
        tabId: sender.tab.id
      });
    }

    // Only ask the backend when it really is the human's move. This is the last
    // line of defence: even if the content script's state were wrong, the
    // backend is never asked for the opponent's best move.
    const isOurTurn = !!incoming.perspective && incoming.turn === incoming.perspective;

    if (!incoming.isGameOver && incoming.isComplete && isOurTurn) {
      evaluateViaBackend(incoming);
    } else if (!isOurTurn) {
      // Not our move: drop any outstanding request so a late answer cannot be
      // mistaken for the current one.
      inFlightFen = null;
    }

    sendResponse({ status: 'ok', serverConnected: isServerConnected });
    return true;
  }

  if (message.type === 'EVALUATE_POSITION' && message.payload) {
    latestBoardState = message.payload;
    evaluateViaBackend(message.payload);
    sendResponse({ status: 'evaluating' });
    return true;
  }

  if (message.type === 'GET_CURRENT_STATE') {
    sendResponse({
      state: latestBoardState,
      recommendation: latestRecommendation,
      serverConnected: isServerConnected
    });
    return true;
  }
});
