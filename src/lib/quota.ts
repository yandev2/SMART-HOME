// Utilitas pelacak pemakaian kuota, rate limit, dan Auto-Failover Multi-Token Gemini API
// Terisolasi penuh per userId (setiap user memiliki ledger dan pool token masing-masing).
// Kuota harian (RPD) Google AI Studio di-reset setiap pukul 00:00 Pacific Time (America/Los_Angeles).

import type { DecryptedApiKeyEntry, StoredApiKeyEntry } from './crypto';

export const GEMINI_FREE_TIER_LIMITS = {
  RPD_LIMIT: 1500, // 1.500 Request per Hari per Token
  RPM_LIMIT: 15, // 15 Request per Menit per Token
  TPM_LIMIT: 1_000_000, // 1.000.000 Token per Menit per Token
  DAILY_TOKEN_BUDGET: 1_500_000, // Estimasi plafon aman token harian per Token
  ESTIMATED_TOKENS_PER_CHAT: 1900, // ~1.750 input + ~150 output audio/teks
  ESTIMATED_TOKENS_PER_TTS_PREVIEW: 450,
} as const;

export type GeminiRequestKind = 'live-voice' | 'chat-text' | 'tts-preview';

interface QuotaEvent {
  timestampMs: number;
  kind: GeminiRequestKind;
  tokens: number;
  countedInDb: boolean;
  keyId: string;
}

export interface PerKeyRuntimeState {
  cooldownUntilMs: number;
  dailyExhausted: boolean;
  lastError: string | null;
  lastUsedMs: number;
  failoverCountToday: number;
}

interface UserQuotaLedger {
  dayKey: string;
  archivedRequests: number;
  archivedTokens: number;
  archivedByKey: Record<string, { requests: number; tokens: number }>;
  events: QuotaEvent[];
  cooldownUntilMs: number;
  activeKeyId: string | null;
  keyStates: Record<string, PerKeyRuntimeState>;
}

const globalForQuota = globalThis as unknown as {
  __geminiUserQuotaMap?: Map<string, UserQuotaLedger>;
};

function getQuotaMap(): Map<string, UserQuotaLedger> {
  if (!globalForQuota.__geminiUserQuotaMap) {
    globalForQuota.__geminiUserQuotaMap = new Map();
  }
  return globalForQuota.__geminiUserQuotaMap;
}

/**
 * Menghitung batas waktu hari kuota Google AI Studio saat ini berdasarkan zona waktu
 * America/Los_Angeles (00:00 PT -> 00:00 PT berikutnya).
 */
export function getPacificQuotaWindow(nowMs = Date.now()): {
  dayKey: string;
  dayStartMs: number;
  dayStartIso: string;
  nextResetMs: number;
  nextResetIso: string;
  resetInSeconds: number;
  resetWibLabel: string;
} {
  const now = new Date(nowMs);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const getPart = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour') % 24;
  const minute = getPart('minute');
  const second = getPart('second');

  const elapsedTodayMs =
    ((hour * 60 + minute) * 60 + second) * 1000 + (nowMs % 1000);
  const dayStartMs = nowMs - elapsedTodayMs;
  const nextResetMs = dayStartMs + 24 * 60 * 60 * 1000;

  const dayKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const wibFmt = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const resetWibLabel = `${wibFmt.format(new Date(nextResetMs)).replace('.', ':')} WIB`;

  return {
    dayKey,
    dayStartMs,
    dayStartIso: new Date(dayStartMs).toISOString(),
    nextResetMs,
    nextResetIso: new Date(nextResetMs).toISOString(),
    resetInSeconds: Math.max(0, Math.ceil((nextResetMs - nowMs) / 1000)),
    resetWibLabel,
  };
}

export function getOrInitUserLedger(userId: string, nowMs = Date.now()): UserQuotaLedger {
  const map = getQuotaMap();
  const { dayKey, dayStartMs } = getPacificQuotaWindow(nowMs);
  const existing = map.get(userId);

  if (!existing || existing.dayKey !== dayKey) {
    const fresh: UserQuotaLedger = {
      dayKey,
      archivedRequests: 0,
      archivedTokens: 0,
      archivedByKey: {},
      events: [],
      cooldownUntilMs:
        existing?.cooldownUntilMs && existing.cooldownUntilMs > nowMs
          ? existing.cooldownUntilMs
          : 0,
      activeKeyId: existing?.activeKeyId ?? null,
      keyStates: {},
    };
    map.set(userId, fresh);
    return fresh;
  }

  existing.events = existing.events.filter((e) => e.timestampMs >= dayStartMs);
  return existing;
}

