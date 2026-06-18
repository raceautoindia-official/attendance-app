import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';

const PACKAGE = 'com.attendance.app';

// Opens the system "ignore battery optimization" dialog (one tap "Allow").
// This is what keeps the foreground tracking service alive when the screen is
// off on most phones. Falls back to the app's settings page if the OEM doesn't
// support the direct action.
export async function requestIgnoreBatteryOptimization(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync(
      'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      { data: `package:${PACKAGE}` },
    );
  } catch {
    try {
      await IntentLauncher.startActivityAsync(
        'android.settings.APPLICATION_DETAILS_SETTINGS',
        { data: `package:${PACKAGE}` },
      );
    } catch {
      // give up silently
    }
  }
}

// Opens the app's details page (where the user can set Battery -> Unrestricted
// and Permissions -> Location -> Allow all the time). Used by the in-app
// "Fix tracking" helper.
export async function openAppSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync(
      'android.settings.APPLICATION_DETAILS_SETTINGS',
      { data: `package:${PACKAGE}` },
    );
  } catch {
    // ignore
  }
}
