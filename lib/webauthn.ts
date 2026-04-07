/**
 * WebAuthn helpers using @simplewebauthn/server v13.
 *
 * Challenge storage: challenges are kept in a server-side Map keyed by emp_id.
 * This is fine for development and single-instance deployments. For production
 * with multiple Node processes (PM2 cluster, Kubernetes), replace the Map with
 * a shared store such as Redis with a short TTL (e.g. 5 minutes).
 */

import {
  generateRegistrationOptions as swGenerateRegistrationOptions,
  verifyRegistrationResponse as swVerifyRegistrationResponse,
  generateAuthenticationOptions as swGenerateAuthenticationOptions,
  verifyAuthenticationResponse as swVerifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { query } from './db';
import type { Employee, Passkey } from './types';

// ---------------------------------------------------------------------------
// Environment — read once per module load
// ---------------------------------------------------------------------------

const rpID = process.env.WEBAUTHN_RP_ID ?? 'localhost';
const rpName = process.env.WEBAUTHN_RP_NAME ?? 'Attendance App';
const origin = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000';

// ---------------------------------------------------------------------------
// In-memory challenge store
// TODO: Replace with Redis (e.g. ioredis) for production multi-instance use.
// ---------------------------------------------------------------------------

const challengeStore = new Map<string, string>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Build the options object that the browser passes to
 * `navigator.credentials.create()`. Excludes any passkeys the employee has
 * already registered so the same device cannot be registered twice.
 */
export async function generateRegistrationOptions(
  employee: Pick<Employee, 'id' | 'emp_id' | 'name'>,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existingPasskeys = await query<Pick<Passkey, 'credential_id'>>(
    'SELECT credential_id FROM passkeys WHERE employee_id = ?',
    [employee.id],
  );

  const options = await swGenerateRegistrationOptions({
    rpName,
    rpID,
    // Use the numeric DB id (as bytes) as the stable user handle.
    userID: Buffer.from(String(employee.id)),
    userName: employee.emp_id,
    userDisplayName: employee.name,
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map(pk => ({
      id: pk.credential_id,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });

  challengeStore.set(employee.emp_id, options.challenge);
  return options;
}

export interface VerifyRegistrationResult {
  verified: boolean;
  credentialId?: string;
  publicKey?: string;   // base64url-encoded COSE key — store in DB as-is
  counter?: number;
}

/**
 * Verify the browser's response to `navigator.credentials.create()`.
 * On success, returns the fields that should be persisted to the passkeys table.
 */
export async function verifyRegistrationResponse(
  employee: Pick<Employee, 'emp_id'>,
  response: RegistrationResponseJSON,
): Promise<VerifyRegistrationResult> {
  const expectedChallenge = challengeStore.get(employee.emp_id);
  if (!expectedChallenge) {
    return { verified: false };
  }

  try {
    const { verified, registrationInfo } = await swVerifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    // Consume the challenge regardless of outcome to prevent replay attacks.
    challengeStore.delete(employee.emp_id);

    if (!verified || !registrationInfo) {
      return { verified: false };
    }

    const { credential } = registrationInfo;

    return {
      verified: true,
      credentialId: credential.id,
      // credential.publicKey is Uint8Array; store as base64url string
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
    };
  } catch (err) {
    challengeStore.delete(employee.emp_id);
    console.error('[webauthn] Registration verification error:', err);
    return { verified: false };
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Build the options object that the browser passes to
 * `navigator.credentials.get()`. Populates `allowCredentials` from the
 * employee's registered passkeys.
 */
export async function generateAuthenticationOptions(
  employee: Pick<Employee, 'id' | 'emp_id'>,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const passkeys = await query<Pick<Passkey, 'credential_id'>>(
    'SELECT credential_id FROM passkeys WHERE employee_id = ?',
    [employee.id],
  );

  const options = await swGenerateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map(pk => ({ id: pk.credential_id })),
    userVerification: 'required',
  });

  challengeStore.set(employee.emp_id, options.challenge);
  return options;
}

export interface VerifyAuthenticationResult {
  verified: boolean;
  newCounter?: number;
  credentialId?: string;
}

/**
 * Verify the browser's response to `navigator.credentials.get()`.
 * Looks up the matching passkey from the DB, runs the cryptographic check,
 * and returns the new counter value that must be persisted.
 */
export async function verifyAuthenticationResponse(
  employee: Pick<Employee, 'id' | 'emp_id'>,
  response: AuthenticationResponseJSON,
): Promise<VerifyAuthenticationResult> {
  const expectedChallenge = challengeStore.get(employee.emp_id);
  if (!expectedChallenge) {
    return { verified: false };
  }

  // Look up the passkey that the authenticator claims to be using.
  const passkey = await query<Passkey>(
    'SELECT * FROM passkeys WHERE employee_id = ? AND credential_id = ?',
    [employee.id, response.id],
  ).then(rows => rows[0] ?? null);

  if (!passkey) {
    challengeStore.delete(employee.emp_id);
    return { verified: false };
  }

  try {
    const { verified, authenticationInfo } = await swVerifyAuthenticationResponse(
      {
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credential_id,
          // Decode base64url string back to Uint8Array for the crypto check.
          publicKey: new Uint8Array(
            Buffer.from(passkey.public_key, 'base64url'),
          ),
          counter: Number(passkey.counter),
        },
      },
    );

    challengeStore.delete(employee.emp_id);

    if (!verified) return { verified: false };

    return {
      verified: true,
      newCounter: authenticationInfo.newCounter,
      credentialId: passkey.credential_id,
    };
  } catch (err) {
    challengeStore.delete(employee.emp_id);
    console.error('[webauthn] Authentication verification error:', err);
    return { verified: false };
  }
}
