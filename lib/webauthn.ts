/**
 * WebAuthn helpers using @simplewebauthn/server v13.
 *
 * Challenge storage is DB-backed (the `webauthn_challenges` table, keyed by
 * emp_id). This is shared across all PM2 cluster processes and does not depend
 * on cookies surviving the round-trip or on the server clock being correct, so
 * the register/authenticate ceremonies work reliably. The table is auto-created
 * on first use if it does not already exist.
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
import type { NextRequest } from 'next/server';
import { query, queryOne } from './db';
import type { Employee, Passkey } from './types';

export type WebAuthnRuntimeConfig = {
  rpID?: string;
  origin?: string;
  rpName?: string;
};

const defaultRpName = process.env.WEBAUTHN_RP_NAME ?? 'Attendance App';

function resolveConfig(config?: WebAuthnRuntimeConfig) {
  return {
    rpID: config?.rpID ?? process.env.WEBAUTHN_RP_ID ?? 'localhost',
    rpName: config?.rpName ?? defaultRpName,
    origin: config?.origin ?? process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3000',
  };
}

export function getWebAuthnConfigFromRequest(request: NextRequest): WebAuthnRuntimeConfig {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost ?? request.headers.get('host') ?? request.nextUrl.host;
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const proto = forwardedProto ?? request.nextUrl.protocol.replace(':', '') ?? 'http';
  const hostname = host.split(':')[0];

  return {
    rpID: process.env.WEBAUTHN_RP_ID ?? hostname,
    origin: process.env.WEBAUTHN_ORIGIN ?? `${proto}://${host}`,
    rpName: process.env.WEBAUTHN_RP_NAME ?? defaultRpName,
  };
}

// ---------------------------------------------------------------------------
// Challenge store — DB-backed, cluster-safe, clock-independent.
// ---------------------------------------------------------------------------

let challengeTableReady = false;

async function ensureChallengeTable(): Promise<void> {
  if (challengeTableReady) return;
  await query(
    `CREATE TABLE IF NOT EXISTS webauthn_challenges (
       emp_id     VARCHAR(20)  NOT NULL,
       challenge  VARCHAR(255) NOT NULL,
       created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (emp_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  challengeTableReady = true;
}

async function storeChallenge(empId: string, challenge: string): Promise<void> {
  await ensureChallengeTable();
  await query(
    `INSERT INTO webauthn_challenges (emp_id, challenge, created_at)
     VALUES (?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE challenge = VALUES(challenge), created_at = UTC_TIMESTAMP()`,
    [empId, challenge],
  );
}

async function getChallenge(empId: string): Promise<string | null> {
  await ensureChallengeTable();
  const row = await queryOne<{ challenge: string }>(
    'SELECT challenge FROM webauthn_challenges WHERE emp_id = ?',
    [empId],
  );
  return row?.challenge ?? null;
}

async function deleteChallenge(empId: string): Promise<void> {
  try {
    await query('DELETE FROM webauthn_challenges WHERE emp_id = ?', [empId]);
  } catch {
    // Non-fatal: a stale challenge is overwritten on the next attempt anyway.
  }
}

export async function generateRegistrationOptions(
  employee: Pick<Employee, 'id' | 'emp_id' | 'name'>,
  config?: WebAuthnRuntimeConfig,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const resolved = resolveConfig(config);
  const existingPasskeys = await query<Pick<Passkey, 'credential_id'>>(
    'SELECT credential_id FROM passkeys WHERE employee_id = ?',
    [employee.id],
  );

  const options = await swGenerateRegistrationOptions({
    rpName: resolved.rpName,
    rpID: resolved.rpID,
    userID: Buffer.from(String(employee.id)),
    userName: employee.emp_id,
    userDisplayName: employee.name,
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map(pk => ({ id: pk.credential_id })),
    authenticatorSelection: {
      // 'preferred' creates a discoverable (resident) passkey when the device
      // supports it — on Android/Chrome that means it is saved to Google
      // Password Manager and synced, so once set it persists permanently. It
      // does not hard-fail on authenticators that lack resident-key support.
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });

  await storeChallenge(employee.emp_id, options.challenge);
  return options;
}

export interface VerifyRegistrationResult {
  verified: boolean;
  credentialId?: string;
  publicKey?: string;
  counter?: number;
  error?: string;
}

export async function verifyRegistrationResponse(
  employee: Pick<Employee, 'emp_id'>,
  response: RegistrationResponseJSON,
  config?: WebAuthnRuntimeConfig,
): Promise<VerifyRegistrationResult> {
  const resolved = resolveConfig(config);
  const expectedChallenge = await getChallenge(employee.emp_id);
  if (!expectedChallenge) {
    return { verified: false, error: 'No registration challenge found. Please tap Register passkey again.' };
  }

  try {
    const { verified, registrationInfo } = await swVerifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: resolved.origin,
      expectedRPID: resolved.rpID,
    });

    await deleteChallenge(employee.emp_id);

    if (!verified || !registrationInfo) {
      return { verified: false, error: 'Attestation could not be verified.' };
    }

    const { credential } = registrationInfo;
    return {
      verified: true,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
    };
  } catch (err) {
    await deleteChallenge(employee.emp_id);
    console.error('[webauthn] Registration verification error:', err, {
      expectedOrigin: resolved.origin,
      expectedRPID: resolved.rpID,
    });
    return { verified: false, error: (err as Error).message };
  }
}

export async function generateAuthenticationOptions(
  employee: Pick<Employee, 'id' | 'emp_id'>,
  config?: WebAuthnRuntimeConfig,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const resolved = resolveConfig(config);
  const passkeys = await query<Pick<Passkey, 'credential_id'>>(
    'SELECT credential_id FROM passkeys WHERE employee_id = ?',
    [employee.id],
  );

  const options = await swGenerateAuthenticationOptions({
    rpID: resolved.rpID,
    allowCredentials: passkeys.map(pk => ({ id: pk.credential_id })),
    userVerification: 'required',
  });

  await storeChallenge(employee.emp_id, options.challenge);
  return options;
}

export interface VerifyAuthenticationResult {
  verified: boolean;
  newCounter?: number;
  credentialId?: string;
  error?: string;
}

export async function verifyAuthenticationResponse(
  employee: Pick<Employee, 'id' | 'emp_id'>,
  response: AuthenticationResponseJSON,
  config?: WebAuthnRuntimeConfig,
): Promise<VerifyAuthenticationResult> {
  const resolved = resolveConfig(config);
  const expectedChallenge = await getChallenge(employee.emp_id);
  if (!expectedChallenge) {
    return { verified: false, error: 'No login challenge found. Please try signing in again.' };
  }

  const passkey = await query<Passkey>(
    'SELECT * FROM passkeys WHERE employee_id = ? AND credential_id = ?',
    [employee.id, response.id],
  ).then(rows => rows[0] ?? null);

  if (!passkey) {
    await deleteChallenge(employee.emp_id);
    return { verified: false, error: 'This passkey is not registered for your account.' };
  }

  try {
    const { verified, authenticationInfo } = await swVerifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: resolved.origin,
      expectedRPID: resolved.rpID,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64url')),
        counter: Number(passkey.counter),
      },
    });

    await deleteChallenge(employee.emp_id);

    if (!verified) return { verified: false, error: 'Assertion could not be verified.' };

    return {
      verified: true,
      newCounter: authenticationInfo.newCounter,
      credentialId: passkey.credential_id,
    };
  } catch (err) {
    await deleteChallenge(employee.emp_id);
    console.error('[webauthn] Authentication verification error:', err, {
      expectedOrigin: resolved.origin,
      expectedRPID: resolved.rpID,
    });
    return { verified: false, error: (err as Error).message };
  }
}
