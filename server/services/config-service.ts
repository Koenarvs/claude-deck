import type Database from 'better-sqlite3';
import { PersistedConfigSchema, type PersistedConfig, type ProviderConfig } from '../../src/shared/schemas';
import logger from '../logger';

const DEFAULTS: PersistedConfig = {
  homeRoute: '/board',
  authMode: 'auto',
  logLevel: 'info',
  logRetentionDays: 30,
  hookEventRetentionDays: 90,
  tracePruneDays: 90,
  defaultModel: 'default',
  defaultPermissionMode: 'supervised',
  providers: [{ id: 'claude', enabled: true, billingMode: 'seat' }],
  headroom: {
    enabled: true,
    baseUrl: 'http://localhost:8787',
    launchOnStartup: true,
    compressionDegree: 'balanced',
    interceptToolResults: true,
    memory: true,
    // vertexApiUrl omitted: auto-derived from CLOUD_ML_REGION unless overridden.
  },
};

/**
 * The freeform `command` field is an advanced override. Older persisted rows
 * stored the legacy default string; map that (and empty strings) back to
 * `undefined` so the HeadroomService auto-builds the command from the
 * structured fields instead of treating the stale string as a real override.
 */
const LEGACY_DEFAULT_COMMAND = 'headroom proxy --port 8787';
const LEGACY_DEFAULT_VERTEX_URL = 'https://aiplatform.googleapis.com';
function normalizeHeadroom(h: PersistedConfig['headroom']): PersistedConfig['headroom'] {
  let out = h;
  if (out.command === LEGACY_DEFAULT_COMMAND || (out.command != null && out.command.trim() === '')) {
    const { command: _drop, ...rest } = out;
    out = rest;
  }
  // Drop the legacy static Vertex URL (and empty strings) so the proxy
  // auto-derives the host from CLOUD_ML_REGION instead of pinning a stale value.
  if (out.vertexApiUrl === LEGACY_DEFAULT_VERTEX_URL || (out.vertexApiUrl != null && out.vertexApiUrl.trim() === '')) {
    const { vertexApiUrl: _dropUrl, ...rest } = out;
    out = rest;
  }
  return out;
}

/**
 * Enforces the claude-always-on invariant: a 'claude' record is always present
 * and enabled. Dedupes other providers by id (last write wins).
 */
function normalizeProviders(list: ProviderConfig[]): ProviderConfig[] {
  const byId = new Map<string, ProviderConfig>();
  for (const p of list) byId.set(p.id, { ...p });
  const existingClaude = byId.get('claude');
  byId.set('claude', {
    ...(existingClaude ?? { id: 'claude', billingMode: 'seat' as const }),
    id: 'claude',
    enabled: true, // claude can never be disabled
  });
  return [...byId.values()];
}

export function createConfigService(db: Database.Database) {
  const readStmt = db.prepare<[], { config_json: string }>(
    'SELECT config_json FROM app_config WHERE id = 1',
  );
  const upsertStmt = db.prepare<[string, number]>(
    `INSERT INTO app_config (id, config_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  );

  function getPersisted(): PersistedConfig {
    const row = readStmt.get();
    if (!row) return structuredClone(DEFAULTS);
    try {
      const parsed = PersistedConfigSchema.parse(JSON.parse(row.config_json));
      parsed.providers = normalizeProviders(parsed.providers);
      parsed.headroom = normalizeHeadroom(parsed.headroom);
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'app_config row invalid; returning defaults');
      return structuredClone(DEFAULTS);
    }
  }

  function updatePersisted(partial: Partial<PersistedConfig>): PersistedConfig {
    const current = getPersisted();
    const merged: PersistedConfig = {
      ...current,
      ...partial,
      // headroom is shallow-merged so a partial update can't drop sibling fields.
      headroom: { ...current.headroom, ...(partial.headroom ?? {}) },
    };
    merged.providers = normalizeProviders(merged.providers);
    const validated = PersistedConfigSchema.parse(merged);
    upsertStmt.run(JSON.stringify(validated), Date.now());
    return validated;
  }

  return { getPersisted, updatePersisted };
}

export type ConfigService = ReturnType<typeof createConfigService>;
