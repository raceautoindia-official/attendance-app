import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { login, requestPasswordReset } from '../api/client';
import { biometricAvailable, authenticateBiometric } from '../auth/biometric';
import { colors } from '../theme';

export default function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [empId, setEmpId] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);

  // Forgot PIN: the server emails a single-use link to the address on the
  // employee's record. It answers the same way whether or not the ID exists —
  // employee IDs here are short and guessable, and a "no such employee" reply
  // would turn this button into a way to enumerate them.
  const forgotPin = async () => {
    setError(null);
    setResetNote(null);
    if (!empId.trim()) {
      setError('Type your Employee ID first, then tap Forgot PIN.');
      return;
    }
    setResetBusy(true);
    try {
      const message = await requestPasswordReset(empId.trim());
      setResetNote(message);
    } catch (e) {
      // The server DOES report one thing plainly: itself being unable to send
      // mail. Waiting for an email nobody could have sent is worse than being
      // told to ask an admin.
      setError(e instanceof Error ? e.message : 'Could not request a reset.');
    } finally {
      setResetBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!empId.trim() || !pin.trim()) {
      setError('Enter your Employee ID and PIN.');
      return;
    }
    setLoading(true);
    try {
      await login(empId.trim(), pin.trim());
      // Second factor: require fingerprint/face if the device supports it
      // (the mobile equivalent of the web's passkey).
      if (await biometricAvailable()) {
        const ok = await authenticateBiometric("Confirm it's you");
        if (!ok) {
          setError('Fingerprint / face verification is required to sign in.');
          return;
        }
      }
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        {/* Brand row — blue shield-check logo + wordmark, like the website */}
        <View style={styles.brandRow}>
          <View style={styles.logo}>
            <Text style={styles.logoCheck}>✓</Text>
          </View>
          <Text style={styles.brandName}>Attendance</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Sign in</Text>
          <Text style={styles.subtitle}>Enter your employee ID and PIN</Text>

          <Text style={styles.label}>Employee ID</Text>
          <TextInput
            style={styles.input}
            value={empId}
            onChangeText={setEmpId}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="e.g. RACE005"
            placeholderTextColor={colors.textFaint}
          />

          <Text style={[styles.label, { marginTop: 16 }]}>PIN</Text>
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            placeholder="6-digit PIN"
            placeholderTextColor={colors.textFaint}
          />

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={submit}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.forgotBtn}
            onPress={() => { void forgotPin(); }}
            disabled={resetBusy}
            activeOpacity={0.7}
          >
            <Text style={styles.forgotText}>
              {resetBusy ? 'Sending…' : 'Forgot PIN?'}
            </Text>
          </TouchableOpacity>

          {resetNote && <Text style={styles.resetNote}>{resetNote}</Text>}
        </View>

        <Text style={styles.footer}>Mark your attendance securely</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', padding: 20 },
  inner: { width: '100%', maxWidth: 400, alignSelf: 'center' },
  forgotBtn: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 8 },
  forgotText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  resetNote: {
    color: colors.greenText, fontSize: 13, lineHeight: 19, textAlign: 'center',
    backgroundColor: 'rgba(22,163,74,0.12)', borderRadius: 10, padding: 12, marginTop: 4,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  logo: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCheck: { color: '#fff', fontSize: 20, fontWeight: '900', lineHeight: 22 },
  brandName: { fontSize: 18, fontWeight: '700', color: colors.text },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 24,
    shadowColor: '#0f172a',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  title: { fontSize: 20, fontWeight: '600', color: colors.text },
  subtitle: { fontSize: 14, color: colors.textMuted, marginTop: 4, marginBottom: 20 },
  label: { fontSize: 14, fontWeight: '500', color: colors.textLabel, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.borderInput,
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: colors.text,
  },
  errorBox: {
    backgroundColor: colors.redBg,
    borderWidth: 1,
    borderColor: colors.redBorder,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 16,
  },
  errorText: { color: colors.redText, fontSize: 13 },
  button: {
    backgroundColor: colors.brand,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  footer: { textAlign: 'center', color: colors.textFaint, fontSize: 12, marginTop: 24 },
});
