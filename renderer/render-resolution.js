/** Bound fragment work without changing CSS layout, camera framing or input coordinates. */
export function renderResolution(cssWidth, cssHeight, dpr = 1, maxPixels = Infinity) {
  const width = Math.max(1, Math.floor(Number(cssWidth) || 1));
  const height = Math.max(1, Math.floor(Number(cssHeight) || 1));
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const cap = Number.isFinite(maxPixels) && maxPixels >= 1 ? maxPixels : Infinity;
  const scale = Math.min(ratio, Math.sqrt(cap / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
