import { BoardState, JevRecommendationState } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const turnSymbol = document.getElementById('turn-symbol');
  const turnText = document.getElementById('turn-text');
  const moveInfo = document.getElementById('move-info');
  const fenInput = document.getElementById('fen-input') as HTMLInputElement | null;
  const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement | null;
  const mateBadge = document.getElementById('mate-badge');
  const toggleHudBtn = document.getElementById('toggle-hud-btn');
  const statusLabel = document.getElementById('status-label');

  // Recommendation Elements
  const popupRecMove = document.getElementById('popup-rec-move');
  const popupLatency = document.getElementById('popup-latency');
  const popupConf = document.getElementById('popup-conf');
  const popupRecDetails = document.getElementById('popup-rec-details');
  const popupEvalTag = document.getElementById('popup-eval-tag');
  const popupDangerTag = document.getElementById('popup-danger-tag');

  // Server Status Elements
  const serverBadge = document.getElementById('server-status-badge');
  const serverText = document.getElementById('server-status-text');

  function renderServerStatus(connected: boolean) {
    if (serverBadge && serverText) {
      if (connected) {
        serverBadge.classList.remove('offline');
        serverText.textContent = 'Online';
      } else {
        serverBadge.classList.add('offline');
        serverText.textContent = 'Offline';
      }
    }
  }

  function renderState(state: BoardState | null) {
    if (!state) {
      if (statusLabel) statusLabel.textContent = 'Searching...';
      return;
    }

    if (statusLabel) statusLabel.textContent = 'Active';

    if (turnSymbol) turnSymbol.textContent = state.turn === 'w' ? '⚪' : '⚫';
    if (turnText) turnText.textContent = state.turn === 'w' ? 'White to move' : 'Black to move';
    if (moveInfo) moveInfo.textContent = `Move #${state.fullMoveNumber}`;

    if (fenInput) fenInput.value = state.fen;

    if (mateBadge) {
      if (state.isCheckmate) {
        mateBadge.textContent = 'CHECKMATE';
        mateBadge.style.display = 'inline';
      } else if (state.isCheck) {
        mateBadge.textContent = 'CHECK';
        mateBadge.style.display = 'inline';
      } else {
        mateBadge.style.display = 'none';
      }
    }
  }

  function renderRecommendation(rec: JevRecommendationState | null) {
    if (!rec) return;

    if (rec.status === 'analyzing') {
      if (popupRecMove) popupRecMove.textContent = 'Analyzing...';
      if (popupLatency) popupLatency.textContent = 'Thinking';
      if (popupConf) popupConf.style.display = 'none';
      if (popupRecDetails) popupRecDetails.style.display = 'none';
      return;
    }

    if (rec.status === 'ready' && rec.recommendedMove) {
      if (popupRecMove) {
        popupRecMove.innerHTML = `Play <span style="color: #67e8f9;">${rec.recommendedMove}</span>`;
      }

      if (popupConf && rec.confidence) {
        popupConf.textContent = `${Math.round(rec.confidence * 100)}% conf`;
        popupConf.style.display = 'inline-block';
      }

      if (popupLatency && rec.latencyMs !== undefined) {
        popupLatency.textContent = `${rec.latencyMs}ms`;
      }

      if (popupRecDetails) {
        popupRecDetails.style.display = 'flex';
      }

      if (popupEvalTag && rec.positionEvaluationLabel) {
        popupEvalTag.textContent = `Eval: ${rec.positionEvaluationLabel}`;
      }

      if (popupDangerTag) {
        popupDangerTag.style.display = rec.isTacticalDanger ? 'inline-block' : 'none';
      }
    }
  }

  // Copy button
  copyBtn?.addEventListener('click', () => {
    if (fenInput?.value) {
      navigator.clipboard.writeText(fenInput.value).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 1500);
      });
    }
  });

  // Toggle HUD button
  toggleHudBtn?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HUD' }).catch(() => {
        console.warn('Could not send TOGGLE_HUD message to tab.');
      });
    }
  });

  // Query background for current state
  chrome.runtime.sendMessage({ type: 'GET_CURRENT_STATE' }, (response) => {
    if (response) {
      if (response.state) renderState(response.state);
      if (response.recommendation) renderRecommendation(response.recommendation);
      if (response.serverConnected !== undefined) renderServerStatus(response.serverConnected);
    }
  });

  // Query active tab content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_STATE' }, (response) => {
        if (response) {
          if (response.state) renderState(response.state);
          if (response.serverConnected !== undefined) renderServerStatus(response.serverConnected);
        }
      });
    } catch {}
  }

  // Listen for live updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BOARD_STATE_UPDATED') {
      renderState(message.payload);
    }
    if (message.type === 'RECOMMENDATION_UPDATED') {
      renderRecommendation(message.payload);
    }
    if (message.type === 'SERVER_STATUS_CHANGED') {
      renderServerStatus(message.payload.connected);
    }
  });
});
