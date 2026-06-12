// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DiscordChannelAdapter } from '../../../../server/orchestrator/channels/discord-channel-adapter';
import type { ChannelInbound } from '../../../../src/shared/orchestrator-channels';

const inbound: ChannelInbound = { userId: 'owner-1', chatId: 'dm-9', text: 'status?', messageId: 'm1' };

describe('DiscordChannelAdapter', () => {
  it('has id "discord"', () => {
    expect(new DiscordChannelAdapter('owner-1').id).toBe('discord');
  });

  it('isOwner: true only for the paired owner id', () => {
    const a = new DiscordChannelAdapter('owner-1');
    expect(a.isOwner('owner-1')).toBe(true);
    expect(a.isOwner('someone-else')).toBe(false);
  });

  it('isOwner: false for everyone when unpaired (owner id null)', () => {
    const a = new DiscordChannelAdapter(null);
    expect(a.isOwner('owner-1')).toBe(false);
  });

  it('toTrigger maps an inbound owner message to an owner_message trigger on the discord channel', () => {
    const a = new DiscordChannelAdapter('owner-1');
    expect(a.toTrigger(inbound)).toEqual({ kind: 'owner_message', text: 'status?', channel: 'discord' });
  });

  it('formatOutbound carries chatId + text as a reply directive the brain honors', () => {
    const a = new DiscordChannelAdapter('owner-1');
    const directive = a.formatOutbound({ chatId: 'dm-9', text: 'All green.', replyTo: 'm1' });
    expect(directive).toEqual({ tool: 'reply', chat_id: 'dm-9', message: 'All green.', reply_to: 'm1' });
  });

  it('formatOutbound omits reply_to when not a quote-reply', () => {
    const a = new DiscordChannelAdapter('owner-1');
    expect(a.formatOutbound({ chatId: 'dm-9', text: 'hi' })).toEqual({
      tool: 'reply',
      chat_id: 'dm-9',
      message: 'hi',
    });
  });
});
