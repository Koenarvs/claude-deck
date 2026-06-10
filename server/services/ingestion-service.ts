import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import logger from '../logger';
import { buildModelUsageRow, type ModelTokenInput } from './model-usage-row';

export async function ingestAllSessions(db: Database.Database, projectsDir: string): Promise<void> {
  if (!existsSync(projectsDir)) return;

  const existingRows = new Map<string, number>();
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'").get();
  if (hasTable) {
    const rows = db.prepare('SELECT session_id, message_count FROM session_usage').all() as Array<{ session_id: string; message_count: number }>;
    for (const row of rows) existingRows.set(row.session_id, row.message_count);
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO session_usage
    (session_id, project_dir, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, message_count, session_date, first_message_at, last_message_at, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertModel = db.prepare(`
    INSERT OR REPLACE INTO session_model_usage
      (session_id, model, tier, provider, input_tokens, cache_creation_tokens,
       cache_read_tokens, output_tokens, total_tokens, estimated_cost_usd, unpriced,
       message_count, session_date, first_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let projects: string[];
  try { projects = readdirSync(projectsDir); } catch { return; }

  for (const project of projects) {
    const projectDir = join(projectsDir, project);
    let entries: string[];
    try { entries = readdirSync(projectDir); } catch { continue; }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.replace('.jsonl', '');
      const filePath = join(projectDir, entry);

      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

      let inputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let outputTokens = 0;
      let messageCount = 0;
      let firstTimestamp = 0;
      let lastTimestamp = 0;
      let detectedModel: string | null = null;
      const byModel = new Map<string, ModelTokenInput>();

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          if (!detectedModel) {
            if (parsed?.type === 'system' && parsed?.subtype === 'init' && parsed?.model) {
              detectedModel = parsed.model as string;
            } else if (parsed?.model) {
              detectedModel = parsed.model as string;
            }
          }

          if (parsed?.timestamp) {
            const ts = typeof parsed.timestamp === 'string'
              ? new Date(parsed.timestamp).getTime()
              : parsed.timestamp as number;
            if (!isNaN(ts) && ts > 0) {
              if (firstTimestamp === 0) firstTimestamp = ts;
              lastTimestamp = ts;
            }
          }

          const usage = parsed?.message?.usage;
          if (!usage) continue;

          const inp = (usage.input_tokens as number) ?? 0;
          const cc = (usage.cache_creation_input_tokens as number) ?? 0;
          const cr = (usage.cache_read_input_tokens as number) ?? 0;
          const out = (usage.output_tokens as number) ?? 0;

          inputTokens += inp;
          cacheCreationTokens += cc;
          cacheReadTokens += cr;
          outputTokens += out;
          messageCount++;

          // Attribute this message to its own model (subagents / mid-session switch).
          const msgModel = (parsed?.message?.model as string | undefined) ?? detectedModel ?? 'unknown';
          const acc = byModel.get(msgModel) ?? { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, messageCount: 0 };
          acc.input += inp; acc.cacheCreation += cc; acc.cacheRead += cr; acc.output += out; acc.messageCount++;
          byModel.set(msgModel, acc);
        } catch { /* skip malformed lines */ }
      }

      if (messageCount === 0) continue;

      const existingCount = existingRows.get(sessionId);
      if (existingCount !== undefined && existingCount >= messageCount) continue;

      const sessionDate = firstTimestamp > 0
        ? new Date(firstTimestamp).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
      const firstAt = firstTimestamp || Date.now();

      // Per-model child rows (cost = tokens × registry pricing; unpriced → 0 + flag).
      const modelRows = [...byModel.entries()].map(([model, t]) =>
        buildModelUsageRow(model, t, sessionDate, firstAt),
      );
      for (const r of modelRows) {
        if (r.unpriced) {
          logger.warn({ model: r.model, sessionId }, 'unknown model — usage uncosted');
        }
        upsertModel.run(
          sessionId, r.model, r.tier, r.provider,
          r.inputTokens, r.cacheCreationTokens, r.cacheReadTokens, r.outputTokens,
          r.totalTokens, r.estimatedCostUsd, r.unpriced, r.messageCount,
          r.sessionDate, r.firstMessageAt,
        );
      }
      // Parent cost = sum of per-model rounded costs (so parent == Σ child).
      const estimatedCostUsd = modelRows.reduce((s, r) => s + r.estimatedCostUsd, 0);

      upsert.run(
        sessionId, project, detectedModel,
        inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens,
        inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
        Math.round(estimatedCostUsd * 10000) / 10000,
        messageCount, sessionDate,
        firstAt,
        lastTimestamp || null,
        Date.now(),
      );
    }
  }
}
