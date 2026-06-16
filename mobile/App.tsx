// Importing the tracking module registers the background location task at app
// startup, so the OS can invoke it even after the app is relaunched.
import './src/location/tracking';

import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StatusBar } from 'react-native';
import { getAccessToken } from './src/storage/tokens';
import LoginScreen from './src/screens/LoginScreen';
import DashboardScreen from './src/screens/DashboardScreen';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    getAccessToken().then((t) => setAuthed(!!t));
  }, []);

  if (authed === null) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0f172a', justifyContent: 'center' }}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle="light-content" />
      {authed ? (
        <DashboardScreen onLogout={() => setAuthed(false)} />
      ) : (
        <LoginScreen onLoggedIn={() => setAuthed(true)} />
      )}
    </>
  );
}
