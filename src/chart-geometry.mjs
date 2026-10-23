// Horizontal Bézier tangents keep each segment inside its measured endpoints.
// Missing samples start a new segment instead of inventing zero traffic.
export function smoothSegments(points, key, width, height, maximum) {
  const segments = [];
  let segment = null;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point.observed) { segment = null; continue; }
    const x = points.length === 1 ? width / 2 : index / (points.length - 1) * width;
    const y = height - Math.max(0, point[key]) / maximum * height;
    if (!segment) {
      segment = { path: `M ${x} ${y}`, firstX: x, lastX: x, lastY: y };
      segments.push(segment);
    } else {
      const middle = (segment.lastX + x) / 2;
      segment.path += ` C ${middle} ${segment.lastY}, ${middle} ${y}, ${x} ${y}`;
      segment.lastX = x;
      segment.lastY = y;
    }
  }
  return segments;
}
