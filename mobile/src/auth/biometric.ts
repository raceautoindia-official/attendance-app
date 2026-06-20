import * as LocalAuthentication from 'expo-local-authentication';

// True only if the device has biometric hardware AND the user has enrolled a
// fingerprint/face. If false, the app falls back to PIN-only (no second factor).
export async function biometricAvailable(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

// Prompts for fingerprint/face (with device-PIN/pattern fallback). Returns true
// on success. This is the mobile equivalent of the web's passkey second factor.
export async function authenticateBiometric(prompt = 'Verify your identity'): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false, // allow device PIN/pattern if biometric fails
    });
    return result.success;
  } catch {
    return false;
  }
}
