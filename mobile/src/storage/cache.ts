import * as SecureStore from 'expo-secure-store';
import { withTimeoutOr } from '../util/withTimeout';

// The try/catch in each function below handles a FAILED keystore call. A
// keystore call that never answers needs a deadline as well — this cache is
// read during screen bootstrap, where a stall costs the whole screen.
const CACHE_TIMEOUT_MS = 8_000;

// Lightweight cache of the last-seen "today" attendance so the dashboard can
// paint instantly on open (no network spinner), then refresh in the background.
// The cache is DATE-STAMPED: it is only reused on the same calendar day, so a
// previous day's record never shows up on a new day.
const TODAY_KEY = 'today_cache_v2';

export async function saveTodayCache(dateYmd: string, data: unknown): Promise<void> {
  try {
    await withTimeoutOr(
      SecureStore.setItemAsync(TODAY_KEY, JSON.stringify({ date: dateYmd, data: data ?? null })),
      CACHE_TIMEOUT_MS, undefined,
    );
  } catch {
    // cache is best-effort
  }
}

// Returns the cached attendance ONLY if it was saved for `dateYmd` (today).
// Otherwise returns null so the UI shows a fresh empty state until the fetch.
export async function getTodayCache<T>(dateYmd: string): Promise<T | null> {
  try {
    const raw = await withTimeoutOr(SecureStore.getItemAsync(TODAY_KEY), CACHE_TIMEOUT_MS, null);
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
    await withTimeoutOr(SecureStore.deleteItemAsync(TODAY_KEY), CACHE_TIMEOUT_MS, undefined);
  } catch {
    // ignore
  }
}
