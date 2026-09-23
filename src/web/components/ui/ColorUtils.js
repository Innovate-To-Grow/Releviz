// Availability heatmap palette, derived from Bootstrap's subtle border tones so
// the grid matches the rest of the theme. Values must stay in sync with the
// `--rv-avail-*` custom properties in app/globals.css.
//
// In-person: red → yellow → green
export const color0 = "#f1aeb5"; // busy (danger)
export const color1 = "#ffe69c"; // partial (warning)
export const color2 = "#a3cfbb"; // free (success)

// Virtual: red → purple → blue
export const virtualColor0 = "#f1aeb5"; // busy (danger)
export const virtualColor1 = "#c5b3e6"; // partial (purple)
export const virtualColor2 = "#9ec5fe"; // free (primary)

function lerpRGB(a, b, amount) {
  const ar = parseInt(a.substring(1, 3), 16);
  const ag = parseInt(a.substring(3, 5), 16);
  const ab = parseInt(a.substring(5, 7), 16);
  const br = parseInt(b.substring(1, 3), 16);
  const bg = parseInt(b.substring(3, 5), 16);
  const bb = parseInt(b.substring(5, 7), 16);
  const rr = Math.floor(ar * (1 - amount) + br * amount);
  const rg = Math.floor(ag * (1 - amount) + bg * amount);
  const rb = Math.floor(ab * (1 - amount) + bb * amount);
  return `rgb(${rr}, ${rg}, ${rb})`;
}

export function lerpColor(amount) {
  if (amount < 0.5) {
    return lerpRGB(color0, color1, amount * 2);
  } else {
    return lerpRGB(color1, color2, (amount - 0.5) * 2);
  }
}

export function lerpVirtualColor(amount) {
  if (amount < 0.5) {
    return lerpRGB(virtualColor0, virtualColor1, amount * 2);
  }
  return lerpRGB(virtualColor1, virtualColor2, (amount - 0.5) * 2);
}
