import { execFile } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalizedFingerprint(value) {
  return String(value || '').replaceAll(':', '').toLowerCase();
}

export function createDeviceCertificateIssuer(options = {}) {
  if (!options.caCertificatePath || !options.caPrivateKeyPath) return null;
  const openssl = options.opensslPath || 'openssl';

  return async function issueDeviceCertificate({ deviceId, publicKeyPem }) {
    const workspace = await mkdtemp(join(tmpdir(), 'cloudbridge-cert-'));
    const publicKeyPath = join(workspace, 'device-public.pem');
    const extensionsPath = join(workspace, 'extensions.cnf');
    const certificatePath = join(workspace, 'device-cert.pem');
    const serial = randomBytes(16).toString('hex');
    try {
      await writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 });
      await writeFile(extensionsPath, [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=clientAuth',
        `subjectAltName=URI:urn:cloudbridge:device:${deviceId}`,
        '',
      ].join('\n'), { mode: 0o600 });
      await execFileAsync(openssl, [
        'x509', '-new', '-force_pubkey', publicKeyPath,
        '-subj', `/CN=${deviceId}`,
        '-CA', options.caCertificatePath,
        '-CAkey', options.caPrivateKeyPath,
        '-set_serial', `0x${serial}`,
        '-days', String(options.validDays || 1),
        '-sha256', '-extfile', extensionsPath,
        '-out', certificatePath,
      ], { windowsHide: true, timeout: 15_000 });
      const certificatePem = await readFile(certificatePath, 'utf8');
      const parsed = new X509Certificate(certificatePem);
      return {
        certificatePem,
        fingerprintSha256: normalizedFingerprint(parsed.fingerprint256),
        serialNumber: parsed.serialNumber.toLowerCase(),
        expiresAt: new Date(parsed.validTo).toISOString(),
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
}

