// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { OrchestratorService } from '../../../server/orchestrator/orchestrator-service';
import { DiscordChannelAdapter } from '../../../server/orchestrator/channels/discord-channel-adapter';

function makeStack() {
  const db = new Database(':memory:'); runMigrations(db);
  const stateService = new OrchestratorStateService(db);
  stateService.updateConfig({ enabled: true, idle_timeout_ms: 60000, discord_owner_id: 'owner-1' });
  const messageService = new OrchestratorMessageService(db);

  // Scripted brain: returns a fixed ack so we can assert a reply landed per trigger.
  const runFn = vi.fn(async () => {
    return { ok: true, exitCode: 0, fullText: 'ack', memory: null, aborted: false };
  });

  const svc = new OrchestratorService({
    stateService, messageService,
    memoryStore: { read: () => '', write: vi.fn() },
    snapshotMd: () => '', mcpConfigJson: () => '{}',
    runFn: runFn as never,
    broadcast: () => {},
  });
  return { svc, messageService, stateService };
}

describe('two faces, one thread', () => {
  it('an app message and a Discord message land in the same thread, in order', async () => {
    const { svc, messageService, stateService } = makeStack();

    // Face 1: app
    await svc.trigger({ kind: 'owner_message', text: 'from the app', channel: 'app' });
    await svc.drain();

    // Face 2: Discord — owner-locked adapter converts an inbound message to a trigger
    const discord = new DiscordChannelAdapter(stateService.get().config.discord_owner_id);
    expect(discord.isOwner('owner-1')).toBe(true);
    const trigger = discord.toTrigger({ userId: 'owner-1', chatId: 'dm-9', text: 'from discord' });
    await svc.trigger(trigger);
    await svc.drain();

    const thread = messageService.list(50);
    const owners = thread.filter((m) => m.role === 'owner');
    expect(owners.map((m) => ({ content: m.content, channel: m.channel }))).toEqual([
      { content: 'from the app', channel: 'app' },
      { content: 'from discord', channel: 'discord' },
    ]);
    // Both produced an orchestrator reply in the one shared thread.
    expect(thread.filter((m) => m.role === 'orchestrator')).toHaveLength(2);
  });

  it('a non-owner Discord identity yields no owner trigger (single-user lock)', () => {
    const { stateService } = makeStack();
    const discord = new DiscordChannelAdapter(stateService.get().config.discord_owner_id);
    expect(discord.isOwner('intruder')).toBe(false);
  });
});
