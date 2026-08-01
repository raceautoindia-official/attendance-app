# Google Play submission guide — Attendance app

Everything the app needed in code is already done (v1.1.0): prominent-disclosure
consent screen before any location access, privacy policy at
https://attendance.raceinnovations.in/privacy, private release signing,
cleartext HTTP disabled. This file is the Play Console side.

## 0. One-time critical backups

`android/keystore.properties` and `android/app/release.keystore` are gitignored
on purpose. **Copy both to at least two safe places** (password manager +
offline drive). Losing them means the sideloaded app can never be updated in
place again.

## 1. Developer account (personal — chosen option)

1. https://play.google.com/console → sign up with a Google account, pay $25.
2. Account type: **Personal**. Identity verification needs government ID
   (Aadhaar/passport/DL); usually approved in 1–3 days.
3. Note: personal accounts must run a **closed test with ≥20 testers for 14
   consecutive days** before production access. Use employees as testers —
   collect their Gmail addresses.

## 2. Create the app

- App name: `Attendance` (or `Race Attendance` if taken)
- Type: App, Free
- Package (fixed by the build): `com.attendance.app`

## 3. Store listing content (paste-ready)

- **Short description:** Employee attendance with clock-in/out, shift tracking
  and leave balances for Race Innovations staff.
- **Full description:** Official attendance app for Race Innovations employees.
  Clock in and out from your phone, view worked hours and your last 7 days,
  check leave balances, save your details and documents, and receive shift-end
  reminders. During your shift, the app records your location so work hours and
  site presence can be verified — tracking stops automatically at clock-out and
  a notification is always visible while it is active. An account issued by the
  company is required; the app cannot be used by the public.
- **Privacy policy URL:** `https://attendance.raceinnovations.in/privacy`
- Graphics needed: app icon 512×512 PNG, feature graphic 1024×500, at least 2
  phone screenshots (dashboard + clock-in screen; take them from any phone).
- Category: Business. Contact email: raceautoindia@gmail.com.

## 4. Data safety form (Policy → App content → Data safety)

Declare — collected, NOT shared with third parties, encrypted in transit,
deletion available on request:

| Data type | Collected | Purpose |
|---|---|---|
| Location → Precise location | Yes (incl. background) | App functionality (attendance verification) |
| Personal info → Name, Email, Phone, User IDs | Yes | App functionality, account management |
| Financial info → User payment info (bank details) | Yes (optional, user-entered) | App functionality (payroll records) |
| Personal info → Other (PAN/Aadhaar numbers, documents) | Yes (optional) | App functionality (statutory HR records) |
| Photos → (only if login photo proof is used) | Yes | App functionality |

- "Is all of the user data collected by your app encrypted in transit?" → **Yes**
- "Do you provide a way for users to request that their data is deleted?" →
  **Yes** (via administrator / contact email, per privacy policy)
- Account creation: select "Users can't create an account" (accounts are
  provisioned by the employer) — this exempts the in-app account-deletion URL
  requirement.

## 5. Sensitive permission declarations (App content)

**Location permissions declaration** — the app requests
`ACCESS_BACKGROUND_LOCATION`:

- Core feature requiring it: *"Attendance verification: the app records an
  employee's location during their active work shift (between clock-in and
  clock-out) so the employer can verify work hours and presence at assigned
  work sites. Recording must continue with the screen off or the app closed
  during the shift, which requires background location. Collection stops
  automatically at clock-out."*
- **Demo video** (upload to YouTube unlisted, paste link): record a phone
  screen capture showing, in order —
  1. open app → tap Clock In → the **Location & Data Notice** appears;
  2. tap **I Agree** → Android permission dialogs (precise location → "Allow
     all the time");
  3. dashboard shows "Location tracking is on" and the persistent notification
     is visible in the shade;
  4. tap Clock Out → notification disappears (tracking stopped).
  Keep it under ~1 minute. This exact flow is what reviewers check.

**Foreground service (location) declaration:** purpose = location sharing for
attendance verification, initiated by explicit user action (clock-in),
terminated at clock-out.

## 6. Build & upload

The Play artifact is the **AAB** (not the APK):

```
cd mobile/android
./gradlew bundleRelease        # → app/build/outputs/bundle/release/app-release.aab
```

- Play Console → Testing → **Closed testing** → create track, upload the .aab,
  add tester emails (≥20 employees), start rollout.
- Testers join via the opt-in link and install from Play. From then on,
  **updates are automatic** — no more manual APK reinstalls for testers.
- Accept **Play App Signing** when prompted (Google holds the app signing key;
  our keystore becomes the upload key). Recommended: choose
  "Use a Google-generated key" and let our keystore be the upload key.
- After 14 days with ≥20 opted-in testers, apply for production access in the
  console, then promote the track to Production (or stay on closed testing
  forever — for an internal app that is perfectly fine and keeps auto-updates).

## 7. Each future release

1. Bump `versionCode` (+1) and `versionName` in `android/app/build.gradle`
   and `version` in `app.json`.
2. `./gradlew bundleRelease` and upload the new .aab to the same track.
3. Keep updating `public/Attendance.apk` too until everyone has moved to Play.

## Gotchas

- The v1.1.0+ APK is signed with the NEW private key: phones that installed
  the old debug-signed APK must **uninstall it once** before installing any
  new build (Play or sideload). Their login is preserved server-side.
- Expect the first review to take 3–7 days; a rejection usually cites the
  disclosure/video — the flow above matches the policy, so resubmit with a
  clearer video if that happens.
- After 31 Aug 2026, new uploads must target Android 16 → bump Expo SDK first.
