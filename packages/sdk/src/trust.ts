import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalDigest } from './integrity.js';

/** Public keys are written `ed25519:` + base64url (no padding) of the 32-byte raw key. */
export const PUBLIC_KEY_PATTERN = /^ed25519:[A-Za-z0-9_-]{43}$/;
/** Domain-separation prefixes: a package signature can never be replayed as an approval signature. */
export const PACKAGE_SIGNATURE_CONTEXT = 'OLS-PACKAGE-SIGNATURE-v1\n';
export const APPROVAL_SIGNATURE_CONTEXT = 'OLS-APPROVAL-SIGNATURE-v1\n';
/** Authority statuses that assert review or approval and therefore need an attesting approval document. */
export const ATTESTED_STATUSES = ['parish-reviewed', 'diocesan-approved', 'synodal-approved'] as const;

export type SignatureEntry = { key: string; signature: string; signer?: string; created?: string };
export type KeyringEntry = { key: string; name?: string; approves?: string[] };
export type Keyring = { keys: KeyringEntry[] };

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** Generates an Ed25519 key pair: a PKCS#8 PEM private key and the `ed25519:` public key. */
export function generateSigningKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })), publicKey: `ed25519:${String(publicKey.export({ format: 'jwk' }).x)}` };
}

/** The `ed25519:` public key for a PKCS#8 PEM private key. */
export function publicKeyFor(privateKeyPem: string): string {
  return `ed25519:${String(createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }).x)}`;
}

/** The message signed for a package: the context prefix followed by the package digest. */
export function packageSignatureMessage(packageDigestValue: string): Buffer {
  return Buffer.from(PACKAGE_SIGNATURE_CONTEXT + packageDigestValue, 'utf8');
}

/** The message signed for an approval: the context prefix followed by the digest of the approval without `signatures`. */
export function approvalSignatureMessage(approval: Record<string, unknown>): Buffer {
  const { signatures: _ignored, ...signed } = approval;
  return Buffer.from(APPROVAL_SIGNATURE_CONTEXT + canonicalDigest(signed), 'utf8');
}

export function signMessage(message: Buffer, privateKeyPem: string): SignatureEntry {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Only Ed25519 private keys are supported.');
  return { key: publicKeyFor(privateKeyPem), signature: toBase64Url(sign(null, message, privateKey)) };
}

/** True when `entry.signature` is a valid Ed25519 signature of `message` by `entry.key`. Malformed input is invalid, not an exception. */
export function verifySignature(message: Buffer, entry: SignatureEntry): boolean {
  if (typeof entry?.key !== 'string' || !PUBLIC_KEY_PATTERN.test(entry.key) || typeof entry.signature !== 'string') return false;
  try {
    const signature = Buffer.from(entry.signature, 'base64url');
    if (signature.length !== 64) return false;
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: entry.key.slice('ed25519:'.length) }, format: 'jwk' });
    return verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/** The keyring entry for a key, if the consumer trusts it. */
export function trustedKey(keyring: Keyring | undefined, key: string): KeyringEntry | undefined {
  return keyring?.keys?.find((entry) => entry.key === key);
}
