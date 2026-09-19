import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { JevChessEngine } from './jevClient.js';
import { TelemetryLogger } from './telemetry.js';
import { EvalCoalescer } from './evalCoalescer.js';
import { BoardStatePayload, EvaluateResponse, JevDecisionResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });
dotenv.config({ path: path.resolve(__dirname, '../../server/.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static dashboard
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const jevEngine = new JevChessEngine();
const telemetry = new TelemetryLogger();

/**
 * Evaluation requests are deduplicated per position: while one evaluation is in
 * flight, identical asks (the extension re-asking after a timeout, both tabs on
 * the same game, the dashboard) join the same promise instead of starting a
 * second engine run, and a finished result is served for a short while. This
 * roughly halves the worst-case latency when a position is asked for twice.
 */
const evalCoalescer = new EvalCoalescer<JevDecisionResult>(5000);

/** Cache/in-flight key for one position and perspective. */
function evalKey(payload: BoardStatePayload): string {
  return `${payload.fen}|${payload.perspective ?? ''}`;
}

// Dashboard Routes
app.get(['/', '/dashboard'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard.html'));
});

// REST Endpoints
app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    status: 'ok',
    service: 'chess-with-jev-backend',
    port: PORT,
    timestamp: Date.now(),
    model: process.env.JEV_MODEL || 'jev-latest',
    hasApiKey: Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim().length > 5)
  });
});

app.post('/api/evaluate', async (req, res) => {
  try {
    const payload = req.body as BoardStatePayload;
    if (!payload || !payload.fen) {
      res.status(400).json({ success: false, error: 'Missing FEN in request body.' });
      return;
    }

    const decision = await evalCoalescer.run(evalKey(payload), () =>
      jevEngine.evaluatePosition(payload)
    );

    // Record telemetry
    telemetry.logDecision({
      moveNumber: payload.fullMoveNumber || 1,
      fen: payload.fen,
      sideToMove: payload.turn,
      recommendedMove: decision.recommendedMove,
      fromSquare: decision.fromSquare,
      toSquare: decision.toSquare,
      confidence: decision.confidence,
      topCandidates: decision.topCandidates,
      positionScore: decision.positionScore,
      isTacticalDanger: decision.isTacticalDanger,
      strategicTheme: decision.strategicTheme,
      strategicRationale: decision.strategicRationale,
      latencyMs: decision.latencyMs,
      isSimulated: decision.isSimulated,
      timestamp: new Date().toISOString()
    });

    const response: EvaluateResponse = {
      success: true,
      fen: payload.fen,
      decision
    };

    res.json(response);
  } catch (err: any) {
    console.error('[Server] /api/evaluate error:', err);
    res.status(500).json({ success: false, error: err.message || 'Evaluation failed.' });
  }
});

app.get('/api/logs', (_req, res) => {
  res.json({ logs: telemetry.getRecentLogs(50) });
});

// WebSocket Handling
wss.on('connection', (ws: WebSocket) => {
  console.log('[WebSocket] Client connected.');

  ws.send(JSON.stringify({
    type: 'CONNECTION_ACK',
    payload: {
      status: 'ready',
      message: 'Connected to Jev Decision Backend Server'
    }
  }));

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'EVALUATE_POSITION' && message.payload?.fen) {
        const payload = message.payload as BoardStatePayload;
        console.log(
          `[WebSocket] Evaluating position: Turn=${payload.turn}, Move=#${payload.fullMoveNumber || 1}` +
            (payload.perspective ? `, perspective=${payload.perspective}` : '')
        );

        const decision = await evalCoalescer.run(evalKey(payload), () =>
          jevEngine.evaluatePosition(payload)
        );

        telemetry.logDecision({
          moveNumber: payload.fullMoveNumber || 1,
          fen: payload.fen,
          sideToMove: payload.turn,
          recommendedMove: decision.recommendedMove,
          fromSquare: decision.fromSquare,
          toSquare: decision.toSquare,
          confidence: decision.confidence,
          topCandidates: decision.topCandidates,
          positionScore: decision.positionScore,
          isTacticalDanger: decision.isTacticalDanger,
          strategicTheme: decision.strategicTheme,
          strategicRationale: decision.strategicRationale,
          latencyMs: decision.latencyMs,
          isSimulated: decision.isSimulated,
          timestamp: new Date().toISOString()
        });

        // A "not your turn" answer is only meaningful to the client that asked
        // for it, so it is returned to that socket alone. Broadcasting it would
        // clear the arrow in every other open game.
        if (decision.waitingForOpponent) {
          ws.send(JSON.stringify({
            type: 'RECOMMENDATION',
            payload: { fen: payload.fen, perspective: payload.perspective, decision }
          }));
          return;
        }

        // Broadcast the recommendation to all connected clients (tabs and dashboard)
        const broadcastPayload = JSON.stringify({
          type: 'RECOMMENDATION',
          payload: {
            fen: payload.fen,
            perspective: payload.perspective,
            decision
          }
        });

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(broadcastPayload);
          }
        });
      }
    } catch (err) {
      console.error('[WebSocket] Error processing message:', err);
      ws.send(JSON.stringify({
        type: 'ERROR',
        payload: { error: 'Failed to evaluate position.' }
      }));
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected.');
  });
});

export { app, httpServer, wss };

// Start Server if executed directly
if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`⚡ CHESS WITH JEV - BACKEND SERVER ACTIVE`);
    console.log(`📡 HTTP Server:    http://localhost:${PORT}`);
    console.log(`🔌 WebSocket:      ws://localhost:${PORT}`);
    console.log(`📊 Live Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🛡️  Health Check:   http://localhost:${PORT}/health`);
    console.log(`======================================================\n`);
  });
}
