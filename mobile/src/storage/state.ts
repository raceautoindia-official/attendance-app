import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';

// ---------------------------------------------------------------------------
// Plain-file storage for OPERATIONAL STATE — warning counters, the auto-login
// pending flag, the cached fence, the announced-decisions list.
//
// These lived in SecureStore, which is Android-Keystore-backed. The Keystore
// has a documented failure mode: on some devices, and on locked devices in
// background work, reads and writes silently fail — and every caller here
// swallowed those failures by design ("never break enforcement over storage").
// The result in the field: the location-off warning counter read 0 on every
// check, so an employee got "warning 1 of 4" four times in a row while the
// escalation never advanced. API auth kept working through it, because tokens
// are cached in memory after login — which is exactly why the breakage was
// invisible everywhere except the counters.
//
// None of this state is secret. A warning count, a fence's coordinates, a list
// of announced notification ids — an attacker with file access to the app
// sandbox already owns the device. Secrets (tokens, device id, consent) stay
// in SecureStore where they belong.
//
// One JSON file, read fresh on every get and rewritten on every set: separate
// headless task runtimes (geofence event, background poll, foreground app)
// each see the latest state at the moment they act, which module-level caching
// would break.
// ---------------------------------------------------------------------------

const FILE = `${FileSystem.documentDirectory}app-state.json`;

async function readAll(): Promise<Record<string, string>> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAll(state: Record<string, string>): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(state));
  } catch {
    // A failed write leaves the previous state on disk — the next check reads
    // slightly stale values and self-corrects, which is the same contract the
    // callers already lived by.
  }
}

/** Read one value. Falls back to SecureStore ONCE per key, migrating any value
 *  written before this store existed, so an in-flight escalation or a pending
 *  auto-login survives the app update that ships this change. */
export async function getState(key: string): Promise<string | null> {
  const all = await readAll();
  if (key in all) return all[key];
  const legacy = await SecureStore.getItemAsync(key).catch(() => null);
  if (legacy != null) {
    all[key] = legacy;
    await writeAll(all);
    await SecureStore.deleteItemAsync(key).catch(() => {});
    return legacy;
  }
  return null;
}

export async function setState(key: string, value: string): Promise<void> {
  const all = await readAll();
  all[key] = value;
  await writeAll(all);
}

export async function removeState(key: string): Promise<void> {
  const all = await readAll();
  if (!(key in all)) return;
  delete all[key];
  await writeAll(all);
}
