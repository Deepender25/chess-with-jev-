import fs from 'fs';
import path from 'path';
import { TelemetryLogEntry } from './types.js';

export class TelemetryLogger {
  private logDir: string;
  private logFile: string;

  constructor() {
    this.logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, 'game_telemetry.jsonl');
  }

  public logDecision(entry: TelemetryLogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFile(this.logFile, line, (err) => {
      if (err) {
        console.error('[TelemetryLogger] Failed to write telemetry log:', err);
      }
    });
  }

  public getRecentLogs(limit = 50): TelemetryLogEntry[] {
    if (!fs.existsSync(this.logFile)) {
      return [];
    }
    try {
      const content = fs.readFileSync(this.logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
