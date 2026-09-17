// Spherical Lambert conformal conic (tangent/secant) used by DMI HARMONIE grids.
// Shared between server (Node) and browser.
export function makeLcc({ latin1, latin2 = latin1, lov, radius = 6371229 }) {
  const d2r = Math.PI / 180;
  const p1 = latin1 * d2r, p2 = latin2 * d2r;
  const n = Math.abs(p1 - p2) < 1e-10 ? Math.sin(p1)
    : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
  const F = Math.cos(p1) * Math.pow(Math.tan(Math.PI / 4 + p1 / 2), n) / n;
  const lam0 = ((lov + 540) % 360 - 180) * d2r;
  return {
    n,
    forward(lon, lat) {
      const rho = radius * F / Math.pow(Math.tan(Math.PI / 4 + lat * d2r / 2), n);
      let dl = lon * d2r - lam0;
      if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI;
      const th = n * dl;
      return [rho * Math.sin(th), -rho * Math.cos(th)];
    },
    inverse(x, y) {
      const rho = Math.sign(n) * Math.hypot(x, y);
      const th = Math.atan2(x, -y);
      const lat = 2 * Math.atan(Math.pow(radius * F / rho, 1 / n)) - Math.PI / 2;
      return [(th / n + lam0) / d2r, lat / d2r];
    },
    // Angle (radians) to rotate grid-relative wind to earth-relative.
    rotation(lon) {
      let dl = lon * d2r - lam0;
      if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI;
      return n * dl;
    },
  };
}
