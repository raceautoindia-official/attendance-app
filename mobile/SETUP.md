# Attendance Mobile App (React Native / Expo)

A native Android app for employees: PIN login, clock in/out, and **background
location tracking** that continues with the screen off / app in the pocket.
It talks to your existing Next.js backend over HTTPS.

```
mobile/
  App.tsx                     app entry; registers the background task
  app.json                    Expo config + Android location permissions
  eas.json                    EAS Build profiles (APK / AAB)
  src/
    config.ts                 API base URL + tracking interval  <-- EDIT THIS
    storage/tokens.ts         secure token storage (Android Keystore)
    api/client.ts             fetch wrapper: bearer token + auto refresh
    location/tracking.ts      background location task -> /api/live-tracking
    screens/LoginScreen.tsx
    screens/DashboardScreen.tsx
```

## Backend: already done

Two endpoints were added to the Next.js app for the mobile token flow (the web
login uses passkeys, which the app can't use):

- `POST /api/auth/mobile/login`  → returns `{ accessToken, refreshToken, employee }`
- `POST /api/auth/mobile/refresh` → rotates and returns a fresh token pair

All other endpoints already accept `Authorization: Bearer <token>`, so the app
reuses your existing `/api/attendance/*` and `/api/live-tracking/*` routes.
**Deploy the backend** so these endpoints are live before testing the app.

## 1. Configure

Edit [`src/config.ts`](src/config.ts) and set your deployed HTTPS URL:

```ts
export const API_BASE_URL = 'https://yourdomain.com';
```

> Must be **https** — Android blocks plain http by default.

## 2. Install dependencies

```bash
cd mobile
npm install
npx expo install --fix   # pins native module versions to the Expo SDK
```

## 3. Build the APK (Expo EAS — no Android Studio needed)

```bash
npm install -g eas-cli
eas login                       # create a free Expo account if needed
eas build:configure
eas build -p android --profile preview
```

EAS builds in the cloud and gives you a download link for the **APK**. Install
it on the employee's phone (allow "install from unknown sources").

> Prefer a local build? Run `npx expo prebuild` then build with Android Studio /
> Gradle. EAS is the simplest path.

## 4. On the phone

1. Open the app, log in with **Employee ID + PIN**.
2. Tap **Clock In** → grant location, and choose **"Allow all the time"**
   (this is what enables background tracking — "While using the app" is not
   enough).
3. A persistent "Attendance tracking active" notification appears. Location is
   now sent to the server every ~15 seconds while clocked in, **even with the
   screen off or the app in the background.**
4. Tap **Clock Out** to stop tracking.

Admins see the live path in the existing web Overview screen — unchanged.

## How background tracking works

- `expo-location` runs an Android **foreground service** (the persistent
  notification) that keeps delivering GPS fixes while backgrounded/screen-off.
- Each fix is POSTed to `/api/live-tracking/ping` (with a `/start` fallback if
  no session is open yet), authenticated with the stored bearer token and
  auto-refreshed on expiry.
- If the OS fully kills the app to save battery, Android relaunches the task for
  location events in most cases; aggressive battery optimizers (some Chinese
  OEMs) may need the app whitelisted in battery settings.

## Performance — avoiding lag / loading delays

The app is built to feel instant:

- **Hermes engine + New Architecture** are enabled (`newArchEnabled: true`) for
  fast JS startup and smooth UI.
- **Instant dashboard:** on open it paints immediately from a local cache of
  your last status (no network spinner), then refreshes silently in the
  background. Pull down to force a refresh.
- **Dark splash/background** (`#0f172a`) — no white flash on launch.
- **Background tracking runs off the UI thread** (a foreground service), so
  location updates never make the screen stutter.

> **Most important:** judge speed from the **release APK** (`eas build`), NOT
> from Expo Go or `expo start` (dev mode). Dev mode ships an unoptimized bundle
> with live-reload overhead and is many times slower — it is *not* how the
> installed app performs. The EAS APK is the real, fast app.

If you still see slowness on a specific device, it's almost always the network
round-trip to the API. Keep the backend close (same region) and on HTTPS/HTTP2.

## Push notifications (Firebase) — one-time setup

Without this, the app still shows every notification, but anything that comes
from the server (a permission approved or rejected, an automatic clock-out)
reaches a phone only when its owner opens the app. With it, the server pushes
those the moment they happen, app open or not. Reminders and away-from-site
warnings are made on the phone and do not depend on it.

The server sends straight to Firebase Cloud Messaging with the project's key —
no Expo account involved.

**Done already (2026-10-16):** Firebase project `attendance-27e7f`, Android app
`com.attendance.app`, and its `google-services.json` in `mobile/`, in
`mobile/android/app/` of the build folder, and named in `app.json`
(`googleServicesFile`). The Gradle files apply Firebase whenever that file is
present.

**On the server, once:**

1. Copy the service-account key (Firebase → *Project settings → Service
   accounts → Generate new private key*, a file like
   `attendance-27e7f-firebase-adminsdk-….json`) to the server, outside the app
   folder, readable only by the app's user:
   ```bash
   mkdir -p ~/secrets && chmod 700 ~/secrets
   # upload the file to ~/secrets/, then:
   chmod 600 ~/secrets/attendance-27e7f-firebase-adminsdk-*.json
   ```
   It is a secret: whoever holds it can send notifications as this app. Never
   commit it, never put it in the app.
2. Add to the server's `.env`:
   ```
   FIREBASE_SERVICE_ACCOUNT_FILE=/home/<user>/secrets/attendance-27e7f-firebase-adminsdk-….json
   ```
3. Check it: `node scripts/check-push.js` — signs in to Google with the key and
   has Firebase validate (not deliver) a test message.
4. Run `database/migrations/2026-10-16_push_tokens.sql` (check
   `check-status.sql` first, as always), restart the app, and build the phone
   app from the build folder.

To confirm: sign in on a phone with the new build, close the app, and approve a
permission for that employee on the web. The phone should show it within
seconds. If not, the server log says why (`[push] not delivered: …`).

## Notes / limits

- This is the **employee** app. Admin stays on the web.
- Mobile login is **PIN-only** (no passkey second factor) — intended for the
  field app. Rate limiting still applies.
- Tested flows: login, clock in/out, background tracking. Build on a real device
  or emulator and verify on your network; the API URL must be reachable from the
  phone.
