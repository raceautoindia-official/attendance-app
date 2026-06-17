import * as SecureStore from 'expo-secure-store';

// Lightweight cache of the last-seen "today" attendance so the dashboard can
// paint instantly on open (no network spinner), then refresh in the background.
// The cache is DATE-STAMPED: it is only reused on the same calendar day, so a
// previous day's record never shows up on a new day.
const TODAY_KEY = 'today_cache_v2';

export async function saveTodayCache(dateYmd: string, data: unknown): Promise<void> {
  try {
    await SecureStore.setItemAsync(TODAY_KEY, JSON.stringify({ date: dateYmd, data: data ?? null }));
  } catch {
    // cache is best-effort
  }
}

// Returns the cached attendance ONLY if it was saved for `dateYmd` (today).
// Otherwise returns null so the UI shows a fresh empty state until the fetch.
export async function getTodayCache<T>(dateYmd: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(TODAY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { date?: string; data?: unknown };
    if (parsed?.date !== dateYmd) return null; // stale — different day
    return (parsed.data ?? null) as T;
  } catch {
    return null;
  }
}

export async function clearTodayCache(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TODAY_KEY);
  } catch {
    // ignore
  }
}
