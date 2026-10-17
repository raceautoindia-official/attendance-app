# Google Play submission guide — Attendance app

Everything the app needed in code is done as of v1.4.24 (versionCode 31):
prominent-disclosure consent screen before any location access, privacy policy
at https://worklens.raceinnovations.in/privacy, private release signing,
cleartext HTTP disabled, target SDK 36 (Android 16 — meets the post-31-Aug-2026
requirement), and no unused sensitive permissions in the manifest (a stray
SYSTEM_ALERT_WINDOW was found and removed 2026-09-02; nothing in the app used
it, and it draws outsized review scrutiny for no reason). This file is the Play
Console side.

**Target for this app: public listing, single tenant.** Anyone can find and
install it from Play once it reaches Production — no closed-testing tester
list forever — but the app itself stays exactly as it is: one company's data,
accounts entirely provisioned by an admin, no public sign-up. That is a
deliberate choice, not a limitation to fix later: "public listing" and
"usable by other companies" are different asks, and only the first is in
scope here.

EAS project is now linked: `@trackie/attendance-mobile`
(https://expo.dev/accounts/trackie/projects/attendance-mobile). Signing still
runs off the LOCAL keystore below, not EAS-managed credentials — `eas build`
in non-interactive mode will try to generate a new one and must not be allowed
to; build locally with Gradle instead (section 6).

## 0. One-time critical backups

`android/keystore.properties` and `android/app/release.keystore` are gitignored
on purpose. **Copy both to at least two safe places** (password manager +
offline drive). Losing them means the sideloaded app can never be updated in
place again.

## 1. Developer account — PERSONAL now, ORGANIZATION later (decided 2026-09-02)

Two tracks, deliberately run in parallel. The reasoning matters, because the
obvious answer is the slower one:

**Organization accounts have no closed-testing requirement** — personal
accounts created after 13 Nov 2023 must run a closed test with 12+ testers for
14 consecutive days before production access; organization accounts publish
straight to production. So organization looks strictly better.

It is not, *from a standing start*. An organization account requires a D-U-N-S
number, and ours does not exist. The 2026-08-01 application (ref
`DR080120263052021450`) was **withheld the same day for missing documents** and
never processed — discovered 2026-09-02, after a month of assuming it was in a
queue. Resubmitting restarts a 30-BUSINESS-day clock, about six weeks. Against
that, the personal route's 14-day closed test is the faster road to a live
listing by roughly four weeks.

Apps can be transferred between developer accounts, so personal is not a dead
end. Hence both, at once:

### Track A — D-U-N-S resubmission (start immediately, ~6 weeks, background)

1. Email `serviceindia@dnb.com`, quoting `DR080120263052021450`, and ask
   **precisely which documents were missing.** Do not guess — a second
   withheld application costs another six weeks.
2. Gather: business **PAN**, **GST certificate**, **Certificate of
   Incorporation** (these three are the mandatory core), plus registered
   address proof, Aadhaar of directors/partners, business bank statement
   (3–6 months), MOA/AOA, and authorised signatory details.
3. Reinitiate at https://www.dnb.co.in/duns/get-a-duns with everything attached.

Only dnb.co.in issues D-U-N-S numbers in India, and they are **free**. Anyone
offering to obtain one faster for a fee is a scam — D&B say so themselves.

### Track B — Personal account (start immediately, live in ~2.5 weeks)

1. https://play.google.com/console → sign up → account type **Personal**.
2. $25 one-time (no renewal). Card only — Visa/Mastercard/Amex/Discover.
   **PayPal is not accepted.** Government ID needed; approval usually 1–3 days.
3. Collect **12+ Gmail addresses from employees** — this gates the closed test
   and is the one task with no technical shortcut. Start it today, not when
   the account is approved; it is the likeliest thing to slip.
4. Closed test must run **14 CONSECUTIVE days** with those testers opted in.
   The count restarts if it lapses, so do not add testers late.

### When the D-U-N-S arrives

Register the organization account and use Play Console's **app transfer** to
move `com.attendance.app` across. The listing then shows the company as
developer. Do this AFTER the app is live and stable — a transfer mid-review is
avoidable risk for no gain.

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
- **Privacy policy URL:** `https://worklens.raceinnovations.in/privacy`
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

- On the PERSONAL account (§1, Track B): Play Console → Testing →
  **Closed testing** → create a track, upload the .aab, add the 12+ employee
  tester emails, start rollout. After **14 consecutive days** with those
  testers opted in, apply for production access, then promote to Production.
- On an ORGANIZATION account, this step is just Production → Create new
  release; there is no closed-testing prerequisite. One round of closed or
  internal testing is still worth doing there anyway — a phone installing from
  Play is the first real proof Play App Signing re-signed the build correctly.
- Testers join via the opt-in link and install from Play. From then on,
  **updates are automatic** — the end of manual APK reinstalls.
- **Play App Signing — a real choice, not a formality.** Play re-signs what it
  delivers with an *app signing key*, while our keystore becomes the *upload
  key*. Which app signing key it uses decides whether ~16 phones need touching:

  - **Google-generated key** (Google's own recommendation): Google creates and
    holds it, so it cannot be lost. But Play-delivered installs are then signed
    DIFFERENTLY from our sideloaded APK, and Android refuses to install one
    over the other — every employee must **uninstall the sideloaded app once**
    before installing from Play. Logins are server-side, so nothing is lost but
    the icon for a minute.
  - **Upload our existing `release.keystore` as the app signing key**: Play
    then signs with the same key the sideloaded builds already carry, so phones
    **update in place from Play with no uninstall at all.** Offered during the
    first release ("use a key from a Java keystore").

  For a fleet already running the sideloaded build, the second is the kinder
  path — it spares one last manual round across every phone, which is the exact
  chore Play is being adopted to end. The first is safer long-term key custody.
  Whichever is chosen, back the keystore up first (§0) — with the second, that
  file remains load-bearing forever.

## 7. Each future release

1. Bump `versionCode` (+1) and `versionName` in **`android/app/build.gradle`**
   — this is the file that actually matters. `app.json`'s `version` field does
   NOT propagate here; this project's `android/` was prebuilt once and is now
   hand-maintained, not regenerated, so editing `app.json` alone silently does
   nothing to a real build. Bump both for consistency, but build.gradle is the
   one Play actually reads. (This bit a release on 2026-09-02: app.json said
   1.4.24 while build.gradle still said 1.4.23/30, and the APK was rebuilt
   with the SAME versionCode as what was already installed.)
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
