/**
 * WebAuthn helpers using @simplewebauthn/server v13.
 *
 * Challenges are stateless: each "get options" call returns the challenge to the
 * route handler, which stores it in a short-lived signed HttpOnly cookie (see
 * lib/auth.ts). This is safe across PM2 cluster instances — no shared server
 * store is required.
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
import { query } from './db';
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

// NOTE: WebAuthn challenges are no longer stored server-side. They are returned
// to the caller (route handler), which persists them in a short-lived signed
// HttpOnly cookie via lib/auth.ts. This is stateless and therefore safe across
// PM2 cluster instances, where a per-process in-memory store would break (the
// GET-options and POST-verify requests can land on different processes).

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
      // Password Manager and synced to the user's account, so once set it
      // persists permanently and needs no re-registration. Unlike 'required',
      // it does not hard-fail on authenticators that lack resident-key support.
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });

  // Challenge is persisted by the route handler in a signed cookie.
  return options;
}

export interface VerifyRegistrationResult {
  verified: boolean;
  credentialId?: string;
  publicKey?: string;
  counter?: number;
}

export async function verifyRegistrationResponse(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  config?: WebAuthnRuntimeConfig,
): Promise<VerifyRegistrationResult> {
  const resolved = resolveConfig(config);
  if (!expectedChallenge) return { verified: false };

  try {
    const { verified, registrationInfo } = await swVerifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: resolved.origin,
      expectedRPID: resolved.rpID,
    });

    if (!verified || !registrationInfo) return { verified: false };

    const { credential } = registrationInfo;
    return {
      verified: true,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
    };
  } catch (err) {
    console.error('[webauthn] Registration verification error:', err);
    return { verified: false };
  }
}

export async function generateAuthenticationOptions(
  employee: Pick<Employee, 'id'>,
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

  // Challenge is persisted by the route handler in a signed cookie.
  return options;
}

export interface VerifyAuthenticationResult {
  verified: boolean;
  newCounter?: number;
  credentialId?: string;
}

export async function verifyAuthenticationResponse(
  employee: Pick<Employee, 'id'>,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  config?: WebAuthnRuntimeConfig,
): Promise<VerifyAuthenticationResult> {
  const resolved = resolveConfig(config);
  if (!expectedChallenge) return { verified: false };

  const passkey = await query<Passkey>(
    'SELECT * FROM passkeys WHERE employee_id = ? AND credential_id = ?',
    [employee.id, response.id],
  ).then(rows => rows[0] ?? null);

  if (!passkey) return { verified: false };

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

    if (!verified) return { verified: false };

    return {
      verified: true,
      newCounter: authenticationInfo.newCounter,
      credentialId: passkey.credential_id,
    };
  } catch (err) {
    console.error('[webauthn] Authentication verification error:', err);
    return { verified: false };
  }
}
