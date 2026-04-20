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
