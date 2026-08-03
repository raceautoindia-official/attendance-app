// Importing these modules registers the background tasks (location updates and
// geofence auto-attendance) at app startup, so the OS can invoke them even
// after the app is killed and relaunched in the background.
import './src/location/tracking';
import './src/location/geofenceAuto';

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StatusBar, StyleSheet } from 'react-native';
import { getAccessToken } from './src/storage/tokens';
import { stopBackgroundTracking } from './src/location/tracking';
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

  useEffect(() => {
    (async () => {
      const token = await getAccessToken();
      if (!token) {
        setAuthed(false);
        return;
      }
      setAuthed(true);
      await runUnlock(); // existing session still requires biometric to open
    })();
  }, [runUnlock]);

  useEffect(() => {
    if (authed === false) {
      void stopBackgroundTracking();
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

  if (authed === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="light-content" />
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
          <TouchableOpacity onPress={onLogout} style={{ marginTop: 18 }}>
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
