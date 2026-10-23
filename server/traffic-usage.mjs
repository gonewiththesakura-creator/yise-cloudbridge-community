function safeBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function hourBucket(value = new Date()) {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function deltaFromTotal(current, previous) {
  return current >= previous ? current - previous : current;
}

export function recordTrafficTotals(db, memberId, uploadTotalBytes, downloadTotalBytes, recordedAt = new Date()) {
  const upload = safeBytes(uploadTotalBytes);
  const download = safeBytes(downloadTotalBytes);
  const total = upload + download;
  const bucket = hourBucket(recordedAt);
  const previous = db.prepare(`
    SELECT upload_total_bytes, download_total_bytes
    FROM traffic_samples WHERE member_id = ?
    ORDER BY bucket_start DESC LIMIT 1
  `).get(memberId);
  const uploadDelta = previous ? deltaFromTotal(upload, previous.upload_total_bytes) : 0;
  const downloadDelta = previous ? deltaFromTotal(download, previous.download_total_bytes) : 0;
  db.prepare(`
    INSERT INTO traffic_samples(
      member_id, bucket_start, traffic_total_bytes, upload_total_bytes, download_total_bytes,
      traffic_delta_bytes, upload_delta_bytes, download_delta_bytes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(member_id, bucket_start) DO UPDATE SET
      traffic_total_bytes = excluded.traffic_total_bytes,
      upload_total_bytes = excluded.upload_total_bytes,
      download_total_bytes = excluded.download_total_bytes,
      traffic_delta_bytes = traffic_samples.traffic_delta_bytes + excluded.traffic_delta_bytes,
      upload_delta_bytes = traffic_samples.upload_delta_bytes + excluded.upload_delta_bytes,
      download_delta_bytes = traffic_samples.download_delta_bytes + excluded.download_delta_bytes,
      updated_at = excluded.updated_at
  `).run(memberId, bucket, total, upload, download, uploadDelta + downloadDelta,
    uploadDelta, downloadDelta, new Date(recordedAt).toISOString());
}

export function recordTrafficDelta(db, memberId, trafficDeltaBytes, recordedAt = new Date()) {
  const delta = safeBytes(trafficDeltaBytes);
  if (!delta) return;
  const bucket = hourBucket(recordedAt);
  const member = db.prepare('SELECT traffic_used_bytes FROM members WHERE id = ?').get(memberId);
  if (!member) return;
  db.prepare(`
    INSERT INTO traffic_samples(
      member_id, bucket_start, traffic_total_bytes, upload_total_bytes, download_total_bytes,
      traffic_delta_bytes, upload_delta_bytes, download_delta_bytes, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?)
    ON CONFLICT(member_id, bucket_start) DO UPDATE SET
      traffic_total_bytes = excluded.traffic_total_bytes,
      download_total_bytes = excluded.download_total_bytes,
      traffic_delta_bytes = traffic_samples.traffic_delta_bytes + excluded.traffic_delta_bytes,
      download_delta_bytes = traffic_samples.download_delta_bytes + excluded.download_delta_bytes,
      updated_at = excluded.updated_at
  `).run(memberId, bucket, member.traffic_used_bytes, member.traffic_used_bytes,
    delta, delta, new Date(recordedAt).toISOString());
}

const RANGE_CONFIG = {
  '24h': { count: 24, unit: 'hour' },
  '7d': { count: 7, unit: 'day' },
  '30d': { count: 30, unit: 'day' },
};

function startOf(date, unit) {
  const value = new Date(date);
  if (unit === 'day') value.setUTCHours(0, 0, 0, 0);
  else value.setUTCMinutes(0, 0, 0);
  return value;
}

function addUnit(date, unit, amount) {
  const value = new Date(date);
  if (unit === 'day') value.setUTCDate(value.getUTCDate() + amount);
  else value.setUTCHours(value.getUTCHours() + amount);
  return value;
}

export function trafficSeries(db, range = '24h', memberId = null, now = new Date()) {
  const normalizedRange = RANGE_CONFIG[range] ? range : '24h';
  const config = RANGE_CONFIG[normalizedRange];
  const end = startOf(now, config.unit);
  const start = addUnit(end, config.unit, -(config.count - 1));
  const rows = db.prepare(`
    SELECT bucket_start, upload_delta_bytes, download_delta_bytes, traffic_delta_bytes, updated_at
    FROM traffic_samples WHERE bucket_start >= ? AND bucket_start <= ?
      ${memberId === null ? '' : 'AND member_id = ?'} ORDER BY bucket_start
  `).all(start.toISOString(), new Date(now).toISOString(), ...(memberId === null ? [] : [memberId]));
  const grouped = new Map();
  for (const row of rows) {
    const key = startOf(row.bucket_start, config.unit).toISOString();
    const current = grouped.get(key) || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, observed: true };
    current.uploadBytes += row.upload_delta_bytes;
    current.downloadBytes += row.download_delta_bytes;
    current.totalBytes += row.traffic_delta_bytes;
    grouped.set(key, current);
  }
  const points = [];
  for (let index = 0; index < config.count; index += 1) {
    const at = addUnit(start, config.unit, index).toISOString();
    points.push({ at, ...(grouped.get(at) || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, observed: false }) });
  }
  const totals = points.reduce((sum, point) => ({
    uploadBytes: sum.uploadBytes + point.uploadBytes,
    downloadBytes: sum.downloadBytes + point.downloadBytes,
    totalBytes: sum.totalBytes + point.totalBytes,
  }), { uploadBytes: 0, downloadBytes: 0, totalBytes: 0 });
  return {
    range: normalizedRange, unit: config.unit, memberId, points, totals,
    observedBuckets: grouped.size,
    lastSampleAt: rows.reduce((last, row) => !last || row.updated_at > last ? row.updated_at : last, null),
  };
}
