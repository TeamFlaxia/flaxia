// Global ad impression tracker to batch database calls
class AdImpressionTracker {
  private pendingAds: Set<string> = new Set();
  private batchTimeout?: number;
  private readonly BATCH_DELAY = 3000; // 3 seconds
  private readonly MAX_BATCH_SIZE = 20;

  constructor() {
    // Process any pending impressions when page unloads
    window.addEventListener('beforeunload', () => {
      this.flush();
    });
  }

  public trackImpression(adId: string): void {
    // Add to pending set if not already tracked
    if (!this.pendingAds.has(adId)) {
      this.pendingAds.add(adId);

      // If we reach max batch size, process immediately
      if (this.pendingAds.size >= this.MAX_BATCH_SIZE) {
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
    if (this.pendingAds.size === 0) return;

    const adIds = Array.from(this.pendingAds);
    this.pendingAds.clear();

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }

    // Track each ad impression individually since there's no batch endpoint for ads yet
    const promises = adIds.map(async (adId) => {
      try {
        const response = await fetch(`/api/ads/${adId}/impression`, {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          console.error(`Failed to track ad impression for ${adId}:`, await response.text());
        }
      } catch (error) {
        console.error(`Error tracking ad impression for ${adId}:`, error);
      }
    });

    await Promise.allSettled(promises);
  }

  public forceFlush(): void {
    this.flush();
  }
}

// Export singleton instance
export const adImpressionTracker = new AdImpressionTracker();