export function getOrInitKeyState(
  ledger: UserQuotaLedger,
  keyId: string
): PerKeyRuntimeState {
  if (!ledger.keyStates[keyId]) {
    ledger.keyStates[keyId] = {
      cooldownUntilMs: 0,
      dailyExhausted: false,
      lastError: null,
      lastUsedMs: 0,
      failoverCountToday: 0,
    };
  }
  return ledger.keyStates[keyId];
}

export function recordGeminiRequest(
  userId: string,
  kind: GeminiRequestKind,
  estimatedTokens?: number,
  countedInDb = kind !== 'tts-preview',
  keyId = 'key_primary_1'
) {
  const nowMs = Date.now();
  const ledger = getOrInitUserLedger(userId, nowMs);
  const tokens =
    estimatedTokens ??
    (kind === 'tts-preview'
      ? GEMINI_FREE_TIER_LIMITS.ESTIMATED_TOKENS_PER_TTS_PREVIEW
      : GEMINI_FREE_TIER_LIMITS.ESTIMATED_TOKENS_PER_CHAT);

  ledger.events.push({
    timestampMs: nowMs,
    kind,
    tokens,
    countedInDb,
    keyId,
  });

  ledger.activeKeyId = keyId;
  const kState = getOrInitKeyState(ledger, keyId);
  kState.lastUsedMs = nowMs;
  kState.cooldownUntilMs = 0;
  kState.lastError = null;
}

export function archiveDeletedChatQuota(
  userId: string,
  deletedTodayRequests: number,
  deletedTodayTokens: number
) {
  if (deletedTodayRequests <= 0) return;
  const ledger = getOrInitUserLedger(userId);
  ledger.archivedRequests += deletedTodayRequests;
  ledger.archivedTokens += deletedTodayTokens;

  // Arsipkan juga rincian per-token dari event chat yang sudah tercatat hari ini sebelum dihapus
  for (const ev of ledger.events) {
    if (ev.countedInDb) {
      const prev = ledger.archivedByKey[ev.keyId] ?? { requests: 0, tokens: 0 };
      prev.requests += 1;
      prev.tokens += ev.tokens;
      ledger.archivedByKey[ev.keyId] = prev;
    }
  }
  ledger.events = ledger.events.filter((e) => !e.countedInDb);
}

/**
 * Mencatat bahwa satu token tertentu milik user terkena limit (RPM atau RPD)
 * sehingga request berikutnya langsung melompat ke token cadangan berikutnya.
 */
export function recordKeyRateLimit(
  userId: string,
  keyId: string,
  options?: {
    isDailyExhausted?: boolean;
    cooldownMs?: number;
    errorMessage?: string;
  }
) {
  const nowMs = Date.now();
  const ledger = getOrInitUserLedger(userId, nowMs);
  const kState = getOrInitKeyState(ledger, keyId);
  const cooldownMs = options?.cooldownMs ?? 60_000;

  kState.failoverCountToday += 1;
  kState.lastError = options?.errorMessage ?? 'Terkena batas rate limit (429)';

  if (options?.isDailyExhausted) {
    kState.dailyExhausted = true;
    const { nextResetMs } = getPacificQuotaWindow(nowMs);
    kState.cooldownUntilMs = nextResetMs;
  } else {
    kState.cooldownUntilMs = Math.max(kState.cooldownUntilMs, nowMs + cooldownMs);
  }
}

export function recordGeminiCooldown(userId: string, durationMs = 60_000, keyId?: string) {
  const nowMs = Date.now();
  const ledger = getOrInitUserLedger(userId, nowMs);
  if (keyId) {
    recordKeyRateLimit(userId, keyId, { cooldownMs: durationMs });
  } else {
    ledger.cooldownUntilMs = Math.max(ledger.cooldownUntilMs, nowMs + durationMs);
  }
}

