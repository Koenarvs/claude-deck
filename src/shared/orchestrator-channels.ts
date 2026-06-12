import { z } from 'zod';

/**
 * An inbound message arriving from a remote channel (e.g. Discord) at the
 * `POST /api/orchestrator/channels/:channel/inbound` ingress. The channel
 * adapter validates ownership against `OrchestratorConfig.discord_owner_id`
 * before converting an allowed message into an `owner_message` trigger.
 */
export const ChannelInboundSchema = z.object({
  /** The remote channel's user identity (e.g. a Discord user id). */
  userId: z.string().min(1),
  /** The message text. */
  text: z.string().min(1),
  /** The remote conversation id the brain replies into (e.g. a Discord chat_id). */
  chatId: z.string().min(1),
  /** Optional remote message id, used for quote-replies. */
  messageId: z.string().optional(),
});
export type ChannelInbound = z.infer<typeof ChannelInboundSchema>;

/** Channels this build supports. Slack/Teams are designed-for but not built. */
export const CHANNEL_IDS = ['discord'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];
