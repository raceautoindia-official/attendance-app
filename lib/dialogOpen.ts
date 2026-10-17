'use client';

/**
 * Whether a drawer or a modal is currently open, readable from anywhere.
 *
 * WHY ANYTHING NEEDS TO KNOW
 * --------------------------
 * The setup guide dims the page and cuts a hole over the control it is
 * pointing at. Drawers and modals sit at `z-50`; the guide's dim is above
 * them, which is correct while it is pointing at a button on the page and
 * exactly wrong the moment that button opens a form: the form would appear
 * behind the dim, with the guide's card floating over the fields somebody is
 * trying to fill in.
 *
 * Raising the drawer above the guide instead would be worse - the dim would
 * then cover the page while the form sat on top of it, and the hole would be
 * pointing at a button nobody can see.
 *
 * So the guide steps aside: while a dialog is open it renders nothing but its
 * own button, and comes back when the dialog closes - by which time the step
 * it was on has usually ticked itself off, because the form was saved.
 *
 * A COUNT, NOT A FLAG
 * -------------------
 * A drawer can open a modal (confirming something from inside a form), and a
 * flag would be cleared by the inner one closing while the outer is still
 * there. The count is held in the module and mirrored onto `document.body` as
 * a data attribute, which is also what makes it observable.
 */

let depth = 0;
const listeners = new Set<() => void>();

function publish() {
  if (typeof document === 'undefined') return;
  if (depth > 0) document.body.dataset.dialog = 'open';
  else delete document.body.dataset.dialog;
  for (const l of listeners) l();
}

/** Call when a dialog opens; call the returned function when it closes. */
export function markDialogOpen(): () => void {
  depth += 1;
  publish();
  let released = false;
  return () => {
    // Guarded: React may run a cleanup twice in development's strict mode, and
    // a double decrement would say "no dialog" while one is still open.
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    publish();
  };
}

export function dialogIsOpen(): boolean {
  return depth > 0;
}

/** For useSyncExternalStore. */
export function subscribeDialog(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}
