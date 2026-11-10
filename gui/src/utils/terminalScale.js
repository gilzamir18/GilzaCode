/**
 * xterm measures cells in its own CSS coordinate space. The terminal viewport
 * cancels the app-level CSS zoom so mouse offsets and cells use the same unit;
 * multiplying the configured font size preserves the size seen on screen.
 */
export const terminalRenderFontSize = (fontSize, uiScale = 1) => {
  const scale = Number(uiScale);
  return Number(fontSize) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
};
