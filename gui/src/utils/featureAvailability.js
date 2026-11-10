/**
 * Reading a backend readiness answer into the two flags a control needs.
 *
 * Speech and dictation both answer with the user's setting (`enabled`) and a
 * diagnostic (`problem`, empty when the feature can actually run). Those are
 * different questions and collapsing them into one boolean is what hid the
 * chat's microphone: ticking "offer a microphone button" while the model was
 * still missing produced `enabled: false`, so the button vanished and the
 * setting appeared to do nothing.
 *
 * - `offered` — the user asked for this control. It decides whether the
 *   control exists at all.
 * - `ready`   — it can run now. It decides whether the control is enabled.
 * - `problem` — why not, shown on the disabled control so a half-finished
 *   setup explains itself instead of being invisible.
 */

// What a surface assumes when the backend cannot be reached. Not the same
// condition as "misconfigured", but from a control's point of view equally
// unusable — and deliberately not `offered`, since a failed request is no
// evidence that the user asked for anything.
export const UNAVAILABLE = Object.freeze({ ready: false, offered: false, problem: '' });

export function availabilityFromSettings(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ...UNAVAILABLE };
  const problem = String(cfg.problem || '');
  return {
    ready: !problem,
    offered: Boolean(cfg.enabled),
    problem,
  };
}
