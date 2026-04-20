/**
 * Toast notification state management.
 *
 * Standalone Zustand store for toast notifications.
 * - Auto-dismiss after configurable duration
 * - Stack up to MAX_VISIBLE toasts
 * - Types: info, success, warn, error
 */

import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

const MAX_VISIBLE = 5;
const DEFAULT_DURATION_MS = 5000;

let nextId = 1;

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => string;
  removeToast: (id: string) => void;
  clearAll: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (type, message, duration = DEFAULT_DURATION_MS) => {
    const id = `toast-${nextId++}`;
    const toast: Toast = { id, type, message, duration };

    set((state) => ({
      toasts: [...state.toasts, toast].slice(-MAX_VISIBLE),
    }));

    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }

    return id;
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  clearAll: () => set({ toasts: [] }),
}));

/** Convenience helpers */
export const toast = {
  info: (message: string, duration?: number) =>
    useToastStore.getState().addToast('info', message, duration),
  success: (message: string, duration?: number) =>
    useToastStore.getState().addToast('success', message, duration),
  warn: (message: string, duration?: number) =>
    useToastStore.getState().addToast('warn', message, duration),
  error: (message: string, duration?: number) =>
    useToastStore.getState().addToast('error', message, duration),
};
