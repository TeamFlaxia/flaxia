'use client';

export function RightPanel() {
  return (
    <aside className="right-panel">
      <div className="search-section">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input className="search-input" type="text" placeholder="Search" />
        </div>
      </div>
      <div className="trending-section">
        <div className="section-title">Trending</div>
        <div className="trending-list">
          <div className="trending-item">
            <div className="trending-content">
              <span className="trending-hashtag">#flaxia</span>
              <span className="trending-count">Loading...</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
