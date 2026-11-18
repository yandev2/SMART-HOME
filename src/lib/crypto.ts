import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

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