export function clearGeminiCooldown(userId: string, keyId?: string) {
  const ledger = getOrInitUserLedger(userId);
  if (keyId) {
    const kState = getOrInitKeyState(ledger, keyId);
    kState.cooldownUntilMs = 0;
    kState.dailyExhausted = false;
    kState.lastError = null;
  } else {
    ledger.cooldownUntilMs = 0;
  }
}

export function getGeminiCooldownUntil(userId: string, keyId?: string): number {
  const ledger = getOrInitUserLedger(userId);
  if (keyId) {
    return getOrInitKeyState(ledger, keyId).cooldownUntilMs;
  }
  return ledger.cooldownUntilMs;
}

/**
 * Menganalisis error dari Gemini SDK untuk mendeteksi apakah error disebabkan oleh
 * kuota/limit/key sehingga layak langsung di-failover ke token cadangan berikutnya.
 */
export function classifyGeminiFailoverError(err: unknown): {
  shouldFailover: boolean;
  isDailyExhausted: boolean;
  reason: string;
} {
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();

  const isDaily =
    text.includes('per day') ||
    text.includes('per_day') ||
    text.includes('rpd') ||
    text.includes('daily') ||
    text.includes('requests_per_day');

  const isRateOrQuota =
    text.includes('429') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('resource_exhausted') ||
    text.includes('too many requests');

  const isServerBusyOrKeyIssue =
    text.includes('503') ||
    text.includes('high demand') ||
    text.includes('overloaded') ||
    text.includes('api_key_invalid') ||
    text.includes('api key not valid') ||
    text.includes('permission_denied') ||
    text.includes('403');

  if (isRateOrQuota || isDaily) {
    return {
      shouldFailover: true,
      isDailyExhausted: isDaily,
      reason: isDaily ? 'Kuota harian token habis' : 'Terkena batas RPM (429)',
    };
  }

  if (isServerBusyOrKeyIssue) {
    return {
      shouldFailover: true,
      isDailyExhausted: false,
      reason: 'Server sibuk / gangguan pada token',
    };
  }

  return {
    shouldFailover: false,
    isDailyExhausted: false,
    reason: text.slice(0, 120),
  };
}

/**
 * Mengurutkan daftar token milik user untuk eksekusi:
 * 1. Token yang sehat (tidak cooldown, tidak dailyExhausted, RPM < 15, RPD < 1500) sesuai urutan prioritas user (Token A -> B -> C).
 * 2. Token yang sedang cooldown ringan (diurutkan dari cooldown paling cepat selesai) sebagai cadangan terakhir.
 */
export function selectOrderedCandidateKeys(
  userId: string,
  keys: DecryptedApiKeyEntry[]
): DecryptedApiKeyEntry[] {
  if (keys.length <= 1) return keys;

  const nowMs = Date.now();
  const oneMinuteAgoMs = nowMs - 60_000;
  const ledger = getOrInitUserLedger(userId, nowMs);

  const healthy: DecryptedApiKeyEntry[] = [];
  const coolingDown: Array<{ entry: DecryptedApiKeyEntry; readyAt: number }> = [];

  for (const entry of keys) {
    const kState = getOrInitKeyState(ledger, entry.id);
    const keyEventsToday = ledger.events.filter((e) => e.keyId === entry.id);
    const archivedForKey = ledger.archivedByKey[entry.id]?.requests ?? 0;
    const rpdUsed = keyEventsToday.length + archivedForKey;
    const rpmUsed = keyEventsToday.filter((e) => e.timestampMs >= oneMinuteAgoMs).length;

    const isCooling = kState.cooldownUntilMs > nowMs;
    const isExhausted =
      kState.dailyExhausted || rpdUsed >= GEMINI_FREE_TIER_LIMITS.RPD_LIMIT;
    const isRpmFull = rpmUsed >= GEMINI_FREE_TIER_LIMITS.RPM_LIMIT;

    if (!isCooling && !isExhausted && !isRpmFull) {
      healthy.push(entry);
    } else {
      const readyAt = isExhausted
        ? Number.MAX_SAFE_INTEGER
        : isCooling
          ? kState.cooldownUntilMs
          : nowMs + 15_000;
      coolingDown.push({ entry, readyAt });
    }
  }

  coolingDown.sort((a, b) => a.readyAt - b.readyAt);
  return [...healthy, ...coolingDown.map((c) => c.entry)];
}

