'use client';

import { useEffect } from 'react';

export default function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const register = async () => {
      try {
        await navigator.serviceWorker.register('/sw.js');
      } catch {
        // Ignore registration errors; app should continue to work normally.
      }
    };
    void register();
  }, []);

  return null;
}

