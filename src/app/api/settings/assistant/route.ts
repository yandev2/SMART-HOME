import { NextResponse } from 'next/server';
import {
  DEFAULT_ASSISTANT_PROFILE,
  sanitizeCustomAvatar,
} from '@/lib/constants';
import { createClient } from '@/lib/supabase/server';
import type { AssistantGender, AssistantProfile, AvatarMode } from '@/lib/types';

function normalizeProfile(
  row: {
    assistant_name?: string | null;
    assistant_gender?: string | null;
    assistant_styles?: string[] | null;
    assistant_description?: string | null;
    avatar_mode?: string | null;
    custom_avatar_data?: unknown;
  } | null
): AssistantProfile {
  if (!row) return DEFAULT_ASSISTANT_PROFILE;

  const gender: AssistantGender =
    row.assistant_gender === 'perempuan' ? 'perempuan' : 'laki-laki';
  const customAvatar = sanitizeCustomAvatar(row.custom_avatar_data);
  const avatarMode: AvatarMode =
    row.avatar_mode === 'custom' && customAvatar ? 'custom' : 'default';

  return {
    name: row.assistant_name?.trim() || DEFAULT_ASSISTANT_PROFILE.name,
    gender,
    styles:
      Array.isArray(row.assistant_styles) && row.assistant_styles.length > 0
        ? row.assistant_styles
        : DEFAULT_ASSISTANT_PROFILE.styles,
    description: row.assistant_description ?? '',
    avatarMode,
    customAvatar,
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

    const { data, error } = await supabase
      .from('user_settings')
      .select(
        'assistant_name, assistant_gender, assistant_styles, assistant_description, avatar_mode, custom_avatar_data'
      )
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      // Fallback jika kolom avatar baru belum dijalankan di SQL Editor
      const fallback = await supabase
        .from('user_settings')
        .select(
          'assistant_name, assistant_gender, assistant_styles, assistant_description'
        )
        .eq('user_id', user.id)
        .maybeSingle();
      if (fallback.error) {
        return NextResponse.json({ error: fallback.error.message }, { status: 500 });
      }
      return NextResponse.json({ profile: normalizeProfile(fallback.data) });
    }

    return NextResponse.json({ profile: normalizeProfile(data) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as Partial<AssistantProfile> | null;
    const name = body?.name?.trim() ?? '';
    const gender: AssistantGender =
      body?.gender === 'perempuan' ? 'perempuan' : 'laki-laki';
    const styles = Array.isArray(body?.styles)
      ? body.styles
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean)
          .slice(0, 10)
      : [];
    const description = (body?.description ?? '').trim().slice(0, 500);

    if (!name || name.length > 40) {
      return NextResponse.json(
        { error: 'Nama asisten wajib diisi (maksimal 40 karakter).' },
        { status: 400 }
      );
    }

    if (styles.length === 0) {
      return NextResponse.json(
        { error: 'Pilih minimal 1 gaya bicara asisten.' },
        { status: 400 }
      );
    }

    const hasAvatarUpdate = body?.avatarMode !== undefined || body?.customAvatar !== undefined;
    const upsertPayload: Record<string, unknown> = {
      user_id: user.id,
      assistant_name: name,
      assistant_gender: gender,
      assistant_styles: styles,
      assistant_description: description,
    };

    if (hasAvatarUpdate) {
      const sanitizedAvatar =
        body?.customAvatar !== undefined
          ? sanitizeCustomAvatar(body.customAvatar)
          : undefined;
      const requestedMode: AvatarMode =
        body?.avatarMode === 'custom' ? 'custom' : 'default';

      if (requestedMode === 'custom' && sanitizedAvatar === null) {
        return NextResponse.json(
          { error: 'Data gambar custom avatar tidak valid atau terlalu besar.' },
          { status: 400 }
        );
      }

      upsertPayload.avatar_mode = requestedMode;
      if (sanitizedAvatar !== undefined) {
        upsertPayload.custom_avatar_data = sanitizedAvatar;
      }
    }

    const { data, error } = await supabase
      .from('user_settings')
      .upsert(upsertPayload, { onConflict: 'user_id' })
      .select(
        'assistant_name, assistant_gender, assistant_styles, assistant_description, avatar_mode, custom_avatar_data'
      )
      .single();

    if (error) {
      if (!hasAvatarUpdate) {
        const fallbackUpsert = await supabase
          .from('user_settings')
          .upsert(
            {
              user_id: user.id,
              assistant_name: name,
              assistant_gender: gender,
              assistant_styles: styles,
              assistant_description: description,
            },
            { onConflict: 'user_id' }
          )
          .select(
            'assistant_name, assistant_gender, assistant_styles, assistant_description'
          )
          .single();

        if (!fallbackUpsert.error) {
          return NextResponse.json({ profile: normalizeProfile(fallbackUpsert.data) });
        }
      }

      return NextResponse.json(
        {
          error: hasAvatarUpdate
            ? `Gagal menyimpan custom avatar (${error.message}). Pastikan SQL terbaru di supabase/schema.sql sudah dijalankan di Supabase.`
            : error.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ profile: normalizeProfile(data) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menyimpan profil asisten.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
