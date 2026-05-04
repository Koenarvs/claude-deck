import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { sendWsMessage } from '@/lib/ws-manager';
import { onTerminalData, onTerminalStarted, onTerminalExited, cleanupTerminalListeners } from '@/lib/terminal-events';

interface TerminalPanelProps {
  goalId: string;
  goalStatus: string;
}

export default function TerminalPanel({ goalId }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<'connecting' | 'running' | 'exited'>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const spawnedRef = useRef(false);

  const spawnTerminal = useCallback(async () => {
    if (spawnedRef.current) return;
    spawnedRef.current = true;

    try {
      const res = await fetch(`/api/goals/${goalId}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json();
        console.error('Failed to spawn terminal:', err);
        return;
      }
      const data = await res.json();
      if (data.status === 'already_running') {
        setStatus('running');
      }
    } catch (err) {
      console.error('Failed to spawn terminal:', err);
    }
  }, [goalId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
      letterSpacing: 0,
      scrollback: 10000,
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    try {
      fitAddon.fit();
    } catch {
      // Container may not be visible yet
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Focus the terminal so it receives keyboard input
    term.focus();

    // Re-focus when the container is clicked
    containerRef.current.addEventListener('click', () => term.focus());

    // Replay conversation history from Claude Code's JSONL transcript
    fetch(`/api/goals/${goalId}/transcript`)
      .then((r) => r.text())
      .then((buf) => { if (buf) term.write(buf); })
      .catch(() => { /* no transcript available */ });

    term.onData((data) => {
      sendWsMessage({
        type: 'terminal:input',
        goal_id: goalId,
        data,
      });
    });

    const unsubData = onTerminalData(goalId, (data) => {
      term.write(data);
    });

    const unsubStarted = onTerminalStarted(goalId, () => {
      setStatus('running');
    });

    const unsubExited = onTerminalExited(goalId, (code) => {
      setStatus('exited');
      setExitCode(code);
      term.write(`\r\n\x1b[90m--- session exited (code ${code}) ---\x1b[0m\r\n`);
    });

    // Resize handler — debounced to avoid cursor desync during active streaming
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fitAddon.fit();
          sendWsMessage({
            type: 'terminal:resize',
            goal_id: goalId,
            cols: term.cols,
            rows: term.rows,
          });
        } catch {
          // Ignore resize errors during teardown
        }
      }, 100);
    });
    resizeObserver.observe(containerRef.current);

    // Spawn the PTY
    void spawnTerminal();

    return () => {
      unsubData();
      unsubStarted();
      unsubExited();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      cleanupTerminalListeners(goalId);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  const handleRestart = useCallback(async () => {
    setStatus('connecting');
    setExitCode(null);
    spawnedRef.current = false;
    terminalRef.current?.clear();
    await spawnTerminal();
  }, [spawnTerminal]);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden" data-testid="terminal-panel">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-deck-border text-xs text-deck-muted">
        <span>
          Terminal
          {status === 'running' && <span className="ml-2 text-green-400">● running</span>}
          {status === 'connecting' && <span className="ml-2 text-yellow-400">● connecting</span>}
          {status === 'exited' && (
            <span className="ml-2 text-deck-muted">
              ● exited ({exitCode})
            </span>
          )}
        </span>
        {status === 'exited' && (
          <button
            type="button"
            onClick={() => void handleRestart()}
            className="text-deck-accent hover:text-deck-accent-hover transition-colors"
          >
            Restart
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{ padding: '4px' }}
      />
    </div>
  );
}
