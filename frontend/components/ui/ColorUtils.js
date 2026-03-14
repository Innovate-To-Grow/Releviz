// Material 3 tone colors for availability gradient
export const color0 = "#ffb4ab"; // busy (red)
export const color1 = "#ffdea3"; // partial (yellow)
export const color2 = "#82d3a2"; // free (green)

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
