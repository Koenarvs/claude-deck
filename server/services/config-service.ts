import type Database from 'better-sqlite3';
import { PersistedConfigSchema, type PersistedConfig, type ProviderConfig } from '../../src/shared/schemas';
import logger from '../logger';

const DEFAULTS: PersistedConfig = {
  homeRoute: '/board',
  tracePruneDays: 90,
  defaultModel: 'default',
  defaultPermissionMode: 'supervised',
  providers: [{ id: 'claude', enabled: true, billingMode: 'seat' }],
  headroom: {
    enabled: true,
    baseUrl: 'http://localhost:8787',
    launchOnStartup: true,
    command: 'headroom proxy --port 8787',
  },
};

export interface PersistedConfigUpdate {
  homeRoute?: PersistedConfig['homeRoute'];
  tracePruneDays?: PersistedConfig['tracePruneDays'];
  defaultModel?: PersistedConfig['defaultModel'];
  defaultPermissionMode?: PersistedConfig['defaultPermissionMode'];
  providers?: PersistedConfig['providers'];
  headroom?: Partial<PersistedConfig['headroom']>;
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
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'app_config row invalid; returning defaults');
      return structuredClone(DEFAULTS);
    }
  }

  function updatePersisted(partial: PersistedConfigUpdate): PersistedConfig {
    const current = getPersisted();
    const merged: PersistedConfig = {
      ...current,
      ...partial,
      headroom: {
        ...current.headroom,
        ...(partial.headroom ?? {}),
      },
    };
    merged.providers = normalizeProviders(merged.providers);
    const validated = PersistedConfigSchema.parse(merged);
    upsertStmt.run(JSON.stringify(validated), Date.now());
    return validated;
  }

  return { getPersisted, updatePersisted };
}

export type ConfigService = ReturnType<typeof createConfigService>;
