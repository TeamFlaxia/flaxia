/**
 * Safe DOM utility functions to prevent DOMException errors
 */

/**
 * Safely removes an element from the DOM, preventing "not a child of this node" errors
 * @param element The element to remove
 * @returns true if element was removed, false if element was not found or already removed
 */
export function safeRemoveElement(element: HTMLElement | null | undefined): boolean {
  if (!element) {
    return false;
  }

  try {
    // Check if element has a parent and is in the DOM
    if (element.parentNode) {
      element.parentNode.removeChild(element);
      return true;
    }

    // If no parent but element has remove method (modern browsers)
    if ('remove' in element) {
      element.remove();
      return true;
    }

    return false;
  } catch (error) {
    console.warn('Failed to remove element:', error);
    return false;
  }
}

/**
 * Safely removes an element from document.body, with proper parent checking
 * @param element The element to remove from body
 * @returns true if element was removed, false otherwise
 */
export function safeRemoveFromBody(element: HTMLElement | null | undefined): boolean {
  if (!element) {
    return false;
  }

  try {
    // Check if element is actually a child of document.body
    if (element.parentNode === document.body) {
      document.body.removeChild(element);
      return true;
    }

    // Fallback: try to remove using parent if it exists
    if (element.parentNode) {
      element.parentNode.removeChild(element);
      return true;
    }

    // Final fallback: use modern remove method
    if ('remove' in element) {
      element.remove();
      return true;
    }

    return false;
  } catch (error) {
    console.warn('Failed to remove element from body:', error);
    return false;
  }
}

/**
 * Checks if an element is currently in the DOM
 * @param element The element to check
 * @returns true if element is in DOM, false otherwise
 */
export function isElementInDOM(element: HTMLElement | null | undefined): boolean {
  if (!element) {
    return false;
  }

  return document.contains(element);
}

/**
 * Removes all child elements from a parent element safely
 * @param parent The parent element to clear
 */
export function safeClearChildren(parent: HTMLElement | null | undefined): void {
  if (!parent) {
    return;
  }

  try {
    // Use modern approach if available
    if ('replaceChildren' in parent) {
      parent.replaceChildren();
      return;
    }

    // Fallback: remove children one by one
    const parentNode = parent as Node;
    let child = parentNode.firstChild;
    while (child) {
      parentNode.removeChild(child);
      child = parentNode.firstChild;
    }
  } catch (error) {
    console.warn('Failed to clear children:', error);
  }
}

/**
 * Modal cleanup utility - safely removes modal and cleans up event listeners
 * @param modalElement The modal element to remove
 * @param cleanupFunctions Optional array of cleanup functions to call
 */
export function safeCleanupModal(
  modalElement: HTMLElement | null | undefined,
  cleanupFunctions: (() => void)[] = [],
): void {
  // Run cleanup functions first
  cleanupFunctions.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.warn('Cleanup function failed:', error);
    }
  });

  // Remove modal element
  safeRemoveFromBody(modalElement);
}
