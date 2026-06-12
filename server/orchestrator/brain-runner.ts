import { spawn as nodeSpawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { BrainProvider, BrainInvocationInput, BrainStreamEvent } from './brain-provider';
import { extractMemoryUpdate } from './brain-provider';
import logger from '../logger';

/** A minimal child-process shape so tests can inject fakes. */
export interface Spawnable {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: string): void;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
export type SpawnFn = (command: string, args: string[], env: Record<string, string>) => Spawnable;

export interface BrainRunnerOptions {
  spawnFn?: SpawnFn;
  silenceTimeoutMs?: number; // abort if no stdout line for this long
}

export interface BrainResult {
  ok: boolean;
  exitCode: number | null;
  fullText: string;
  memory: string | null;
  aborted: boolean;
}

const defaultSpawn: SpawnFn = (command, args, env) =>
  nodeSpawn(command, args, { env: { ...process.env, ...env } }) as unknown as Spawnable;

/**
 * Runs a single bounded, headless brain invocation. Streams assistant text/tool events to
 * `onEvent` for live mirroring, enforces a silence-timeout watchdog, and returns the
 * accumulated text + extracted memory.
 */
export class BrainRunner {
  private readonly provider: BrainProvider;
  private readonly spawnFn: SpawnFn;
  private readonly silenceTimeoutMs: number;

  constructor(provider: BrainProvider, opts: BrainRunnerOptions = {}) {
    this.provider = provider;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? 90_000;
  }

  run(input: BrainInvocationInput, onEvent: (e: BrainStreamEvent) => void): Promise<BrainResult> {
    const inv = this.provider.buildInvocation(input);
    const child = this.spawnFn(inv.command, inv.args, inv.env);

    return new Promise<BrainResult>((resolve) => {
      let fullText = '';
      let aborted = false;
      let settled = false;

      const rl = readline.createInterface({ input: child.stdout });

      let silenceTimer: ReturnType<typeof setTimeout>;
      const resetSilence = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          aborted = true;
          logger.warn('Orchestrator brain run aborted: silence timeout');
          child.kill('SIGKILL');
        }, this.silenceTimeoutMs);
      };
      resetSilence();

      rl.on('line', (line) => {
        resetSilence();
        for (const e of this.provider.parseLine(line)) {
          if (e.kind === 'text') fullText += e.text;
          onEvent(e);
        }
      });

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(silenceTimer);
        rl.close();
        resolve({
          ok: !aborted && exitCode === 0,
          exitCode,
          fullText,
          memory: extractMemoryUpdate(fullText),
          aborted,
        });
      };

      child.on('close', (code) => finish(code));
      child.on('error', (err) => {
        logger.error({ err }, 'Orchestrator brain spawn error');
        finish(null);
      });
    });
  }
}
