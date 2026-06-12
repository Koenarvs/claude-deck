import type { OrchestratorTrigger } from '../../../src/shared/orchestrator';
import type { ChannelInbound, ChannelId } from '../../../src/shared/orchestrator-channels';

/** What the brain must do to mirror a reply to this channel (it calls the matching tool). */
export interface OutboundDirective {
  /** The channel tool to invoke (e.g. discord 'reply'). */
  tool: string;
  chat_id: string;
  message: string;
  reply_to?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  replyTo?: string;
}

/**
 * Server-side contract for a remote face. Single-user locked: only the paired owner's
 * messages become triggers. Outbound is a structured directive the headless brain honors
 * by calling the channel's own tool (no channel client lives in the server).
 *
 * Slack/Teams implement this same interface later without touching the orchestrator.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  /** True only for the single paired owner identity. */
  isOwner(userId: string): boolean;
  /** Maps an owner inbound message to an owner_message trigger tagged with this channel. */
  toTrigger(inbound: ChannelInbound): OrchestratorTrigger;
  /** Produces the directive the brain uses to mirror a reply back to the channel. */
  formatOutbound(msg: OutboundMessage): OutboundDirective;
}
