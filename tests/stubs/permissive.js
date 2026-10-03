// The gates the clock-in route passes through before it reaches the duplicate
// check: the phone is the registered one, the coordinates are believable, the
// mail goes nowhere. Each has its own tests; here they must simply say yes, so
// that what a clock-in test observes is the duplicate guard alone.

async function checkDevice() { return { ok: true }; }
async function assessLocation() { return { ok: true }; }
async function sendOutOfFenceClockInAlert() { return true; }

module.exports = { checkDevice, assessLocation, sendOutOfFenceClockInAlert };
