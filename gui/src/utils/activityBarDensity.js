// Density tiers for the left activity bar (`components/ActivityBar.jsx`).
//
// The bar is a fixed-height column between the top bar and the status bar, and
// its budget shrinks from two directions: a shorter window, and a larger
// interface scale (Settings > Interface Size), which multiplies every button.
// Once the buttons no longer fit, the bar used to clip them — the last icons
// (settings, hardware) were simply unreachable. Instead of clipping, the bar
// steps down through the tiers below and only scrolls once even the densest
// one overflows.
//
// These numbers are the single source of truth for the bar's spacing: the
// component writes the chosen tier into CSS custom properties and passes the
// icon sizes to lucide, so nothing here can drift away from `index.css`.

export const ACTIVITY_BAR_DENSITIES = [
  { name: 'comfortable', paddingY: 12, gap: 16, buttonPaddingY: 8, iconSize: 22, secondaryIconSize: 20 },
  { name: 'cozy', paddingY: 8, gap: 8, buttonPaddingY: 6, iconSize: 22, secondaryIconSize: 20 },
  { name: 'compact', paddingY: 6, gap: 4, buttonPaddingY: 4, iconSize: 20, secondaryIconSize: 18 },
  { name: 'dense', paddingY: 4, gap: 2, buttonPaddingY: 2, iconSize: 18, secondaryIconSize: 16 },
];

export const ACTIVITY_BAR_DEFAULT_DENSITY = ACTIVITY_BAR_DENSITIES[0];
export const ACTIVITY_BAR_MIN_DENSITY = ACTIVITY_BAR_DENSITIES[ACTIVITY_BAR_DENSITIES.length - 1];

// Look a tier up by name, falling back to the comfortable one so a stale or
// unknown name renders the bar at its normal size instead of blank.
export function getActivityBarDensity(name) {
  return ACTIVITY_BAR_DENSITIES.find(d => d.name === name) || ACTIVITY_BAR_DEFAULT_DENSITY;
}

// Height the bar's content needs at `density`. The top group is spaced by
// `gap`; the bottom group stays flush, as it renders today.
export function activityBarContentHeight(density, { top = 0, bottom = 0 } = {}) {
  const topButton = density.iconSize + 2 * density.buttonPaddingY;
  const bottomButton = density.secondaryIconSize + 2 * density.buttonPaddingY;
  return (
    2 * density.paddingY +
    top * topButton +
    Math.max(top - 1, 0) * density.gap +
    bottom * bottomButton
  );
}

// Densest tier is the floor: when even that overflows the caller lets the bar
// scroll rather than hiding whatever did not fit.
export function pickActivityBarDensity(availableHeight, counts) {
  if (!Number.isFinite(availableHeight) || availableHeight <= 0) return ACTIVITY_BAR_DEFAULT_DENSITY;
  for (const density of ACTIVITY_BAR_DENSITIES) {
    if (activityBarContentHeight(density, counts) <= availableHeight) return density;
  }
  return ACTIVITY_BAR_MIN_DENSITY;
}
