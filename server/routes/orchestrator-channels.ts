import { Router } from 'express';
import { ChannelInboundSchema } from '../../src/shared/orchestrator-channels';
import type { OrchestratorTrigger } from '../../src/shared/orchestrator';
import type { OrchestratorStateService } from '../services/orchestrator-state-service';
import { DiscordChannelAdapter } from '../orchestrator/channels/discord-channel-adapter';
import type { ChannelAdapter } from '../orchestrator/channels/channel-adapter';
import logger from '../logger';

export interface OrchestratorChannelsRouterDeps {
  stateService: OrchestratorStateService;
  trigger: (t: OrchestratorTrigger) => Promise<void>;
}

/**
 * Inbound ingress for remote channel faces. The single-user lock is enforced here
 * against the live paired-owner id in config, so a Settings change takes effect at once.
 * A non-owner message is dropped (403, logged) — never serve a third party (TOS guardrail #1).
 */
export function createOrchestratorChannelsRouter(deps: OrchestratorChannelsRouterDeps): Router {
  const router = Router();

  /** Builds the adapter for a channel id with the current paired owner, or null if unknown. */
  function adapterFor(channel: string): ChannelAdapter | null {
    const config = deps.stateService.get().config;
    if (channel === 'discord') return new DiscordChannelAdapter(config.discord_owner_id);
    return null;
  }

  router.post('/orchestrator/channels/:channel/inbound', (req, res) => {
    const adapter = adapterFor(req.params.channel);
    if (!adapter) {
      res.status(404).json({ error: `unknown channel: ${req.params.channel}` });
      return;
    }

    const parsed = ChannelInboundSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid inbound', issues: parsed.error.issues });
      return;
    }

    if (!adapter.isOwner(parsed.data.userId)) {
      logger.warn(
        { channel: adapter.id, userId: parsed.data.userId },
        'channel inbound dropped: not the paired owner (single-user lock)',
      );
      res.status(403).json({ error: 'not the paired owner' });
      return;
    }

    void deps.trigger(adapter.toTrigger(parsed.data));
    res.status(202).json({ accepted: true });
  });

  return router;
}
