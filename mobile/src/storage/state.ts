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
// ONE FILE PER KEY. This was one JSON file holding every key, read and
// rewritten whole on each set — by the foreground app, the 30-second tracking
// task, the geofence task and the background polls, with no lock. Two writers
// overlapping meant the second wrote back the first one's stale copy, so an
// unrelated key vanished; and a read that caught the file half-written parsed
// as empty, so the next set wrote a file holding ONE key and wiped the rest.
// The fence, the auto clock-out flag and the reminder ids went that way — the
// flag is what re-entry clock-in depends on. With a file per key, a write can
// only ever touch its own key.
//
// Read fresh on every get: separate headless task runtimes each see the latest
// state at the moment they act, which module-level caching would break.
// ---------------------------------------------------------------------------

const DIR = `${FileSystem.documentDirectory}app-state/`;
/** The single-file store this replaced; migrated once, then deleted. */
const LEGACY_FILE = `${FileSystem.documentDirectory}app-state.json`;

function fileFor(key: string): string {
  return `${DIR}${encodeURIComponent(key)}`;
}

let ready: Promise<void> | null = null;

/** Creates the directory and carries the old single file over, once per runtime. */
function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
      try {
        const info = await FileSystem.getInfoAsync(LEGACY_FILE);
        if (!info.exists) return;
        const parsed = JSON.parse(await FileSystem.readAsStringAsync(LEGACY_FILE)) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed ?? {})) {
          if (typeof value !== 'string') continue;
          // Never over a per-key file: another runtime may already have
          // migrated and written something newer since.
          const target = fileFor(key);
          if (!(await FileSystem.getInfoAsync(target)).exists) {
            await FileSystem.writeAsStringAsync(target, value);
          }
        }
        await FileSystem.deleteAsync(LEGACY_FILE, { idempotent: true });
      } catch {
        // Unreadable or half-written: nothing trustworthy to carry over. Left
        // in place, and the next runtime tries again.
      }
    })();
  }
  return ready;
}

/** Read one value. Falls back to SecureStore ONCE per key, migrating any value
 *  written before this store existed, so an in-flight escalation or a pending
 *  auto-login survives the app update that ships this change. */
export async function getState(key: string): Promise<string | null> {
  await ensureReady();
  const file = fileFor(key);
  try {
    if ((await FileSystem.getInfoAsync(file)).exists) {
      return await FileSystem.readAsStringAsync(file);
    }
  } catch {
    return null;
  }
  const legacy = await SecureStore.getItemAsync(key).catch(() => null);
  if (legacy != null) {
    await setState(key, legacy);
    await SecureStore.deleteItemAsync(key).catch(() => {});
    return legacy;
  }
  return null;
}

export async function setState(key: string, value: string): Promise<void> {
  await ensureReady();
  try {
    await FileSystem.writeAsStringAsync(fileFor(key), value);
  } catch {
    // A failed write leaves the previous value on disk — the next check reads
    // a slightly stale value and self-corrects, which is the same contract the
    // callers already lived by.
  }
}

export async function removeState(key: string): Promise<void> {
  await ensureReady();
  await FileSystem.deleteAsync(fileFor(key), { idempotent: true }).catch(() => {});
}
