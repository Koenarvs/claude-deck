import { describe, it, expect } from 'vitest';
import { buildContextPrompt } from '../../../server/orchestrator/context-bundle';

const base = {
  personaName: 'Hawat',
  memory: '# Orchestrator Memory\n\nWatching g1.',
  snapshotMd: '### Active goals\n- [active] Build (g1)',
  recentTurns: [
    { role: 'owner' as const, content: 'status?' },
    { role: 'orchestrator' as const, content: 'All green.' },
  ],
};

describe('buildContextPrompt', () => {
  it('embeds persona, memory, snapshot, and recent turns', () => {
    const p = buildContextPrompt({ ...base, trigger: { kind: 'owner_message', text: 'what now?' } });
    expect(p).toContain('You are Hawat');
    expect(p).toContain('Watching g1.');
    expect(p).toContain('Build (g1)');
    expect(p).toContain('what now?');
    expect(p).toContain('<memory-update>');
  });

  it('frames an approval trigger as a recommendation request', () => {
    const p = buildContextPrompt({ ...base, trigger: { kind: 'approval', approvalId: 'a1', goalId: 'g1' } });
    expect(p.toLowerCase()).toContain('recommendation');
    expect(p).toContain('a1');
  });

  it('tells a heartbeat trigger not to invent work', () => {
    const p = buildContextPrompt({ ...base, trigger: { kind: 'heartbeat' } });
    expect(p.toLowerCase()).toContain('do not invent work');
  });
});
