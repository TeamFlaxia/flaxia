'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { LeftNav } from '@/components/client/LeftNav';
import { RightPanel } from '@/components/client/RightPanel';
import { Timeline } from '@/components/client/Timeline';

export function TimelinePage() {
  const { currentUser } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="main-container">
        <div className="main-content">
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="initial-loader-spinner" />
            <div>Loading Flaxia...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="main-container">
      <LeftNav activeItem="home" />
      <main className="main-content">
        <Timeline />
      </main>
      <RightPanel />
    </div>
  );
}
