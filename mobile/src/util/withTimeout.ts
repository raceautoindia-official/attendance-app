/**
 * Give a promise a deadline.
 *
 * Every "the app is stuck loading" report this project has had traces back to
 * the same shape: an `await` on something the OS or the network was under no
 * obligation to ever answer. A GPS lock that never comes. A permission dialog
 * nobody taps. A socket that sends headers and then goes quiet. None of those
 * REJECT — they simply never settle, so the `finally` that would clear the
 * spinner never runs, and the button spins until the app is force-closed. The
 * employee gives up and goes home with the day still open.
 *
 * The rule this file exists to enforce: nothing the user is waiting on may be
 * awaited without a deadline. Losing the real answer after N seconds beats
 * losing the day.
 *
 * The underlying promise is NOT cancelled — most of these cannot be. It is
 * abandoned, and its late rejection swallowed, so it cannot resurface as an
 * unhandled rejection minutes later and be blamed on whatever the user is
 * doing by then.
 */
export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  promise.catch(() => {}); // see note above: it still settles, just later
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Like withTimeout, but a missed deadline is an ANSWER rather than a failure:
 * resolves to `fallback`. For the steps worth attempting and not worth
 * stopping for — cleanup, best-effort refreshes, anything whose failure the
 * user should not have to read about.
 */
export function withTimeoutOr<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return withTimeout(promise, ms, 'deadline passed').catch(() => fallback);
}
