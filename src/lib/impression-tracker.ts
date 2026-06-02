// Global impression tracker to batch database calls
class ImpressionTracker {
  private pendingPosts: Set<string> = new Set();
  private batchTimeout?: number;
  private readonly BATCH_DELAY = 3000; // 3 seconds
  private readonly MAX_BATCH_SIZE = 50;

  constructor() {
    // Process any pending impressions when page unloads
    window.addEventListener('beforeunload', () => {
      this.flush();
    });
  }

  public trackImpression(postId: string): void {
    // Add to pending set if not already tracked
    if (!this.pendingPosts.has(postId)) {
      this.pendingPosts.add(postId);

      // If we reach max batch size, process immediately
      if (this.pendingPosts.size >= this.MAX_BATCH_SIZE) {
        this.flush();
        return;
      }

      // Reset timeout to batch more impressions
      if (this.batchTimeout) {
        clearTimeout(this.batchTimeout);
      }

      this.batchTimeout = window.setTimeout(() => {
        this.flush();
      }, this.BATCH_DELAY);
    }
  }

  private async flush(): Promise<void> {
    if (this.pendingPosts.size === 0) return;

    const postIds = Array.from(this.pendingPosts);
    this.pendingPosts.clear();

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }

    try {
      const response = await fetch('/api/posts/impressions/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ post_ids: postIds }),
      });

      if (!response.ok) {
        console.error('Failed to batch track impressions:', await response.text());
      }
    } catch (error) {
      console.error('Error in batch impression tracking:', error);
    }
  }

  public forceFlush(): void {
    this.flush();
  }
}

// Export singleton instance
export const impressionTracker = new ImpressionTracker();
