# Moving to worklens.raceinnovations.in

Read the whole thing before starting. Two steps in here can lock people out —
one locks out the admins, the other strands the phones — and both are easy to
avoid if they are done in the right order.

## What actually breaks

**Passkeys are bound to the hostname.** A passkey is not a password that
travels with the account; it is a credential the browser stores against one
Relying Party ID, and `WEBAUTHN_RP_ID` is that ID. A credential created for
`attendance.raceinnovations.in` will not be offered on
`worklens.raceinnovations.in` — the browser will not even see it as a
candidate.

The login route makes it worse by accident:

```
hasPasskeys ? requiresWebAuthn : requiresPasskeySetup
```

It asks the DATABASE whether the employee has a passkey. After the move the
rows are still there, so the server insists on a passkey, while the browser
has none it is allowed to use for the new host. The result is "This device
doesn't have your passkey" for everybody, including super admins — and the
per-employee **Release / Reset access** button that fixes it is behind an
admin login nobody can reach.

So the passkey rows have to be cleared at the same time as the switch, not
after somebody discovers the problem.

**Check first — you may not need to.** If `WEBAUTHN_RP_ID` is already the
parent domain, credentials work on every subdomain and nothing breaks:

```bash
grep WEBAUTHN_RP_ID .env.local
```

| Value | What happens |
|---|---|
| `raceinnovations.in` | Passkeys keep working. Skip the reset below. |
| `attendance.raceinnovations.in` | Every passkey stops working. Do the reset. |

**The phones are the other one.** `API_BASE_URL` is compiled into the APK, so
a phone on an older build keeps asking for the old host forever. Keep the old
name alive until the fleet has updated. That costs nothing and is the only
thing standing between "not everyone has updated yet" and "not everyone can
clock in".

## Order of work

**1. DNS — add the new name, keep the old one**

At GoDaddy (`ns27`/`ns28.domaincontrol.com`), on `raceinnovations.in`:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `worklens` | `72.62.228.202` | 600 |

Leave the `attendance` record exactly as it is. Both names, one server.
Wait for it:

```bash
nslookup worklens.raceinnovations.in 8.8.8.8
```

**2. nginx — serve both names, one certificate covering both**

```nginx
server_name worklens.raceinnovations.in attendance.raceinnovations.in;
```

```bash
sudo certbot --nginx -d worklens.raceinnovations.in -d attendance.raceinnovations.in
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` before the reload, every time. A typo in a server block takes down
the site, not just the new name.

**3. Environment**

```
NEXT_PUBLIC_APP_URL=https://worklens.raceinnovations.in
WEBAUTHN_ORIGIN=https://worklens.raceinnovations.in
WEBAUTHN_RP_ID=raceinnovations.in
WEBAUTHN_RP_NAME=WorkLens
```

`WEBAUTHN_RP_ID` is set to the PARENT domain deliberately. Passkeys enrolled
from now on will work on any subdomain, so the next rename — or a staging
host — costs nobody their login.

**4. Clear the passkeys (only if the table said so in step 0)**

Do this in the same maintenance window as the switch.

```bash
node scripts/reset-passkeys.js --dry-run   # says who is affected, changes nothing
node scripts/reset-passkeys.js --confirm   # actually clears them
```

Everyone then signs in with their **employee ID and PIN** and is walked
straight into enrolling a new passkey. Nobody is stuck: that path exists
precisely because the person locked out is sometimes the administrator.

Tell people before you do it. "Your phone will ask you to set up your
fingerprint again on the new address" prevents most of the support calls.

**5. Deploy**

```bash
cd <app dir>
git pull && npm install && npm run build
pm2 restart all
```

**6. Check it, in this order**

```bash
curl -sI https://worklens.raceinnovations.in/login | head -1        # 200
curl -sI https://attendance.raceinnovations.in/login | head -1      # 200, still
```

Then sign in on the new address, and confirm the old one still answers — the
second one is what the un-updated phones are relying on.

**7. The APK**

The new build points at the new host. Distribute it, and give people time.

## Retiring the old name

Not on the day of the switch. Only once every phone reports in on a build
carrying the new address — check Live Tracking, or the audit log, for a device
that has not been seen since the cutover. Then remove the `attendance` record
and drop it from `server_name`.

Until then it is one DNS record and one word in an nginx config, which is a
very small price for nobody losing a day's attendance.
