import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { NextResponse } from 'next/server';
import {
  MAX_API_KEYS_PER_USER,
  type StoredApiKeyEntry,
  encryptSecret,
  hashApiKeyFingerprint,
  maskApiKey,
  parseStoredApiKeys,
  serializeStoredApiKeys,
} from '@/lib/crypto';
import { clearGeminiCooldown } from '@/lib/quota';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

async function loadUserStoredKeys(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<{
  entries: StoredApiKeyEntry[];
  updatedAt: string | null;
}> {
  const { data, error } = await supabase
    .from('user_settings')
    .select('encrypted_gemini_api_key, key_hint, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const entries = parseStoredApiKeys(
    data?.encrypted_gemini_api_key,
    data?.key_hint,
    userId
  );

  return {
    entries,
    updatedAt: data?.updated_at ?? null,
  };
}

function formatPublicKeysResponse(
  entries: StoredApiKeyEntry[],
  updatedAt: string | null
) {
  const { summaryHint } = serializeStoredApiKeys(entries);
  return {
    hasKey: entries.length > 0,
    maskedKey: summaryHint,
    tokenCount: entries.length,
    maxTokens: MAX_API_KEYS_PER_USER,
    updatedAt,
    keys: entries.map((item, idx) => ({
      id: item.id,
      label: item.label,
      maskedKey: item.maskedKey,
      addedAt: item.addedAt,
      priority: idx + 1,
      isPrimary: idx === 0,
    })),
  };
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { entries, updatedAt } = await loadUserStoredKeys(supabase, user.id);
    return NextResponse.json(formatPublicKeysResponse(entries, updatedAt));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      apiKey?: string;
      label?: string;
      makePrimary?: boolean;
    } | null;

    const rawKey = body?.apiKey?.trim() ?? '';
    const customLabel = body?.label?.trim() ?? '';

    if (!rawKey || rawKey.length < 20 || /\s/.test(rawKey)) {
      return NextResponse.json(
        { error: 'Format API Key Gemini tidak valid.' },
        { status: 400 }
      );
    }

    const { entries } = await loadUserStoredKeys(supabase, user.id);

    if (entries.length >= MAX_API_KEYS_PER_USER) {
      return NextResponse.json(
        {
          error: `Maksimal ${MAX_API_KEYS_PER_USER} token per akun. Hapus salah satu token lama terlebih dahulu.`,
        },
        { status: 400 }
      );
    }

    const fingerprint = hashApiKeyFingerprint(rawKey, user.id);
    const duplicate = entries.find((e) => e.fingerprint === fingerprint);
    if (duplicate) {
      return NextResponse.json(
        {
          error: `Token ini sudah terdaftar di akun kamu sebagai "${duplicate.label}" (${duplicate.maskedKey}).`,
        },
        { status: 400 }
      );
    }

    // Verifikasi cepat bahwa API Key aktif sebelum disimpan ke database
    try {
      const ai = new GoogleGenAI({ apiKey: rawKey });
      await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: 'ok',
        config: {
          maxOutputTokens: 1,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      });
    } catch (verifyErr) {
      const msg =
        verifyErr instanceof Error ? verifyErr.message : 'API Key ditolak oleh Gemini.';
      return NextResponse.json(
        { error: `Token gagal diverifikasi: ${msg}` },
        { status: 400 }
      );
    }

    const nextIndex = entries.length + 1;
    const newEntry: StoredApiKeyEntry = {
      id: `key_${crypto.randomBytes(6).toString('hex')}`,
      label:
        customLabel.slice(0, 40) ||
        (entries.length === 0 ? 'Token Utama #1' : `Token Cadangan #${nextIndex}`),
      encryptedKey: encryptSecret(rawKey),
      maskedKey: maskApiKey(rawKey),
      fingerprint,
      addedAt: new Date().toISOString(),
    };

    const nextEntries =
      body?.makePrimary || entries.length === 0
        ? [newEntry, ...entries]
        : [...entries, newEntry];

    const { encryptedPayload, summaryHint } = serializeStoredApiKeys(nextEntries);

    const { data: saved, error: saveErr } = await supabase
      .from('user_settings')
      .upsert(
        {
          user_id: user.id,
          encrypted_gemini_api_key: encryptedPayload,
          key_hint: summaryHint,
        },
        { onConflict: 'user_id' }
      )
      .select('updated_at')
      .single();

    if (saveErr) {
      return NextResponse.json({ error: saveErr.message }, { status: 500 });
    }

    clearGeminiCooldown(user.id, newEntry.id);

    return NextResponse.json(
      formatPublicKeysResponse(nextEntries, saved?.updated_at ?? null)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menyimpan API Key.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      id?: string;
      action?: 'set-primary' | 'rename' | 'reset-cooldown';
      label?: string;
    } | null;

    const targetId = body?.id?.trim();
    if (!targetId) {
      return NextResponse.json(
        { error: 'ID token wajib disertakan.' },
        { status: 400 }
      );
    }

    const { entries, updatedAt } = await loadUserStoredKeys(supabase, user.id);
    const targetIdx = entries.findIndex((e) => e.id === targetId);
    if (targetIdx === -1) {
      return NextResponse.json(
        { error: 'Token tidak ditemukan di akun kamu.' },
        { status: 404 }
      );
    }

    if (body?.action === 'reset-cooldown') {
      clearGeminiCooldown(user.id, targetId);
      return NextResponse.json(formatPublicKeysResponse(entries, updatedAt));
    }

    let nextEntries = [...entries];

    if (body?.action === 'set-primary') {
      const [picked] = nextEntries.splice(targetIdx, 1);
      nextEntries = [picked, ...nextEntries];
      clearGeminiCooldown(user.id, picked.id);
    } else if (body?.action === 'rename' && body.label?.trim()) {
      nextEntries[targetIdx] = {
        ...nextEntries[targetIdx],
        label: body.label.trim().slice(0, 40),
      };
    }

    const { encryptedPayload, summaryHint } = serializeStoredApiKeys(nextEntries);

    const { data: saved, error: saveErr } = await supabase
      .from('user_settings')
      .upsert(
        {
          user_id: user.id,
          encrypted_gemini_api_key: encryptedPayload,
          key_hint: summaryHint,
        },
        { onConflict: 'user_id' }
      )
      .select('updated_at')
      .single();

    if (saveErr) {
      return NextResponse.json({ error: saveErr.message }, { status: 500 });
    }

    return NextResponse.json(
      formatPublicKeysResponse(nextEntries, saved?.updated_at ?? null)
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Gagal memperbarui urutan token.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const idFromQuery = url.searchParams.get('id')?.trim();
    const body = (await request.json().catch(() => null)) as { id?: string } | null;
    const targetId = idFromQuery || body?.id?.trim() || '';

    const { entries } = await loadUserStoredKeys(supabase, user.id);

    const nextEntries = targetId
      ? entries.filter((e) => e.id !== targetId)
      : [];

    const { encryptedPayload, summaryHint } = serializeStoredApiKeys(nextEntries);

    const { data: saved, error } = await supabase
      .from('user_settings')
      .upsert(
        {
          user_id: user.id,
          encrypted_gemini_api_key: encryptedPayload,
          key_hint: summaryHint,
        },
        { onConflict: 'user_id' }
      )
      .select('updated_at')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      formatPublicKeysResponse(nextEntries, saved?.updated_at ?? null)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menghapus API Key.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
