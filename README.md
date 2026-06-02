# Attendance Management Application

A production-ready attendance management system built with **Next.js 15**, **MySQL 8**, and **WebAuthn (Passkeys)** for secure, passwordless authentication.

---

## Table of Contents

1. [Features](#features)
2. [Tech Stack](#tech-stack)
3. [Local Development Setup](#local-development-setup)
4. [Environment Variables](#environment-variables)
5. [Database Setup](#database-setup)
6. [Deployment — Ubuntu VPS](#deployment--ubuntu-vps)
7. [Nginx Setup](#nginx-setup)
8. [PM2 Commands](#pm2-commands)
9. [Updating Production](#updating-production)
10. [Cron Job — Mark Absent](#cron-job--mark-absent)

---

## Features

- **Passkey / WebAuthn authentication** — no passwords stored, phishing-resistant
- **PIN + passkey two-factor flow** — PIN verifies identity, WebAuthn verifies device
- **Geofence-based clock-in/out** — GPS coordinates checked against work location radius
- **Shift management** — fixed, flexible, and rotating shift types
- **Leave & holiday management** — per-employee or company-wide
- **Admin dashboard** — live overview, attendance editing, employee CRUD
- **Report exports** — CSV and PDF with IST-formatted timestamps
- **Dark mode** — full dark/light theme support

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript 5 |
| UI | Tailwind CSS v4 + next-themes |
| Forms | React Hook Form + Zod v4 |
| Data fetching | TanStack Query v5 |
| Auth | jsonwebtoken v9 + bcryptjs |
| WebAuthn | @simplewebauthn/browser + server v13 |
| Database | MySQL 8 (mysql2/promise) |
| Email | Nodemailer v8 |
| PDF reports | jsPDF v4 + jspdf-autotable v5 |
| Process manager | PM2 |

---

## Local Development Setup

### Prerequisites

- Node.js 20+
- MySQL 8.0+
- npm 10+

### Steps

```bash
# 1. Clone the repository
git clone <repo-url>
cd attendance-app

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env.local
# Edit .env.local with your values (see Environment Variables section)

# 4. Set up the database
mysql -u root -p < database/schema.sql
mysql -u root -p attendance_db < database/seed.sql

# 5. Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Default seed credentials:**

| Employee ID | PIN    | Role        |
|-------------|--------|-------------|
| ADMIN001    | 000000 | super_admin |
| MGR001      | 111111 | manager     |
| EMP001      | 123456 | employee    |

> ⚠️ Change all PINs immediately in a real deployment.

---

## Environment Variables

Create a `.env.local` file in the project root. All variables marked **Required** must be set before the server will start.

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DB_HOST` | ✅ | MySQL host | `localhost` |
| `DB_PORT` | | MySQL port (default: 3306) | `3306` |
| `DB_USER` | ✅ | MySQL username | `attendance_user` |
| `DB_PASSWORD` | ✅ | MySQL password | `s3cr3tpassword` |
| `DB_NAME` | ✅ | MySQL database name | `attendance_db` |
| `JWT_ACCESS_SECRET` | ✅ | Secret for signing access tokens (≥32 chars) | `your-very-long-random-secret-here` |
| `JWT_REFRESH_SECRET` | ✅ | Secret for signing refresh tokens (≥32 chars) | `another-very-long-random-secret` |
| `JWT_ACCESS_EXPIRY` | | Access token TTL (default: `15m`) | `15m` |
| `JWT_REFRESH_EXPIRY` | | Refresh token TTL (default: `7d`) | `7d` |
| `WEBAUTHN_RP_ID` | ✅ | Relying party ID — your domain (no protocol, no path) | `yourdomain.com` |
| `WEBAUTHN_RP_NAME` | | Human-readable app name shown during passkey prompt | `Attendance App` |
| `WEBAUTHN_ORIGIN` | ✅ | Full origin URL | `https://yourdomain.com` |
| `APP_TIMEZONE` | | IANA timezone for IST display (default: `Asia/Kolkata`) | `Asia/Kolkata` |
| `NEXT_PUBLIC_APP_URL` | | Public URL — used for CORS headers | `https://yourdomain.com` |
| `LOGIN_MAX_ATTEMPTS` | | Max failed logins before lockout (default: `5`) | `5` |
| `LOGIN_LOCKOUT_MINUTES` | | Lockout duration in minutes (default: `15`) | `15` |
| `CRON_SECRET` | | Shared secret for the mark-absent cron endpoint | `long-random-string` |
| `SMTP_HOST` | | SMTP server for email alerts | `smtp.gmail.com` |
| `SMTP_PORT` | | SMTP port | `587` |
| `SMTP_USER` | | SMTP username / email | `alerts@yourdomain.com` |
| `SMTP_PASS` | | SMTP password / app-password | `smtp-app-password` |
| `ADMIN_EMAIL` | | Recipient for late/absent alerts | `admin@yourdomain.com` |

### Generating secrets

```bash
# Generate a secure random secret (Linux/macOS)
openssl rand -base64 48

# Or with Node.js
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

---

## Database Setup

### Create the database and user

```sql
CREATE DATABASE attendance_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'attendance_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON attendance_db.* TO 'attendance_user'@'localhost';
FLUSH PRIVILEGES;
```

### Run schema and seed

```bash
# Create all tables
mysql -u attendance_user -p attendance_db < database/schema.sql

# Insert default admin, manager, and sample employees
mysql -u attendance_user -p attendance_db < database/seed.sql
```

### Reset / re-seed

```bash
# Drop all tables and re-create (destructive!)
mysql -u attendance_user -p attendance_db -e "DROP DATABASE attendance_db; CREATE DATABASE attendance_db;"
mysql -u attendance_user -p attendance_db < database/schema.sql
mysql -u attendance_user -p attendance_db < database/seed.sql
```

---

## Deployment — Ubuntu VPS

Tested on Ubuntu 22.04 LTS.

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should be v20.x
```

### 2. Install MySQL 8

```bash
sudo apt-get install -y mysql-server
sudo mysql_secure_installation
```

Create the database and user as shown in [Database Setup](#database-setup).

### 3. Install PM2 globally

```bash
sudo npm install -g pm2
```

### 4. Clone and build the app

```bash
cd /var/www
git clone <repo-url> attendance-app
cd attendance-app

npm install --omit=dev

# Create production env file
cp .env.example .env.local
nano .env.local   # fill in all Required variables

# Build the Next.js app
npm run build
```

### 5. Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save          # persist across reboots
pm2 startup       # follow the printed command to enable on boot
```

### 6. Install and configure Nginx

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Copy the Nginx config
sudo cp nginx/attendance.conf /etc/nginx/sites-available/attendance
sudo ln -s /etc/nginx/sites-available/attendance /etc/nginx/sites-enabled/
sudo nginx -t

# Obtain TLS certificate
sudo certbot --nginx -d yourdomain.com

sudo systemctl reload nginx
```

---

## Nginx Setup

The Nginx configuration is in [`nginx/attendance.conf`](nginx/attendance.conf).

Key settings:
- HTTP → HTTPS redirect
- TLS 1.2/1.3 only, HSTS with preload
- Gzip for HTML, JSON, CSS, JS
- Security headers (X-Frame-Options, CSP, etc.)
- `client_max_body_size 5m`
- `proxy_read_timeout 60s`
- Long-cache headers for `/_next/static/` assets

After editing the config, always test before reloading:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## PM2 Commands

```bash
# View running processes
pm2 list

# View live logs
pm2 logs attendance

# View logs for last 200 lines
pm2 logs attendance --lines 200

# Monitor CPU/memory
pm2 monit

# Restart (zero-downtime in cluster mode)
pm2 reload attendance

# Hard restart (interrupts connections briefly)
pm2 restart attendance

# Stop the app
pm2 stop attendance

# Delete from PM2 process list
pm2 delete attendance

# Re-start after server reboot (if pm2 startup wasn't run)
pm2 resurrect
```

---

## Updating Production

```bash
# On the server:
cd /var/www/attendance-app

# 1. Pull latest changes
git pull origin main

# 2. Install any new dependencies
npm install --omit=dev

# 3. Build the app
npm run build

# 4. Reload PM2 with zero downtime (cluster mode handles traffic during reload)
pm2 reload attendance

# Verify everything started cleanly
pm2 logs attendance --lines 50
```

---

## Cron Job — Mark Absent

The `/api/cron/mark-absent` endpoint marks employees as absent if they:
- Have an active schedule on the current day
- Today is one of their working days
- Have no attendance or leave record for today

### Set up the cron job (server)

```bash
# Edit crontab
crontab -e

# Add this line — runs at 23:59 every day
59 23 * * * curl -s -X POST https://yourdomain.com/api/cron/mark-absent \
  -H "x-cron-secret: YOUR_CRON_SECRET" \
  >> /var/log/attendance-cron.log 2>&1
```

Replace `YOUR_CRON_SECRET` with the value of `CRON_SECRET` in your `.env.local`.

### Test manually

```bash
curl -X POST https://yourdomain.com/api/cron/mark-absent \
  -H "x-cron-secret: YOUR_CRON_SECRET"
```

Expected response:
```json
{
  "success": true,
  "message": "Marked 3 employee(s) as absent",
  "count": 3,
  "employees": ["Alice Smith", "Bob Jones", "Carol Lee"]
}
```

---

## Security Notes

- All access tokens are stored in **HttpOnly** cookies — not accessible to JavaScript
- Refresh tokens are stored as **SHA-256 hashes** — the raw token is never saved
- PIN hashes use **bcrypt with cost factor 12**
- WebAuthn credential public keys are stored as **base64url-encoded COSE keys**
- The in-memory rate limiter is **per-process** — use Redis for multi-instance deployments (see `lib/ratelimit.ts`)
- Run `npm audit` periodically and apply security patches
