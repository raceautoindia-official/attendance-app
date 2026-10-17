// Importing these modules registers the background tasks (location updates and
// geofence auto-attendance) at app startup, so the OS can invoke them even
// after the app is killed and relaunched in the background.
import './src/location/tracking';
import './src/location/geofenceAuto';
import './src/location/locationWatch';

import { initNotifications } from './src/notifications/setup';
import { markDecisionAnnounced } from './src/notifications/permissionUpdates';
import * as Notifications from 'expo-notifications';

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StatusBar, StyleSheet } from 'react-native';
import { getAccessToken } from './src/storage/tokens';
import { logout } from './src/api/client';
import { endLocalSession } from './src/auth/session';
import { biometricAvailable, authenticateBiometric } from './src/auth/biometric';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null); // has a saved session
  const [unlocked, setUnlocked] = useState(false);            // passed biometric this session

  // Biometric (fingerprint/face) gate — the mobile equivalent of a passkey.
  // If the device has no biometrics enrolled, fall back to allowing access
  // (PIN-only), so the app never locks someone out.
  const runUnlock = useCallback(async () => {
    const available = await biometricAvailable();
    if (!available) {
      setUnlocked(true);
      return;
    }
    const ok = await authenticateBiometric('Unlock Attendance');
    setUnlocked(ok);
  }, []);

  // Notification channels, the foreground handler, and the one prompt for
  // POST_NOTIFICATIONS — done ONCE, here, at launch.
  //
  // It used to be asked for at clock-in, inside the shift-reminder module. The
  // warnings that matter most are raised from background tasks, which cannot
  // show a permission dialog at all — so on a phone where clock-in had never
  // taken that path, every away-from-site warning was posted into a void with
  // no error to show for it.
  useEffect(() => {
    void initNotifications();
    // A pushed decision seen with the app open, or tapped to open it, is
    // already announced — the dashboard's own announcement must not repeat it
    // in the moments before the server has confirmed the push was delivered.
    const received = Notifications.addNotificationReceivedListener(n => {
      void markDecisionAnnounced(n.request.content.data);
    });
    const tapped = Notifications.addNotificationResponseReceivedListener(r => {
      void markDecisionAnnounced(r.notification.request.content.data);
    });
    return () => {
      received.remove();
      tapped.remove();
    };
  }, []);

  // Could the saved session be read at all? Not the same as "there is none".
  // A secure-storage read can fail outright on some phones, and an unhandled
  // failure here left the launch spinner up for ever. Treating it as signed
  // out would be worse — that stops tracking mid-shift — so it is said, with a
  // way to try again.
  const [bootFailed, setBootFailed] = useState(false);

  const boot = useCallback(async () => {
    setBootFailed(false);
    let token: string | null;
    try {
      token = await getAccessToken();
    } catch {
      setBootFailed(true);
      return;
    }
    if (!token) {
      setAuthed(false);
      return;
    }
    setAuthed(true);
    await runUnlock(); // existing session still requires biometric to open
  }, [runUnlock]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (authed === false) {
      // Covers FORCED logouts (expired or revoked session) too, not just the
      // buttons — the same full list either way, see endLocalSession.
      void endLocalSession();
    }
  }, [authed]);

  const onLoggedIn = () => {
    setAuthed(true);
    setUnlocked(true); // LoginScreen already did the biometric check
  };
  const onLogout = () => {
    setAuthed(false);
    setUnlocked(false);
  };
  // The unlock screen's Sign out. It used to change only what was on screen:
  // the saved session stayed, so closing and reopening the app went straight
  // back to "Unlock to continue" — signed in all along.
  const signOutFromLock = async () => {
    await logout();
    onLogout();
  };

  if (authed === null) {
    return (
      <View style={styles.center}>
        {bootFailed ? (
          <>
            <Text style={styles.subtitle}>Could not open your saved sign-in.</Text>
            <TouchableOpacity style={styles.button} onPress={() => { void boot(); }} activeOpacity={0.85}>
              <Text style={styles.buttonText}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : (
          <ActivityIndicator color="#3b82f6" size="large" />
        )}
      </View>
    );
  }

  // translucent + transparent so the status bar sits OVER the app's own dark
  // background instead of a system-drawn strip. The app draws edge to edge
  // (edgeToEdgeEnabled=true, and Android 15 enforces it), so the header pads
  // itself down past the status bar — see STATUS_BAR_PAD in DashboardScreen.
  return (
    <>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      {!authed ? (
        <LoginScreen onLoggedIn={onLoggedIn} />
      ) : !unlocked ? (
        <View style={styles.center}>
          <View style={styles.logo}>
            <Text style={styles.logoCheck}>✓</Text>
          </View>
          <Text style={styles.title}>Attendance</Text>
          <Text style={styles.subtitle}>Unlock to continue</Text>
          <TouchableOpacity style={styles.button} onPress={runUnlock} activeOpacity={0.85}>
            <Text style={styles.buttonText}>🔒  Unlock with fingerprint / face</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { void signOutFromLock(); }} style={{ marginTop: 18 }}>
            <Text style={styles.signout}>Sign out</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <DashboardScreen onLogout={onLogout} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', padding: 24 },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCheck: { color: '#fff', fontSize: 30, fontWeight: '900', lineHeight: 34 },
  title: { color: '#f1f5f9', fontSize: 24, fontWeight: '700', marginTop: 16 },
  subtitle: { color: '#94a3b8', fontSize: 14, marginTop: 4, marginBottom: 28 },
  button: { backgroundColor: '#2563eb', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 24 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  signout: { color: '#94a3b8', fontSize: 14 },
});
