// Public privacy policy — required by Google Play (store listing + in-app
// link) for the Attendance mobile app, and good practice for the web app.
// Route: /privacy (publicly accessible, no auth).

export const metadata = {
  title: 'Privacy Policy — Attendance',
  description: 'Privacy policy for the Race Innovations Attendance application',
};

const UPDATED = '1 August 2026';

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 py-12 px-4">
      <div className="mx-auto max-w-3xl space-y-6 text-slate-700 dark:text-slate-300">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">Privacy Policy</h1>
        <p className="text-sm text-slate-500">Last updated: {UPDATED}</p>

        <p>
          This policy describes how the Attendance application (web and Android app) operated by{' '}
          <strong>Race Innovations</strong> (&quot;we&quot;, &quot;the company&quot;) collects and
          uses data. The app is an internal workforce tool used only by employees of the company.
        </p>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Data we collect</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <strong>Identity &amp; employment data</strong> — name, employee ID, email, phone,
              department, and role, entered by the company&apos;s administrators.
            </li>
            <li>
              <strong>Attendance data</strong> — clock-in and clock-out times, work dates, worked
              hours, and leave records.
            </li>
            <li>
              <strong>Precise location</strong> — collected when you clock in or out, and{' '}
              <strong>in the background only while you are clocked in</strong> (including when the
              app is closed), to verify work-site presence and work hours. Location collection
              stops automatically when you clock out, when your shift is closed, or when tracking
              is disabled by an administrator. A persistent notification is always visible while
              tracking is active. For staff with automatic attendance enabled, the app also
              monitors entry and exit of the assigned work-site boundary between the first
              clock-in and final clock-out of the day, solely to clock attendance out on leaving
              and back in on returning; only these entry/exit events are processed.
            </li>
            <li>
              <strong>Documents you or your employer upload</strong> — such as PAN card, Aadhaar
              card, bank details, and employment certificates, used for statutory HR and payroll
              purposes.
            </li>
            <li>
              <strong>Device permissions</strong> — notifications (shift reminders) and biometric
              unlock (processed entirely on your device; biometric data never leaves it).
            </li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">How data is used</h2>
          <p>
            Data is used solely for workforce management: recording attendance, verifying
            work-site presence, computing worked hours and leave balances, payroll-related record
            keeping, and security auditing. It is visible only to you and the company&apos;s
            authorised administrators and managers.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Sharing</h2>
          <p>
            We do <strong>not</strong> sell, rent, or share your personal data with third parties.
            Data stays on servers controlled by the company. It may be disclosed only where
            required by law.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Security</h2>
          <p>
            All data is transmitted over encrypted connections (HTTPS/TLS). Access requires
            authentication; sensitive credentials are stored hashed, and app sessions on your
            phone are protected by your device&apos;s biometric or PIN lock.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Retention &amp; your rights</h2>
          <p>
            Records are retained for the duration of your employment and as required by applicable
            labour and tax law. You may view your own attendance, details, and documents in the
            app at any time. To correct or request deletion of your data, or to withdraw location
            consent, contact your administrator or write to us at the address below; note that
            withdrawing location consent prevents attendance marking through the app.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Contact</h2>
          <p>
            Race Innovations — <a className="text-blue-600 dark:text-blue-400 underline" href="mailto:raceautoindia@gmail.com">raceautoindia@gmail.com</a>
          </p>
        </section>
      </div>
    </main>
  );
}
