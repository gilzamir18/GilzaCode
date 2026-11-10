// Accessibility interface scale.
//
// The whole app is rendered inside a CSS `zoom` driven by this factor (see
// `.vscode-app` in index.css), so raising it enlarges text, icons, padding and
// click targets together rather than only the text. That keeps the interface in
// proportion at every step, and it is the only approach that also reaches the
// many components which size themselves with literal pixel values in inline
// styles.
//
// The factor — not a preset name — is what gets persisted, so the ladder below
// can change without migrating saved settings and so a value picked with the
// fine-tuning control is representable in the same field. Bounds are mirrored
// in gilzabots/ui_settings.py, which clamps again on the way in and out.

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_STEP = 0.05;
// Keyboard zoom moves in coarser jumps than the fine-tuning control, so a
// press produces a visible change rather than a barely perceptible one.
export const UI_SCALE_KEY_STEP = 0.1;
export const UI_SCALE_DEFAULT = 1.0;

// Named steps, in the spirit of the size ladders OS accessibility panels offer.
// "Medium" is 1.0 so nothing changes for existing users until they opt in, and
// the ladder stops at 1.4 because beyond that a 1080p screen no longer has room
// for the four-column layout; the fine-tuning control still reaches UI_SCALE_MAX
// for those who need it.
export const UI_SCALE_PRESETS = [
  { id: 'small', scale: 0.9 },
  { id: 'medium', scale: 1.0 },
  { id: 'large', scale: 1.2 },
  { id: 'extraLarge', scale: 1.4 },
];

/**
 * Coerce an arbitrary value into a usable scale factor. Anything non-numeric
 * falls back to the default, so a corrupted stored setting cannot leave the
 * interface unreadable.
 */
export const clampUiScale = (value) => {
  // Number(null) and Number('') are 0, which would clamp to the minimum and
  // shrink the interface on a missing setting. Both mean "unset" here, and the
  // backend's clamp_ui_scale() maps them to the default too.
  if (value === null || value === undefined || value === '') return UI_SCALE_DEFAULT;
  const scale = Number(value);
  if (!Number.isFinite(scale)) return UI_SCALE_DEFAULT;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, scale));
};

/** Round to the fine-tuning step. The multiplication reintroduces float drift
 *  (24 * 0.05 is 1.2000000000000002), so the result is trimmed to the two
 *  decimals a 0.05 step can actually produce. */
export const roundUiScale = (value) =>
  Number((Math.round(clampUiScale(value) / UI_SCALE_STEP) * UI_SCALE_STEP).toFixed(2));

/** The preset a factor corresponds to, or null when it sits between steps. */
export const presetForScale = (scale) =>
  UI_SCALE_PRESETS.find((p) => Math.abs(p.scale - scale) < UI_SCALE_STEP / 2) || null;

/**
 * The scale currently applied to the interface, read from the document element
 * so there is a single source of truth (App.jsx is its only writer).
 */
export const readUiScale = () => {
  if (typeof document === 'undefined') return UI_SCALE_DEFAULT;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale');
  const scale = Number.parseFloat(raw);
  return Number.isFinite(scale) && scale > 0 ? scale : UI_SCALE_DEFAULT;
};

// ── Crossing the zoom boundary ────────────────────────────────────────────
// The app renders inside a CSS `zoom`, which multiplies every CSS length in the
// subtree before it reaches the screen. DOM geometry does not go through that
// multiplication: MouseEvent.clientX/clientY, getBoundingClientRect() and
// window.innerWidth/innerHeight are all reported in real viewport pixels. So a
// pointer position written straight into `left`/`top` lands scale-times too far
// from the origin — which is why a context menu opened at the top of the tree
// used to appear near the bottom of the window at 140%.
//
// Convert whenever a measured or pointer coordinate becomes a CSS length inside
// the app, and *only* then: hit-testing a pointer against a getBoundingClientRect
// compares two viewport values and must be left alone.

/** A viewport distance (event or rect pixels) as a CSS length inside the app. */
export const viewportPxToApp = (px, scale = readUiScale()) => px / scale;

/** A viewport point (typically event.clientX/clientY) as app CSS coordinates. */
export const viewportPointToApp = (clientX, clientY, scale = readUiScale()) => ({
  x: clientX / scale,
  y: clientY / scale,
});
