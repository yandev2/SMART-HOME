import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { NextResponse } from 'next/server';
import { encryptSecret, maskApiKey } from '@/lib/crypto';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('user_settings')
      .select('key_hint, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      hasKey: Boolean(data?.key_hint),
      maskedKey: data?.key_hint ?? null,
      updatedAt: data?.updated_at ?? null,
    });
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

    const body = (await request.json().catch(() => null)) as { apiKey?: string } | null;
    const rawKey = body?.apiKey?.trim() ?? '';

    if (!rawKey || rawKey.length < 20 || /\s/.test(rawKey)) {
      return NextResponse.json(
        { error: 'Format API Key Gemini tidak valid.' },
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
        { error: `API Key gagal diverifikasi: ${msg}` },
        { status: 400 }
      );
    }

    const encrypted = encryptSecret(rawKey);
    const keyHint = maskApiKey(rawKey);

    const { data: saved, error: saveErr } = await supabase
      .from('user_settings')
      .upsert(
        {
          user_id: user.id,
          encrypted_gemini_api_key: encrypted,
          key_hint: keyHint,
        },
        { onConflict: 'user_id' }
      )
      .select('key_hint, updated_at')
      .single();

    if (saveErr) {
      return NextResponse.json({ error: saveErr.message }, { status: 500 });
    }

    return NextResponse.json({
      hasKey: true,
      maskedKey: saved.key_hint,
      updatedAt: saved.updated_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menyimpan API Key.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { error } = await supabase
      .from('user_settings')
      .upsert(
        {
          user_id: user.id,
          encrypted_gemini_api_key: null,
          key_hint: null,
        },
        { onConflict: 'user_id' }
      );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ hasKey: false, maskedKey: null, updatedAt: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menghapus API Key.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

