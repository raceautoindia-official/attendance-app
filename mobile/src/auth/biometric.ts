import * as LocalAuthentication from 'expo-local-authentication';
import { withTimeout } from '../util/withTimeout';

// Both calls below sit between the employee and a working sign-in, so neither
// may wait indefinitely. The hardware queries are quick native calls and get a
// short deadline; the prompt waits for a finger, so it gets a patient one.
const PROBE_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 120_000;

// True only if the device has biometric hardware AND the user has enrolled a
// fingerprint/face. If false, the app falls back to PIN-only (no second factor).
export async function biometricAvailable(): Promise<boolean> {
  try {
    // A deadline here resolves to "no biometrics", which is the same answer
    // the catch below already gives for a sensor that errors — so a wedged
    // hardware query downgrades to PIN-only sign-in rather than blocking
    // sign-in altogether. That is the existing trade-off in this file, not a
    // new one; it is written down because it is a security-relevant default.
    const hasHardware = await withTimeout(
      LocalAuthentication.hasHardwareAsync(), PROBE_TIMEOUT_MS, 'probe timed out',
    );
    const enrolled = await withTimeout(
      LocalAuthentication.isEnrolledAsync(), PROBE_TIMEOUT_MS, 'probe timed out',
    );
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

// Prompts for fingerprint/face (with device-PIN/pattern fallback). Returns true
// on success. This is the mobile equivalent of the web's passkey second factor.
export async function authenticateBiometric(prompt = 'Verify your identity'): Promise<boolean> {
  try {
    // Two minutes, then FALSE — which refuses the sign-in and shows the
    // "fingerprint / face verification is required" message. Timing out must
    // never resolve the other way: this is the second factor, and a prompt
    // nobody answered is not a prompt somebody passed.
    //
    // Before the deadline, a prompt left on screen — a dirty sensor, a phone
    // put down mid-login — held LoginScreen's spinner with nothing to release
    // it, which is one of the two shapes of "sign-in loaded for hours".
    const result = await withTimeout(
      LocalAuthentication.authenticateAsync({
        promptMessage: prompt,
        cancelLabel: 'Cancel',
        disableDeviceFallback: false, // allow device PIN/pattern if biometric fails
      }),
      PROMPT_TIMEOUT_MS,
      'biometric prompt timed out',
    );
    return result.success;
  } catch {
    return false;
  }
}
