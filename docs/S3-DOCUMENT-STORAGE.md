# Employee documents in S3 — setup

Until a bucket is configured, documents are stored in the database exactly as
before, capped at 3 MB. Nothing breaks without this; it just stays on the old
path. Configure the four variables below and uploads switch to S3 on the next
restart.

---

## 1. Environment variables

Add to `.env` on the server (and `.env.local` for development):

```ini
S3_BUCKET=race-attendance-documents
S3_REGION=ap-south-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
# Optional. Everything is written under this prefix so the bucket can be shared.
S3_PREFIX=employee-documents
```

If `S3_REGION`, `S3_ACCESS_KEY_ID` or `S3_SECRET_ACCESS_KEY` are absent, the app
falls back to the existing `SES_*` values — the SES integration already uses IAM
keys in this account. **`S3_BUCKET` has no fallback**, so nothing switches over
by accident: setting the bucket is the deliberate act that turns S3 on.

Check which path is live without reading the file: the upload panel states
either "up to 15 MB" or "up to 3 MB … configure an S3 bucket to allow larger
files".

---

## 2. The bucket

**Create it private. Block all public access.** These are Aadhaar cards, PAN
cards and government IDs. The app never hands out an object URL — every read is
a presigned link that expires after five minutes.

**Turn on default bucket encryption (`AES256`).** The upload does *not* request
encryption per object, deliberately: the browser PUTs to a presigned URL, and
every header the signature covers has to be reproduced by the browser exactly.
An `x-amz-server-side-encryption` header cannot ride in the query string the way
`Content-Type` can, so asking for encryption there would oblige the browser to
send that header and S3 would answer `SignatureDoesNotMatch` when it did not.
The bucket default covers every object instead, whoever writes it. S3 has
encrypted new objects with `AES256` by default since January 2023, so a new
bucket already satisfies this; set it explicitly anyway so it cannot be
turned off without someone noticing.

### CORS — required, or uploads fail

The browser PUTs the file straight to S3, so the bucket must accept a
cross-origin PUT from the app's domain. **This is the single most likely thing
to be wrong**: the request never reaches the application server, so there is
nothing in the application log to find. The upload error names CORS for that
reason.

```json
[
  {
    "AllowedHeaders": ["Content-Type"],
    "AllowedMethods": ["PUT"],
    "AllowedOrigins": ["https://worklens.raceinnovations.in"],
    "ExposeHeaders": [],
    "MaxAgeSeconds": 3000
  }
]
```

Use the real origin, not `*`. A wildcard would let any site PUT with a URL it
had somehow obtained.

### Lifecycle — clean up abandoned uploads

A presigned URL is issued before the browser sends anything, so a cancelled
upload can leave an object nothing points at. One rule handles it:

```
Prefix: employee-documents/
Abort incomplete multipart uploads after: 1 day
```

Deleting a document removes the row first and the object second — deliberately.
An orphaned object is invisible and cheap; a row whose file is gone is a
document that looks filed and cannot be opened, which costs somebody their proof
of identity.

---

## 3. IAM policy

The narrowest policy that works. The app never lists the bucket and never reads
anything outside its own prefix.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::race-attendance-documents/employee-documents/*"
    }
  ]
}
```

`s3:ListBucket` is deliberately absent. Nothing in the app enumerates the
bucket, and without it a leaked key cannot be used to discover what is stored.

---

## 4. How an upload goes

1. Browser asks the app for somewhere to put the file.
2. App checks the caller may access that employee, then returns a presigned PUT
   valid for five minutes, pinned to the exact content type and byte length.
3. Browser PUTs straight to S3. **The bytes never pass through the app**, which
   is why the limit rises from 3 MB to 15 MB — nginx caps a request body at
   5 MB, and that only ever applied because the file used to travel through it.
4. Browser tells the app the key.
5. App confirms the object actually arrived, checks the key belongs to that
   employee, and only then records it.

Step 5 matters twice. The confirmation stops a failed upload filing a document
that does not exist. The ownership check stops a caller filing somebody else's
object — or any object in the bucket — against an employee.

Downloads redirect to a five-minute presigned GET, so existing links and
`window.open` keep working unchanged.

---

## 4a. "Configured" means the variables are set, not that they work

`isS3Configured()` tests only that the four variables are present. Presigning a
URL is a **local** signing operation that never contacts AWS, so a bad key
produces a perfectly valid-looking URL whose PUT then fails in the browser.

The practical consequence: **once `S3_BUCKET` is set, uploads no longer fall
back to the database.** If the credentials are wrong, uploads fail rather than
quietly reverting. To go back to the database path, blank `S3_BUCKET` and
restart.

Confirm credentials actually work before relying on them:

```bash
npx tsx --env-file=.env.local scripts/verify-document-storage.ts
```

With a bucket configured it performs a real presign, PUT, read-back and delete,
and removes whatever it created.

## 5. Existing documents

Rows written before this stay in the database and keep working — each row
records its own storage, so both paths are readable forever. **Production has
zero documents**, so there is nothing to migrate; the first upload after
configuring the bucket is the first S3 object.

---

## 6. If it goes wrong

| Symptom | Cause |
|---|---|
| "Upload to storage failed (0)" or a CORS error in the browser console | Bucket CORS does not allow PUT from this origin |
| "Upload to storage failed (403)" | IAM key lacks `s3:PutObject`, or the key signed a different content type or length than the browser sent |
| "The file never finished uploading" | The PUT did not complete; the app refused to file a document whose object is absent |
| "Storage rejected the upload (403)" | The access key is invalid or lacks `s3:PutObject` on the prefix |
| `InvalidAccessKeyId` from any tooling | The key does not exist in AWS at all — deleted, or never created. A well-formed `AKIA…` key still gets this if it was removed from IAM |
| `SignatureDoesNotMatch` | Either the secret does not match the key id, or the presigned URL covers a header the browser does not send. `verify-document-storage.ts` checks the second case directly — it lists the signed headers and fails if any is one a browser cannot set |
| Panel still says 3 MB | `S3_BUCKET` is not set, or the app has not been restarted |
| "This document is stored in S3, but no bucket is configured" | An S3-stored row is being read on a server whose bucket config was removed |
