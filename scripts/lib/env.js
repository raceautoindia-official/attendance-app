/**
 * Load the app's environment for a standalone script.
 *
 * Every script under scripts/ used to carry its own copy of this loop, and each
 * copy read `.env.local` and nothing else. That is wrong on any deployment that
 * keeps its config in `.env` — which is what the production server does: there
 * is no `.env.local` in /home/deploy/attendance-app at all. The scripts did not
 * complain, they just started with no DB_HOST and no credentials and failed at
 * whatever they touched first, which reads as "the database is unreachable"
 * rather than "nobody loaded the config".
 *
 * Both files are read, in the same precedence Next.js itself uses so a script
 * sees what the running app sees:
 *
 *   process.env            (already set — a real env var always wins)
 *   .env.local             (developer overrides, gitignored)
 *   .env                   (committed/deployed defaults)
 *
 * Precedence is implemented by never overwriting a key that is already set, and
 * by reading the files in the order above. `.env.production` is deliberately
 * NOT read: Next.js only loads it when NODE_ENV=production, and a cron script
 * inherits no NODE_ENV, so honouring it here would give scripts a different
 * view of the config than the server has.
 *
 * Returns the list of files actually read, so a script can say where its
 * settings came from — worth printing, because "which env file" has already
 * cost one debugging session.
 */

const fs = require('fs');
const path = require('path');

const ENV_FILES = ['.env.local', '.env'];

/**
 * @param {string} root  App root (the parent of scripts/).
 * @returns {string[]}   Basenames of the files that existed and were read.
 */
function loadEnv(root) {
  const loaded = [];

  for (const name of ENV_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // A file that exists but cannot be read is worth saying out loud: it is
      // usually root-owned config the deploy user cannot see, and the symptom
      // otherwise looks identical to the file being absent.
      console.error(`[env] cannot read ${name}: ${err.message}`);
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      // Tolerate `export FOO=bar`, which people add when they have been
      // sourcing the file in a shell.
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;

      const key = m[1];
      // First file to define a key wins, and anything already in the real
      // environment beats both.
      if (process.env[key] !== undefined) continue;

      let value = m[2].trim();
      // Strip one matching pair of surrounding quotes, and only a matching
      // pair — a password that legitimately ends in a quote must survive.
      if (value.length >= 2 &&
          ((value[0] === '"' && value.endsWith('"')) ||
           (value[0] === "'" && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }

    loaded.push(name);
  }

  return loaded;
}

module.exports = { loadEnv, ENV_FILES };
