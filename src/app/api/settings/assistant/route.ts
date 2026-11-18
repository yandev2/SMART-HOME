import { NextResponse } from 'next/server';
import { DEFAULT_ASSISTANT_PROFILE } from '@/lib/constants';
import { createClient } from '@/lib/supabase/server';
import type { AssistantGender, AssistantProfile } from '@/lib/types';

function normalizeProfile(row: {
  assistant_name?: string | null;
  assistant_gender?: string | null;
  assistant_styles?: string[] | null;
  assistant_description?: string | null;
} | null): AssistantProfile {
  if (!row) return DEFAULT_ASSISTANT_PROFILE;

  const gender: AssistantGender =
    row.assistant_gender === 'perempuan' ? 'perempuan' : 'laki-laki';

  return {
    name: row.assistant_name?.trim() || DEFAULT_ASSISTANT_PROFILE.name,
    gender,
    styles:
      Array.isArray(row.assistant_styles) && row.assistant_styles.length > 0
        ? row.assistant_styles
        : DEFAULT_ASSISTANT_PROFILE.styles,
    description: row.assistant_description ?? '',
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
        'assistant_name, assistant_gender, assistant_styles, assistant_description'
      )
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
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

    const { data, error } = await supabase
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

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ profile: normalizeProfile(data) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menyimpan profil asisten.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

