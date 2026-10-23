import { resolve } from 'node:path';
import { passwordPolicyError } from './security.mjs';

function integer(value, name, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function boolean(value, name, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function paired(values, names) {
  if (values.some(Boolean) && !values.every(Boolean)) {
    throw new Error(`${names.join(', ')} must be configured together`);
  }
}

// Pure, injectable environment boundary. No env reads remain in request handlers.
// Call createFriendLinkApp(overrides, {}) for a fully isolated local/test instance.
export function loadAppConfig(overrides = {}, environment = process.env) {
  const pick = (key, name, fallback = '') => overrides[key] ?? environment[name] ?? fallback;
  const number = (key, name, fallback, min, max) => integer(pick(key, name), name, fallback, min, max);
  const flag = (key, name) => boolean(pick(key, name), name);
  const dataDir = resolve(pick('dataDir', 'DATA_DIR', './data') || './data');
  const options = {
    host: pick('host', 'HOST', '127.0.0.1') || '127.0.0.1',
    port: number('port', 'PORT', 8787, 1, 65535),
    dataDir,
    dbPath: overrides.dbPath || resolve(dataDir, 'friendlink.db'),
    distDir: resolve(pick('distDir', 'DIST_DIR', './dist') || './dist'),
    productName: pick('productName', 'PRODUCT_NAME', '壹色云桥') || '壹色云桥',
    sessionDays: number('sessionDays', 'SESSION_DAYS', 7, 1, 90),
    cookieSecure: flag('cookieSecure', 'COOKIE_SECURE'),
    setupToken: pick('setupToken', 'SETUP_TOKEN'),
    encryptionKey: pick('encryptionKey', 'CREDENTIAL_ENCRYPTION_KEY'),
    proxyAdapterToken: pick('proxyAdapterToken', 'PROXY_ADAPTER_TOKEN'),
    trustProxy: flag('trustProxy', 'TRUST_PROXY'),
    credentialHours: number('credentialHours', 'CREDENTIAL_HOURS', 24, 2, 168),
    proxyHost: pick('proxyHost', 'PROXY_HOST', '127.0.0.1') || '127.0.0.1',
    proxyPort: number('proxyPort', 'PROXY_PORT', 443, 1, 65535),
    proxyServerName: pick('proxyServerName', 'PROXY_SERVER_NAME', 'localhost') || 'localhost',
    dataPlaneHost: pick('dataPlaneHost', 'DATA_PLANE_HOST', '127.0.0.1') || '127.0.0.1',
    dataPlanePort: number('dataPlanePort', 'DATA_PLANE_PORT', 443, 1, 65535),
    dataPlaneInternalHost: pick('dataPlaneInternalHost', 'DATA_PLANE_INTERNAL_HOST', '127.0.0.1') || '127.0.0.1',
    dataPlaneInternalPort: number('dataPlaneInternalPort', 'DATA_PLANE_INTERNAL_PORT', 2443, 1, 65535),
    tuicEnabled: flag('tuicEnabled', 'TUIC_ENABLED'),
    tuicPort: number('tuicPort', 'TUIC_PORT', 443, 1, 65535),
    tuicCongestionControl: pick('tuicCongestionControl', 'TUIC_CONGESTION_CONTROL', 'bbr') || 'bbr',
    clientUpdateVersion: pick('clientUpdateVersion', 'CLIENT_UPDATE_VERSION'),
    clientMinimumVersion: pick('clientMinimumVersion', 'CLIENT_MINIMUM_VERSION'),
    clientUpdateUrl: pick('clientUpdateUrl', 'CLIENT_UPDATE_URL'),
    clientUpdateSha256: pick('clientUpdateSha256', 'CLIENT_UPDATE_SHA256'),
    clientUpdateFileSize: number('clientUpdateFileSize', 'CLIENT_UPDATE_FILE_SIZE', 1, 1, 1024 ** 3),
    clientUpdateReleaseNotes: pick('clientUpdateReleaseNotes', 'CLIENT_UPDATE_RELEASE_NOTES'),
    clientUpdatePublishedAt: pick('clientUpdatePublishedAt', 'CLIENT_UPDATE_PUBLISHED_AT'),
    initialAdminUsername: String(pick('initialAdminUsername', 'INITIAL_ADMIN_USERNAME', 'admin')).trim().slice(0, 40),
    initialAdminPassword: pick('initialAdminPassword', 'INITIAL_ADMIN_PASSWORD'),
    disableWorker: boolean(overrides.disableWorker, 'disableWorker'),
    disableDataPlane: boolean(overrides.disableDataPlane, 'disableDataPlane'),
  };
  if (options.encryptionKey) {
    const key = String(options.encryptionKey);
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== key.replace(/=+$/, '')) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as Base64');
    }
  }
  if (options.initialAdminPassword) {
    const error = passwordPolicyError(options.initialAdminPassword);
    if (error) throw new Error(`INITIAL_ADMIN_PASSWORD：${error}`);
    if (options.initialAdminUsername.length < 3) throw new Error('INITIAL_ADMIN_USERNAME must have at least 3 characters');
  }
  options.sui = {
    baseUrl: pick('suiApiUrl', 'SUI_API_URL'),
    token: pick('suiApiToken', 'SUI_API_TOKEN'),
    vlessInboundId: number('suiVlessInboundId', 'SUI_VLESS_INBOUND_ID', 0, 1, Number.MAX_SAFE_INTEGER),
    tuicInboundId: number('suiTuicInboundId', 'SUI_TUIC_INBOUND_ID', 0, 0, Number.MAX_SAFE_INTEGER),
  };
  if (overrides.adapter === undefined) {
    paired([options.sui.baseUrl, options.sui.token, options.sui.vlessInboundId], ['SUI_API_URL', 'SUI_API_TOKEN', 'SUI_VLESS_INBOUND_ID']);
    if (options.sui.baseUrl) {
      let url;
      try { url = new URL(options.sui.baseUrl); } catch { /* Report configuration names, not secrets. */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('SUI_API_URL must be an HTTP(S) URL without credentials, a query, or a fragment');
      }
      if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
        throw new Error('Remote SUI_API_URL requires HTTPS; plain HTTP is allowed only on loopback');
      }
    }
  }
  options.deviceCa = {
    caCertificatePath: pick('deviceCaCertificatePath', 'DEVICE_CA_CERT_PATH'),
    caPrivateKeyPath: pick('deviceCaPrivateKeyPath', 'DEVICE_CA_KEY_PATH'),
    opensslPath: pick('opensslPath', 'OPENSSL_PATH', 'openssl'),
  };
  if (overrides.certificateIssuer === undefined) {
    paired([options.deviceCa.caCertificatePath, options.deviceCa.caPrivateKeyPath], ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH']);
  }
  options.dataPlane = {
    certificatePath: pick('dataPlaneCertificatePath', 'DATA_PLANE_CERT_PATH'),
    privateKeyPath: pick('dataPlanePrivateKeyPath', 'DATA_PLANE_KEY_PATH'),
    deviceCaCertificatePath: options.deviceCa.caCertificatePath,
    internalHost: options.dataPlaneInternalHost,
    internalPort: options.dataPlaneInternalPort,
  };
  // A CA can be configured for issuance without starting a public gateway.
  if (!options.disableDataPlane && (options.dataPlane.certificatePath || options.dataPlane.privateKeyPath)) {
    paired([options.dataPlane.certificatePath, options.dataPlane.privateKeyPath, options.dataPlane.deviceCaCertificatePath],
      ['DATA_PLANE_CERT_PATH', 'DATA_PLANE_KEY_PATH', 'DEVICE_CA_CERT_PATH']);
  }
  return options;
}
