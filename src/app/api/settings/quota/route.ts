import { NextResponse } from 'next/server';
import { parseStoredApiKeys } from '@/lib/crypto';
import {
  GEMINI_FREE_TIER_LIMITS,
  buildPerTokenQuotaSummaries,
  getOrInitUserLedger,
  getPacificQuotaWindow,
} from '@/lib/quota';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const nowMs = Date.now();
    const windowInfo = getPacificQuotaWindow(nowMs);
    const ledger = getOrInitUserLedger(user.id, nowMs);
    const oneMinuteAgoMs = nowMs - 60_000;
    const oneMinuteAgoIso = new Date(oneMinuteAgoMs).toISOString();

    const [todayAssistantRes, recentMinuteRes, settingsRes] = await Promise.all([
      supabase
        .from('chat_messages')
        .select('id, content, created_at')
        .eq('user_id', user.id)
        .eq('role', 'assistant')
        .gte('created_at', windowInfo.dayStartIso),
      supabase
        .from('chat_messages')
        .select('id, created_at')
        .eq('user_id', user.id)
        .eq('role', 'assistant')
        .gte('created_at', oneMinuteAgoIso),
      supabase
        .from('user_settings')
        .select('encrypted_gemini_api_key, key_hint')
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);

    const todayDbMessages = todayAssistantRes.data ?? [];
    const recentDbMessages = recentMinuteRes.data ?? [];

    // Ambil daftar token khusus milik user yang sedang login (terisolasi per user.id)
    const storedKeys = parseStoredApiKeys(
      settingsRes.data?.encrypted_gemini_api_key,
      settingsRes.data?.key_hint,
      user.id
    );
    const tokenCount = storedKeys.length;
    const hasApiKey = tokenCount > 0;
    const poolMultiplier = Math.max(1, tokenCount);

    const pooledRpdLimit = GEMINI_FREE_TIER_LIMITS.RPD_LIMIT * poolMultiplier;
    const pooledRpmLimit = GEMINI_FREE_TIER_LIMITS.RPM_LIMIT * poolMultiplier;
    const pooledTokenBudget =
      GEMINI_FREE_TIER_LIMITS.DAILY_TOKEN_BUDGET * poolMultiplier;

    const extraNonDbEventsToday = ledger.events.filter((e) => !e.countedInDb);
    const extraNonDbEventsLastMinute = extraNonDbEventsToday.filter(
      (e) => e.timestampMs >= oneMinuteAgoMs
    );

    const dbRequestsToday = todayDbMessages.length;
    const extraRequestsToday = extraNonDbEventsToday.length;
    const usedRpd =
      dbRequestsToday + ledger.archivedRequests + extraRequestsToday;
    const remainingRpd = Math.max(0, pooledRpdLimit - usedRpd);
    const percentRemainingRpd = Math.max(
      0,
      Math.min(100, Math.round((remainingRpd / pooledRpdLimit) * 1000) / 10)
    );

    const usedRpm = recentDbMessages.length + extraNonDbEventsLastMinute.length;
    const remainingRpm = Math.max(0, pooledRpmLimit - usedRpm);

    const dbTokensToday = todayDbMessages.reduce((acc, msg) => {
      const charTokens = Math.ceil((msg.content?.length ?? 0) / 4);
      return acc + 1800 + charTokens;
    }, 0);
    const extraTokensToday = extraNonDbEventsToday.reduce(
      (acc, ev) => acc + ev.tokens,
      0
    );
    const usedTokensToday =
      dbTokensToday + ledger.archivedTokens + extraTokensToday;
    const remainingTokensToday = Math.max(
      0,
      pooledTokenBudget - usedTokensToday
    );

    const tokens = buildPerTokenQuotaSummaries(
      user.id,
      storedKeys,
      dbRequestsToday,
      recentDbMessages.length,
      nowMs
    );

    const readyTokensCount = tokens.filter((t) => t.status === 'ready').length;
    const activeToken = tokens.find((t) => t.isActiveNow) ?? tokens[0] ?? null;

    // Cooldown global hanya aktif jika SELURUH token di dalam pool sedang cooldown
    const allTokensCooling =
      hasApiKey &&
      readyTokensCount === 0 &&
      tokens.some((t) => t.cooldownRemainingSec > 0);
    const minCooldownSec = allTokensCooling
      ? Math.min(
          ...tokens
            .filter((t) => t.cooldownRemainingSec > 0)
            .map((t) => t.cooldownRemainingSec)
        )
      : 0;

    return NextResponse.json({
      hasApiKey,
      tokenCount,
      readyTokensCount,
      activeToken: activeToken
        ? {
            id: activeToken.id,
            label: activeToken.label,
            maskedKey: activeToken.maskedKey,
            priority: activeToken.priority,
          }
        : null,
      status: !hasApiKey
        ? 'no-key'
        : allTokensCooling
          ? 'cooldown'
          : 'ready',
      cooldownRemainingSec: minCooldownSec,
      rpd: {
        used: usedRpd,
        remaining: remainingRpd,
        limit: pooledRpdLimit,
        perTokenLimit: GEMINI_FREE_TIER_LIMITS.RPD_LIMIT,
        percentRemaining: percentRemainingRpd,
        breakdown: {
          chatAndVoice: dbRequestsToday + ledger.archivedRequests,
          voiceTestPreview: extraRequestsToday,
        },
      },
      rpm: {
        used: usedRpm,
        remaining: remainingRpm,
        limit: pooledRpmLimit,
        perTokenLimit: GEMINI_FREE_TIER_LIMITS.RPM_LIMIT,
      },
      tokensToday: {
        used: usedTokensToday,
        remaining: remainingTokensToday,
        limit: pooledTokenBudget,
      },
      tokens,
      reset: {
        dayStartIso: windowInfo.dayStartIso,
        nextResetIso: windowInfo.nextResetIso,
        resetInSeconds: windowInfo.resetInSeconds,
        resetWibLabel: windowInfo.resetWibLabel,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Gagal memuat informasi kuota.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
