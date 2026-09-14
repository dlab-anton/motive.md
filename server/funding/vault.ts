import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function parseFundingVaultKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(value)) throw new Error('MOTIVE_FUNDING_VAULT_KEY must be a base64url-encoded 32-byte key.');
  const key = Buffer.from(value, 'base64url');
  if (key.byteLength !== 32) throw new Error('MOTIVE_FUNDING_VAULT_KEY must decode to exactly 32 bytes.');
  return key;
}

export function encryptSecret(key: Uint8Array, plaintext: string, context: string): Buffer {
  if (key.byteLength !== 32) throw new Error('Funding vault key must contain 32 bytes.');
  if (!plaintext || plaintext.length > 16_384) throw new Error('Secret has an invalid length.');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(key: Uint8Array, envelope: Uint8Array, context: string): string {
  if (key.byteLength !== 32 || envelope.byteLength <= 1 + NONCE_BYTES + TAG_BYTES) throw new Error('Encrypted secret is invalid.');
  const bytes = Buffer.from(envelope);
  if (bytes[0] !== VERSION) throw new Error('Encrypted secret version is unsupported.');
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(1 + NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
