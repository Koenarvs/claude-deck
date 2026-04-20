/**
 * Tab-title badge management.
 *
 * - `setBadge(count)` prefixes `document.title` with `(N) `
 * - `clearBadge()` restores the original title
 *
 * Only the first call captures the "original" title. Subsequent calls
 * replace the badge prefix without re-capturing.
 */

let originalTitle: string | null = null;

function captureOriginal(): void {
  if (originalTitle === null) {
    originalTitle = document.title;
  }
}

/**
 * Sets the tab-title badge to show the given count.
 * If count is 0, clears the badge instead.
 */
export function setBadge(count: number): void {
  captureOriginal();

  if (count <= 0) {
    clearBadge();
    return;
  }

  document.title = `(${count}) ${originalTitle}`;
}

/**
 * Removes the badge prefix, restoring the original document title.
 */
export function clearBadge(): void {
  if (originalTitle !== null) {
    document.title = originalTitle;
  }
}

/**
 * Resets internal state. Intended for testing only.
 */
export function _resetForTesting(): void {
  originalTitle = null;
}
