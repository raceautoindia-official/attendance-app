// The end-of-day settling sweep, observed rather than performed.
//
// What matters to the clock-in test is whether the sweep was CALLED and for
// whom — its own behaviour is covered by the tests that exercise it directly.
const db = require('./clockindb');

let calls = null;
let settles = true;

function setSettles(v) { settles = v; }
function calledWith() { return calls; }
function reset() { calls = null; settles = true; }

async function closeOpenSessions(opts = {}) {
  calls = { employeeId: opts.employeeId ?? null, includeToday: !!opts.includeToday };
  if (!settles) return 0;   // the row is still open afterwards
  db.setOpenSession(null);  // settled: the guard finds nothing on the re-check
  return 1;
}

module.exports = { closeOpenSessions, setSettles, calledWith, reset };
