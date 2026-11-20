import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const POOL_PREFIX = 'v2-pool:';
export const MAX_API_KEYS_PER_USER = 10;

export interface StoredApiKeyEntry {
  id: string;
  label: string;
  encryptedKey: string;
  maskedKey: string;
  fingerprint: string;
  addedAt: string;
}

export interface DecryptedApiKeyEntry {
  id: string;
  label: string;
  apiKey: string;
  maskedKey: string;
  fingerprint: string;
  addedAt: string;
}

function getEncryptionKey(): Buffer {
  const appSecret = process.env.APP_ENCRYPTION_KEY?.trim();
  if (appSecret) {
    return crypto.createHash('sha256').update(appSecret).digest();
  }

  // Fallback memakai SUPABASE_SERVICE_ROLE_KEY (khusus server) dengan domain separation
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceKey) {
    return crypto
      .createHmac('sha256', serviceKey)
      .update('surya-smart-home-gemini-key-v1')
      .digest();
  }

  throw new Error(
    'APP_ENCRYPTION_KEY atau SUPABASE_SERVICE_ROLE_KEY belum diatur di .env.local.'
  );
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Format enkripsi API Key tidak valid.');
  }

  const [, ivHex, authTagHex, dataHex] = parts;
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 10) {
    return '••••••••';
  }
  return `${trimmed.slice(0, 5)}••••••${trimmed.slice(-4)}`;
}

/**
 * Menghasilkan fingerprint satu arah yang terisolasi per userId untuk mencegah duplikasi token
 * di dalam akun user yang sama tanpa pernah mengekspos plaintext key.
 */
export function hashApiKeyFingerprint(rawApiKey: string, userId = ''): string {
  return crypto
    .createHmac('sha256', getEncryptionKey())
    .update(`${userId}:${rawApiKey.trim()}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Membaca daftar token milik satu user dari kolom encrypted_gemini_api_key.
 * Kompatibel mundur 100% dengan format tunggal lama ("v1:...") maupun format multi-token ("v2-pool:...").
 */
export function parseStoredApiKeys(
  rawEncryptedColumn: string | null | undefined,
  legacyKeyHint?: string | null,
  userId = ''
): StoredApiKeyEntry[] {
  const raw = rawEncryptedColumn?.trim();
  if (!raw) return [];

  if (raw.startsWith(POOL_PREFIX)) {
    try {
      const jsonStr = raw.slice(POOL_PREFIX.length);
      const parsed = JSON.parse(jsonStr) as unknown;
      if (!Array.isArray(parsed)) return [];

      const valid: StoredApiKeyEntry[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i] as Partial<StoredApiKeyEntry> | null;
        if (
          item &&
          typeof item.encryptedKey === 'string' &&
          item.encryptedKey.startsWith('v1:')
        ) {
          valid.push({
            id:
              typeof item.id === 'string' && item.id.trim()
                ? item.id.trim()
                : `key_${i + 1}`,
            label:
              typeof item.label === 'string' && item.label.trim()
                ? item.label.trim()
                : i === 0
                  ? 'Token Utama #1'
                  : `Token Cadangan #${i + 1}`,
            encryptedKey: item.encryptedKey,
            maskedKey:
              typeof item.maskedKey === 'string' && item.maskedKey.trim()
                ? item.maskedKey.trim()
                : '••••••••',
            fingerprint:
              typeof item.fingerprint === 'string' && item.fingerprint.trim()
                ? item.fingerprint.trim()
                : `fp_${i + 1}`,
            addedAt:
              typeof item.addedAt === 'string' && item.addedAt.trim()
                ? item.addedAt
                : new Date().toISOString(),
          });
        }
      }
      return valid.slice(0, MAX_API_KEYS_PER_USER);
    } catch {
      return [];
    }
  }

  // Kompatibilitas mundur: format single key lama "v1:<iv>:<tag>:<cipher>"
  if (raw.startsWith('v1:')) {
    let masked = legacyKeyHint?.trim() || '••••••••';
    let fingerprint = 'legacy_primary';
    try {
      const plain = decryptSecret(raw);
      masked = maskApiKey(plain);
      fingerprint = hashApiKeyFingerprint(plain, userId);
    } catch {
      // Gunakan fallback hint bila dekripsi gagal
    }

    return [
      {
        id: 'key_primary_1',
        label: 'Token Utama #1',
        encryptedKey: raw,
        maskedKey: masked,
        fingerprint,
        addedAt: new Date().toISOString(),
      },
    ];
  }

  return [];
}

/**
 * Mendekripsi seluruh token di dalam pool milik satu user (hanya dijalankan di server).
 */
export function decryptStoredApiKeys(
  rawEncryptedColumn: string | null | undefined,
  legacyKeyHint?: string | null,
  userId = ''
): DecryptedApiKeyEntry[] {
  const stored = parseStoredApiKeys(rawEncryptedColumn, legacyKeyHint, userId);
  const decryptedList: DecryptedApiKeyEntry[] = [];

  for (const item of stored) {
    try {
      const apiKey = decryptSecret(item.encryptedKey);
      if (apiKey) {
        decryptedList.push({
          id: item.id,
          label: item.label,
          apiKey,
          maskedKey: item.maskedKey || maskApiKey(apiKey),
          fingerprint:
            item.fingerprint && item.fingerprint !== 'legacy_primary'
              ? item.fingerprint
              : hashApiKeyFingerprint(apiKey, userId),
          addedAt: item.addedAt,
        });
      }
    } catch {
      // Lewati token yang gagal didekripsi
    }
  }

  return decryptedList;
}

/**
 * Menyimpan array token terenkripsi milik user ke format kolom encrypted_gemini_api_key & key_hint.
 */
export function serializeStoredApiKeys(entries: StoredApiKeyEntry[]): {
  encryptedPayload: string | null;
  summaryHint: string | null;
} {
  const clean = entries.slice(0, MAX_API_KEYS_PER_USER);
  if (clean.length === 0) {
    return { encryptedPayload: null, summaryHint: null };
  }

  const primaryMask = clean[0].maskedKey;
  const summaryHint =
    clean.length === 1
      ? primaryMask
      : `${primaryMask} (+${clean.length - 1} cadangan)`;

  return {
    encryptedPayload: `${POOL_PREFIX}${JSON.stringify(clean)}`,
    summaryHint,
  };
}
