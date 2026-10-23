import assert from 'node:assert/strict';
import test from 'node:test';
import { smoothSegments } from '../src/chart-geometry.mjs';

test('smooth traffic charts leave missing samples disconnected and never overshoot measured values', () => {
  const points = [
    { observed: true, uploadBytes: 0 },
    { observed: true, uploadBytes: 100 },
    { observed: false, uploadBytes: 0 },
    { observed: true, uploadBytes: 25 },
    { observed: true, uploadBytes: 0 },
  ];
  const segments = smoothSegments(points, 'uploadBytes', 400, 100, 100);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].firstX, 0);
  assert.equal(segments[0].lastX, 100);
  assert.equal(segments[1].firstX, 300);
  assert.equal(segments[1].lastX, 400);
  for (const segment of segments) {
    const coordinates = segment.path.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const ys = coordinates.filter((_, index) => index % 2 === 1);
    assert.ok(ys.every((value) => value >= 0 && value <= 100));
    assert.match(segment.path, / C /);
  }
  assert.deepEqual(smoothSegments([{ observed: false }], 'uploadBytes', 400, 100, 100), []);
});
