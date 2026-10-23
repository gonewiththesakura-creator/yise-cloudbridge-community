import { clampInt, nowIso, text } from './validation.mjs';
import { errorJson } from './http.mjs';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export function versionParts(value) {
  const normalized = text(value, 32);
  if (!VERSION_PATTERN.test(normalized)) return null;
  return normalized.split('.').map(Number);
}

export function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function updatePolicyDefaults(options) {
  return {
    enabled: Boolean(options.clientUpdateVersion && options.clientUpdateUrl && options.clientUpdateSha256),
    platform: 'windows-x64',
    latestVersion: options.clientUpdateVersion,
    minimumVersion: options.clientMinimumVersion || options.clientUpdateVersion,
    downloadUrl: options.clientUpdateUrl,
    sha256: options.clientUpdateSha256,
    fileSize: options.clientUpdateFileSize,
    releaseNotes: options.clientUpdateReleaseNotes,
    publishedAt: options.clientUpdatePublishedAt || null,
  };
}

export function readUpdatePolicy(db, options) {
  const fallback = updatePolicyDefaults(options);
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'client-update:windows-x64'").get();
  if (!row) return fallback;
  try { return { ...fallback, ...JSON.parse(row.value) }; }
  catch { return fallback; }
}

export function validateUpdatePolicy(body, existing) {
  const enabled = body.enabled === undefined ? Boolean(existing.enabled) : body.enabled === true;
  const latestVersion = text(body.latestVersion, 32, existing.latestVersion);
  const minimumVersion = text(body.minimumVersion, 32, existing.minimumVersion || latestVersion);
  const downloadUrl = text(body.downloadUrl, 500, existing.downloadUrl);
  const sha256Value = text(body.sha256, 64, existing.sha256).toLowerCase();
  const fileSize = clampInt(body.fileSize, 1, 1024 * 1024 * 1024, existing.fileSize || 1);
  const releaseNotes = text(body.releaseNotes, 2_000, existing.releaseNotes);
  if (!versionParts(latestVersion) || !versionParts(minimumVersion)) {
    throw Object.assign(new Error('版本号必须使用 x.y.z 格式'), { status: 400 });
  }
  if (compareVersions(minimumVersion, latestVersion) > 0) {
    throw Object.assign(new Error('最低版本不能高于最新版本'), { status: 400 });
  }
  let parsedUrl;
  try { parsedUrl = new URL(downloadUrl); } catch { parsedUrl = null; }
  if (!parsedUrl || parsedUrl.protocol !== 'https:') {
    throw Object.assign(new Error('下载地址必须是 HTTPS 地址'), { status: 400 });
  }
  if (!SHA256_PATTERN.test(sha256Value)) {
    throw Object.assign(new Error('SHA-256 必须是 64 位十六进制值'), { status: 400 });
  }
  return {
    enabled,
    platform: 'windows-x64',
    latestVersion,
    minimumVersion,
    downloadUrl,
    sha256: sha256Value,
    fileSize,
    releaseNotes,
    publishedAt: nowIso(),
  };
}

export function requireSupportedClient(db, options, body, res) {
  const clientVersion = text(body.clientVersion, 32);
  if (!clientVersion) return true; // Transitional support for 2.2.x clients without an updater.
  const policy = readUpdatePolicy(db, options);
  const comparison = compareVersions(clientVersion, policy.minimumVersion);
  if (policy.enabled && (comparison === null || comparison < 0)) {
    errorJson(res, 426, `客户端版本过低，请更新到 ${policy.latestVersion}`);
    return false;
  }
  return true;
}

