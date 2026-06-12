import type { OrchestratorTrigger } from '../../../src/shared/orchestrator';
import type { ChannelInbound } from '../../../src/shared/orchestrator-channels';
import type { ChannelAdapter, OutboundDirective, OutboundMessage } from './channel-adapter';

/**
 * Discord face, locked to a single paired owner id (TOS guardrail #1 — one person, one seat).
 * Reuses the existing discord plugin's `reply` tool for outbound: `formatOutbound` returns the
 * directive shape the brain invokes. Never serves a non-owner.
 */
export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  private readonly ownerId: string | null;

  constructor(ownerId: string | null) {
    this.ownerId = ownerId;
  }

  isOwner(userId: string): boolean {
    return this.ownerId !== null && userId === this.ownerId;
  }

  toTrigger(inbound: ChannelInbound): OrchestratorTrigger {
    return { kind: 'owner_message', text: inbound.text, channel: 'discord' };
  }

  formatOutbound(msg: OutboundMessage): OutboundDirective {
    return {
      tool: 'reply',
      chat_id: msg.chatId,
      message: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    };
  }
}
