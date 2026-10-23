import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHex) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordPolicyError(password) {
  if (typeof password !== 'string' || password.length < 16) return '密码至少16个字符';
  if (password.length > 128) return '密码不能超过128个字符';
  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
    .filter((pattern) => pattern.test(password)).length;
  if (categories < 3) return '密码需包含大写字母、小写字母、数字和符号中的至少三类';
  return '';
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function activationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = [...randomBytes(12)].map((byte) => alphabet[byte & 31]).join('');
  return raw.match(/.{4}/g).join('-');
}
