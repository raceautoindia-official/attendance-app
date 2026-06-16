import * as SecureStore from 'expo-secure-store';

// Lightweight cache of the last-seen "today" attendance so the dashboard can
// paint instantly on open (no network spinner), then refresh in the background.
const TODAY_KEY = 'today_cache';

export async function saveTodayCache(data: unknown): Promise<void> {
  try {
    await SecureStore.setItemAsync(TODAY_KEY, JSON.stringify(data ?? null));
  } catch {
    // cache is best-effort
  }
}

export async function getTodayCache<T>(): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(TODAY_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
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
