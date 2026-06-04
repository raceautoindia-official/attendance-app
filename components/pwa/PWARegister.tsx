'use client';

import { useEffect } from 'react';

export default function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    // We intentionally no longer use a service worker — the previous caching SW
    // served stale pages and data. Unregister any existing worker and clear all
    // caches so the app always loads fresh from the network.
    const cleanup = async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch {
        // Ignore — not critical to app function.
      }
    };
    void cleanup();
  }, []);

  return null;
}

