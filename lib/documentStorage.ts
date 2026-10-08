import { randomUUID } from 'crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * lib/documentStorage.ts — where an employee's documents actually live.
 *
 * WHY S3
 * ------
 * Documents used to be base64 in a LONGTEXT column. That is why the upload cap
 * is 3 MB: nginx stops a request body at 5 MB and base64 inflates a file by a
 * third. Aadhaar cards, PAN cards and scanned government IDs are precisely the
 * documents that arrive as large photographs, so the cap bites in practice. It
 * also pulled every file through the app and the database connection on read.
 *
 * With S3 the browser PUTs straight to the bucket using a presigned URL —
 * past nginx entirely — and reads come back as short-lived presigned links.
 * The database holds metadata and a key.
 *
 * BOTH PATHS STAY
 * ---------------
 * `isS3Configured()` is false when no bucket is set, and everything then falls
 * back to the database exactly as before. A deployment that has not been given
 * a bucket keeps working rather than failing to upload — the same rule as
 * policies and the unpaid-break column. Rows written either way remain readable
 * forever, because each row records its own storage.
 *
 * WHAT NEVER HAPPENS
 * ------------------
 * The bucket is never public and no object URL is ever handed out directly.
 * Every read is a presigned link that expires. These are identity documents;
 * a link that works forever is a leak with a delay on it.
 */

const BUCKET = process.env.S3_BUCKET?.trim();
const REGION = process.env.S3_REGION?.trim() ?? process.env.SES_REGION?.trim();
const KEY_ID = process.env.S3_ACCESS_KEY_ID?.trim() ?? process.env.SES_ACCESS_KEY_ID?.trim();
const SECRET = process.env.S3_SECRET_ACCESS_KEY?.trim() ?? process.env.SES_SECRET_ACCESS_KEY?.trim();
/** Everything is written under this prefix, so the bucket can be shared. */
const PREFIX = (process.env.S3_PREFIX?.trim() ?? 'employee-documents').replace(/^\/+|\/+$/g, '');

/** How long an upload or download link stays valid. */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** With a bucket configured, the browser uploads direct and nginx is not in the way. */
export const MAX_S3_BYTES = 15 * 1024 * 1024;

export function isS3Configured(): boolean {
  return Boolean(BUCKET && REGION && KEY_ID && SECRET);
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!isS3Configured()) {
    throw new Error('S3 is not configured — set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
  }
  client ??= new S3Client({
    region: REGION!,
    credentials: { accessKeyId: KEY_ID!, secretAccessKey: SECRET! },
  });
  return client;
}

/**
 * A key that cannot collide and cannot be guessed.
 *
 * The employee id is in the path so the bucket is navigable when somebody has
 * to go looking; the UUID means knowing an employee id tells you nothing about
 * where their documents are. The original filename is NOT used — these are
 * identity documents and a filename like "ravi-aadhaar.jpg" in a bucket listing
 * discloses something on its own.
 */
/**
 * The prefix every one of an employee's objects sits under.
 *
 * Used to check that a key handed back after a presigned upload is one this
 * server would have issued for THAT employee. Without the check, a caller could
 * file somebody else's object — or any object in the bucket — against them.
 */
export function keyPrefixFor(employeeId: number): string {
  return `${PREFIX}/${employeeId}`;
}

export function buildKey(employeeId: number, docType: string, fileName: string): string {
  const ext = (fileName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
  return `${PREFIX}/${employeeId}/${docType}/${randomUUID()}.${ext}`;
}

/** A URL the browser can PUT the file to, valid briefly. */
export async function presignUpload(params: {
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: BUCKET!,
      Key: params.key,
      ContentType: params.contentType,
      // Pinning the length stops a signed URL being reused to upload something
      // much larger than the one that was approved.
      ContentLength: params.contentLength,
      // Encryption is NOT requested here, deliberately. Every header covered by
      // the signature must be reproduced byte for byte by whoever PUTs the file,
      // and an x-amz-* header cannot be carried in the query string the way
      // Content-Type can - so adding ServerSideEncryption here would oblige the
      // browser to send x-amz-server-side-encryption too, and S3 answers
      // SignatureDoesNotMatch when it does not. The bucket's default encryption
      // covers the object instead: it applies to everything written by any route,
      // not just this one, and S3 has encrypted new objects by default since
      // January 2023. Only add a signed header here if the client sends it as well.
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );
}

/** A short-lived URL to read the object back. */
export async function presignDownload(key: string, fileName: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: BUCKET!,
      Key: key,
      // Make the browser save it under its original name rather than the UUID.
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\]/g, '')}"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}

/**
 * Did the object actually arrive, and how big is it?
 *
 * A presigned upload is recorded before the browser has finished sending, so
 * the row can exist while the object does not. Confirming afterwards is what
 * stops a half-finished upload looking like a filed document.
 */
export async function headObject(key: string): Promise<{ exists: boolean; size: number; contentType?: string }> {
  try {
    const res = await s3().send(new HeadObjectCommand({ Bucket: BUCKET!, Key: key }));
    return { exists: true, size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
  } catch {
    return { exists: false, size: 0 };
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: BUCKET!, Key: key }));
}

/** What the admin UI needs to explain the current setup. */
export function storageStatus(): {
  configured: boolean;
  bucket: string | null;
  region: string | null;
  prefix: string;
  max_bytes: number;
  note: string;
} {
  const configured = isS3Configured();
  return {
    configured,
    // The bucket name is not a secret and is useful when something is wrong.
    // The credentials are never returned.
    bucket: configured ? BUCKET! : null,
    region: configured ? REGION! : null,
    prefix: PREFIX,
    max_bytes: configured ? MAX_S3_BYTES : 3 * 1024 * 1024,
    note: configured
      ? 'Files upload straight to S3 and are read back through short-lived links.'
      : 'No bucket configured, so files are stored in the database as before, capped at 3 MB.',
  };
}