export interface TokenQuotaSummaryItem {
  id: string;
  label: string;
  maskedKey: string;
  priority: number;
  isPrimary: boolean;
  isActiveNow: boolean;
  status: 'ready' | 'cooldown' | 'exhausted';
  cooldownRemainingSec: number;
  usedToday: number;
  remainingToday: number;
  limitToday: number;
  usedLastMinute: number;
  limitPerMinute: number;
  failoverCountToday: number;
  lastError: string | null;
}

/**
 * Menghitung ringkasan kuota per-token untuk ditampilkan di UI Pengaturan.
 */
export function buildPerTokenQuotaSummaries(
  userId: string,
  storedKeys: StoredApiKeyEntry[],
  totalDbRequestsToday: number,
  totalDbRequestsLastMinute: number,
  nowMs = Date.now()
): TokenQuotaSummaryItem[] {
  const ledger = getOrInitUserLedger(userId, nowMs);
  const oneMinuteAgoMs = nowMs - 60_000;

  // Hitung total event yang memiliki keyId spesifik di memori
  const trackedDbEventsToday = ledger.events.filter((e) => e.countedInDb);
  const untrackedDbRequestsToday = Math.max(
    0,
    totalDbRequestsToday - trackedDbEventsToday.length
  );

  const trackedDbEventsLastMin = trackedDbEventsToday.filter(
    (e) => e.timestampMs >= oneMinuteAgoMs
  );
  const untrackedDbRequestsLastMin = Math.max(
    0,
    totalDbRequestsLastMinute - trackedDbEventsLastMin.length
  );

  // Tentukan token mana yang saat ini menjadi kandidat aktif pertama
  let activeCandidateId: string | null = null;
  for (const k of storedKeys) {
    const st = getOrInitKeyState(ledger, k.id);
    if (!st.dailyExhausted && st.cooldownUntilMs <= nowMs) {
      activeCandidateId = k.id;
      break;
    }
  }
  if (!activeCandidateId && storedKeys.length > 0) {
    activeCandidateId = storedKeys[0].id;
  }

  return storedKeys.map((k, idx) => {
    const st = getOrInitKeyState(ledger, k.id);
    const keyEventsToday = ledger.events.filter((e) => e.keyId === k.id);
    const keyEventsLastMin = keyEventsToday.filter(
      (e) => e.timestampMs >= oneMinuteAgoMs
    );
    const archivedCount = ledger.archivedByKey[k.id]?.requests ?? 0;

    // Pesan DB yang dibuat sebelum server restart dialokasikan ke token utama (#1)
    const fallbackToday = idx === 0 ? untrackedDbRequestsToday : 0;
    const fallbackLastMin = idx === 0 ? untrackedDbRequestsLastMin : 0;

    const usedToday = keyEventsToday.length + archivedCount + fallbackToday;
    const remainingToday = Math.max(
      0,
      GEMINI_FREE_TIER_LIMITS.RPD_LIMIT - usedToday
    );
    const usedLastMinute = keyEventsLastMin.length + fallbackLastMin;

    const cooldownRemainingSec =
      st.cooldownUntilMs > nowMs
        ? Math.ceil((st.cooldownUntilMs - nowMs) / 1000)
        : 0;

    const isExhausted =
      st.dailyExhausted || usedToday >= GEMINI_FREE_TIER_LIMITS.RPD_LIMIT;
    const status: 'ready' | 'cooldown' | 'exhausted' = isExhausted
      ? 'exhausted'
      : cooldownRemainingSec > 0
        ? 'cooldown'
        : 'ready';

    return {
      id: k.id,
      label: k.label,
      maskedKey: k.maskedKey,
      priority: idx + 1,
      isPrimary: idx === 0,
      isActiveNow: k.id === activeCandidateId,
      status,
      cooldownRemainingSec,
      usedToday,
      remainingToday,
      limitToday: GEMINI_FREE_TIER_LIMITS.RPD_LIMIT,
      usedLastMinute,
      limitPerMinute: GEMINI_FREE_TIER_LIMITS.RPM_LIMIT,
      failoverCountToday: st.failoverCountToday,
      lastError: st.lastError,
    };
  });
}
