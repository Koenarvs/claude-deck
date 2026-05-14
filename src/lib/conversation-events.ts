type Handler = () => void;
const listeners = new Map<string, Handler[]>();

export function onConversationUpdated(goalId: string, handler: Handler): () => void {
  const list = listeners.get(goalId) ?? [];
  list.push(handler);
  listeners.set(goalId, list);
  return () => {
    const current = listeners.get(goalId);
    if (current) listeners.set(goalId, current.filter(h => h !== handler));
  };
}

export function emitConversationUpdated(goalId: string): void {
  listeners.get(goalId)?.forEach(h => h());
}
