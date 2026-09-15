function projector(corners) {
  const [p0, p1, p2, p3] = corners;
  const dx1 = p1[0] - p2[0],
    dx2 = p3[0] - p2[0],
    dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1],
    dy2 = p3[1] - p2[1],
    dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-8)
    throw new Error("performance invalid projected plane");
  const g = (dx3 * dy2 - dx2 * dy3) / den,
    h = (dx1 * dy3 - dx3 * dy1) / den;
  const ax = p1[0] - p0[0] + g * p1[0],
    bx = p3[0] - p0[0] + h * p3[0],
    ay = p1[1] - p0[1] + g * p1[1],
    by = p3[1] - p0[1] + h * p3[1];
  return (u, v) => {
    const divisor = g * u + h * v + 1;
    if (Math.abs(divisor) < 1e-8)
      throw new Error("performance projection crosses infinity");
    return [
      (ax * u + bx * v + p0[0]) / divisor,
      (ay * u + by * v + p0[1]) / divisor,
    ];
  };
}
export function projectPoint(corners, u, v) {
  return projector(corners)(u, v);
}

// One 8x12 projective mesh, evaluated in the shared core for both renderers.
export function projectionMesh(corners) {
  if (!corners) return null;
  const vertices = [],
    at = projector(corners);
  const emit = (u, v) => vertices.push([...at(u, v), u, v]);
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 8; x++) {
      const u = x / 8,
        v = y / 12,
        U = (x + 1) / 8,
        V = (y + 1) / 12;
      emit(u, v);
      emit(U, v);
      emit(U, V);
      emit(u, v);
      emit(U, V);
      emit(u, V);
    }
  return vertices;
}
