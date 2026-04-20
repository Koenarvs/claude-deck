import '@testing-library/jest-dom/vitest';

// Polyfill ResizeObserver for jsdom (react-window v2 requires it)
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

// Polyfill scrollIntoView for jsdom
if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = function () {};
}

// Polyfill Notification API for jsdom
if (typeof globalThis.Notification === 'undefined') {
  globalThis.Notification = class MockNotification {
    static permission = 'default' as NotificationPermission;
    static async requestPermission(): Promise<NotificationPermission> {
      return 'granted';
    }
    title: string;
    onclick: (() => void) | null = null;
    constructor(title: string, _options?: NotificationOptions) {
      this.title = title;
    }
    close() {}
  } as unknown as typeof Notification;
}

// Mock fetch globally for component tests that don't provide their own mock
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = (() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })) as typeof fetch;
}
