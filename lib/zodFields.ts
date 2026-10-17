import { z } from 'zod';

/**
 * Field types for things the database hands out in a shape JSON does not have.
 *
 * THE BUG THIS EXISTS TO END
 * --------------------------
 * mysql2 returns `TINYINT(1)` as the NUMBER 1 or 0. Every flag in this schema
 * is a TINYINT(1) — `is_active`, `geofencing_enabled`, `is_observed`, and 28
 * others — so every GET hands clients a 1 where the TypeScript type says
 * `boolean`, and nothing anywhere notices.
 *
 * It is noticed the moment a client sends the value back. An edit form seeds
 * itself from the row it is editing and posts the row, so a perfectly ordinary
 * "change the address and save" arrives carrying `is_active: 1` and is refused
 * with:
 *
 *     is_active: Invalid input: expected boolean, received number
 *
 * Nothing is wrong with the request. The API is rejecting its own output.
 *
 * THE FIX IS ON BOTH SIDES, AND BOTH ARE NEEDED
 * ---------------------------------------------
 * Reads cast, so what goes out is honest — `Boolean(row.is_active)`, which
 * most of lib/ already did and `listCompanies` did not. And writes accept what
 * the app has ever handed out, which is what this is for. One side alone
 * leaves the trap set: the phone app also echoes values it was given, is
 * released separately, and cannot be fixed by deploying this.
 *
 * It is deliberately NOT `z.coerce.boolean()`. That one accepts anything and
 * calls it true — `"false"` becomes true, `"no"` becomes true, `{}` becomes
 * true. This accepts exactly what the database and JSON can mean by a flag and
 * refuses everything else, so a genuinely wrong value is still an error.
 */
export const zBool = z.union([
  z.boolean(),
  z.literal(0).transform(() => false),
  z.literal(1).transform(() => true),
]);

/**
 * A DECIMAL column comes back from mysql2 as a STRING, for the same reason:
 * a float cannot hold it exactly. Round-tripping one through a `z.number()`
 * fails the same way a flag does.
 */
export const zNum = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a number').transform(Number),
]);
