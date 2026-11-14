import { randomBytes, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(deriveKey);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, options);
  return `scrypt:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [
    ,
    salt = '00000000000000000000000000000000',
    expected = '00'.repeat(64),
  ] = (encoded ?? '').split(':');
  const key = await scrypt(password, salt, 64, options);
  const buffer = Buffer.from(expected, 'hex');
  return (
    buffer.length === key.length &&
    timingSafeEqual(key, buffer) &&
    Boolean(encoded)
  );
}
