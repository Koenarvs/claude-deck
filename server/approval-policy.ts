import type Database from 'better-sqlite3';

export type ApprovalPosture = 'block' | 'pass-through';

/**
 * Whether the provider behind `model` can participate in blocking approvals.
 *
 * PHASE1-FALLBACK: once the agent catalog (Delta C) lands, replace this body with
 *   catalog.find(p => p.id === resolveModel(model)?.provider)?.capabilities.canApprove === true
 * For now only Claude exists and Claude can approve; non-Claude model ids (gpt-*, gemini-*,
 * codex-*, antigravity-*) are treated as canApprove:false so Phase-3 providers degrade
 * honestly the moment they appear.
 */
export function providerCanApprove(model: string | null): boolean {
  if (!model) return true; // default/unknown on a Claude-only install => Claude
  const m = model.toLowerCase();
  if (
    m.startsWith('gpt') ||
    m.startsWith('codex') ||
    m.startsWith('gemini') ||
    m.startsWith('antigravity')
  ) {
    return false;
  }
  return true; // claude family (opus/sonnet/haiku/fable/default)
}

/**
 * Resolves the approval posture for a goal's tool call:
 * - 'block'        — hold the hook open and wait for a UI decision (supervised + provider can approve)
 * - 'pass-through' — auto-allow immediately (autonomous, unlinked, or provider can't approve)
 */
export function resolveApprovalPosture(
  db: Database.Database,
  goalId: string | null,
): ApprovalPosture {
  if (!goalId) return 'pass-through';
  const row = db
    .prepare(`SELECT permission_mode, model FROM goals WHERE id = ?`)
    .get(goalId) as { permission_mode: string; model: string | null } | undefined;
  if (!row) return 'pass-through';
  if (row.permission_mode !== 'supervised') return 'pass-through';
  if (!providerCanApprove(row.model)) return 'pass-through';
  return 'block';
}
