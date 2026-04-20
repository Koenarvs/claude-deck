import { describe, it, expect, beforeEach } from 'vitest';
import { processRegistry } from '../../server/process-registry';
import type { Killable } from '../../server/process-registry';

function createMockRunner(): Killable & {
  interruptCalled: boolean;
  cleanupCalled: boolean;
} {
  return {
    interruptCalled: false,
    cleanupCalled: false,
    async interrupt() {
      this.interruptCalled = true;
    },
    async cleanup() {
      this.cleanupCalled = true;
    },
  };
}

describe('ProcessRegistry', () => {
  beforeEach(() => {
    // Clear the registry before each test.
    // Use killAll with mock runners that have already been cleaned up.
    return processRegistry.killAll();
  });

  it('get returns undefined for unknown goal ID', () => {
    expect(processRegistry.get('nonexistent')).toBeUndefined();
  });

  it('set + get stores and retrieves a runner', () => {
    const runner = createMockRunner();
    processRegistry.set('goal-1', runner);

    expect(processRegistry.get('goal-1')).toBe(runner);
    expect(processRegistry.has('goal-1')).toBe(true);
    expect(processRegistry.size).toBe(1);
  });

  it('remove deletes a runner from the registry', () => {
    const runner = createMockRunner();
    processRegistry.set('goal-2', runner);

    const removed = processRegistry.remove('goal-2');
    expect(removed).toBe(true);
    expect(processRegistry.get('goal-2')).toBeUndefined();
    expect(processRegistry.has('goal-2')).toBe(false);
    expect(processRegistry.size).toBe(0);
  });

  it('remove returns false for unknown goal ID', () => {
    const removed = processRegistry.remove('nonexistent');
    expect(removed).toBe(false);
  });

  it('has returns false for unknown goal ID', () => {
    expect(processRegistry.has('nonexistent')).toBe(false);
  });

  it('set overwrites existing runner without killing it', () => {
    const runner1 = createMockRunner();
    const runner2 = createMockRunner();

    processRegistry.set('goal-3', runner1);
    processRegistry.set('goal-3', runner2);

    expect(processRegistry.get('goal-3')).toBe(runner2);
    // Registry does NOT auto-kill -- caller is responsible
    expect(runner1.interruptCalled).toBe(false);
    expect(processRegistry.size).toBe(1);
  });

  it('killAll interrupts and cleans up all registered runners', async () => {
    const runner1 = createMockRunner();
    const runner2 = createMockRunner();
    const runner3 = createMockRunner();

    processRegistry.set('goal-a', runner1);
    processRegistry.set('goal-b', runner2);
    processRegistry.set('goal-c', runner3);

    expect(processRegistry.size).toBe(3);

    await processRegistry.killAll();

    expect(runner1.interruptCalled).toBe(true);
    expect(runner1.cleanupCalled).toBe(true);
    expect(runner2.interruptCalled).toBe(true);
    expect(runner2.cleanupCalled).toBe(true);
    expect(runner3.interruptCalled).toBe(true);
    expect(runner3.cleanupCalled).toBe(true);

    // Registry is empty after killAll
    expect(processRegistry.size).toBe(0);
    expect(processRegistry.has('goal-a')).toBe(false);
    expect(processRegistry.has('goal-b')).toBe(false);
    expect(processRegistry.has('goal-c')).toBe(false);
  });

  it('killAll handles errors in individual runners gracefully', async () => {
    const goodRunner = createMockRunner();
    const badRunner: Killable = {
      async interrupt() {
        throw new Error('interrupt failed');
      },
      async cleanup() {
        throw new Error('cleanup failed');
      },
    };

    processRegistry.set('goal-good', goodRunner);
    processRegistry.set('goal-bad', badRunner);

    // Should not throw
    await processRegistry.killAll();

    // Good runner was still cleaned up despite bad runner's errors
    expect(goodRunner.interruptCalled).toBe(true);
    expect(goodRunner.cleanupCalled).toBe(true);
    expect(processRegistry.size).toBe(0);
  });

  it('killAll on empty registry is a no-op', async () => {
    expect(processRegistry.size).toBe(0);
    // Should not throw
    await processRegistry.killAll();
    expect(processRegistry.size).toBe(0);
  });

  it('supports multiple independent goals simultaneously', () => {
    const runners = Array.from({ length: 5 }, () => createMockRunner());

    for (let i = 0; i < runners.length; i++) {
      const runner = runners[i];
      if (runner) {
        processRegistry.set(`goal-${i}`, runner);
      }
    }

    expect(processRegistry.size).toBe(5);

    for (let i = 0; i < runners.length; i++) {
      expect(processRegistry.has(`goal-${i}`)).toBe(true);
      expect(processRegistry.get(`goal-${i}`)).toBe(runners[i]);
    }
  });
});
