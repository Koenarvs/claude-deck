import { describe, it, expect, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { ApprovalCoordinator } from '../../../server/approval-coordinator';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('ApprovalCoordinator observer (orchestrator trigger seam)', () => {
  it('invokes onApprovalPending with the approval when a supervised approval is requested', async () => {
    const db = makeMigratedDb();
    const observer = vi.fn();
    const coord = new ApprovalCoordinator(db, 30 * 60 * 1000, observer);
    void coord.request({ session_id: 's1', goal_id: 'g1', tool_name: 'Bash', tool_args: '{}' }, false);
    await new Promise((r) => setImmediate(r));
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ goal_id: 'g1', tool_name: 'Bash' }));
    coord.shutdown();
    db.close();
  });

  it('does NOT invoke the observer for autonomous (auto-approved) requests', async () => {
    const db = makeMigratedDb();
    const observer = vi.fn();
    const coord = new ApprovalCoordinator(db, 1000, observer);
    await coord.request({ session_id: 's1', goal_id: 'g1', tool_name: 'Read', tool_args: '{}' }, true);
    expect(observer).not.toHaveBeenCalled();
    coord.shutdown();
    db.close();
  });
});
