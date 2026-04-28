type TerminalDataHandler = (data: string) => void;
type TerminalLifecycleHandler = () => void;
type TerminalExitHandler = (exitCode: number) => void;

interface TerminalListeners {
  onData: TerminalDataHandler[];
  onStarted: TerminalLifecycleHandler[];
  onExited: TerminalExitHandler[];
}

const listeners = new Map<string, TerminalListeners>();

function getOrCreate(goalId: string): TerminalListeners {
  let entry = listeners.get(goalId);
  if (!entry) {
    entry = { onData: [], onStarted: [], onExited: [] };
    listeners.set(goalId, entry);
  }
  return entry;
}

export function onTerminalData(goalId: string, handler: TerminalDataHandler): () => void {
  const entry = getOrCreate(goalId);
  entry.onData.push(handler);
  return () => {
    entry.onData = entry.onData.filter((h) => h !== handler);
  };
}

export function onTerminalStarted(goalId: string, handler: TerminalLifecycleHandler): () => void {
  const entry = getOrCreate(goalId);
  entry.onStarted.push(handler);
  return () => {
    entry.onStarted = entry.onStarted.filter((h) => h !== handler);
  };
}

export function onTerminalExited(goalId: string, handler: TerminalExitHandler): () => void {
  const entry = getOrCreate(goalId);
  entry.onExited.push(handler);
  return () => {
    entry.onExited = entry.onExited.filter((h) => h !== handler);
  };
}

export function emitTerminalData(goalId: string, data: string): void {
  listeners.get(goalId)?.onData.forEach((h) => h(data));
}

export function emitTerminalStarted(goalId: string): void {
  listeners.get(goalId)?.onStarted.forEach((h) => h());
}

export function emitTerminalExited(goalId: string, exitCode: number): void {
  listeners.get(goalId)?.onExited.forEach((h) => h(exitCode));
}

export function cleanupTerminalListeners(goalId: string): void {
  listeners.delete(goalId);
}
