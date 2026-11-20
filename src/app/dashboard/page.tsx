import { redirect } from 'next/navigation';
import DashboardClient from '@/components/DashboardClient';
import {
  DEFAULT_ASSISTANT_PROFILE,
  sanitizeCustomAvatar,
} from '@/lib/constants';
import { createClient } from '@/lib/supabase/server';
import type { AssistantProfile } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const hasEnv =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!hasEnv) {
    redirect('/login');
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const [
    { data: rooms },
    { data: controllers },
    { data: devices },
    presetsRes,
    { data: messages },
    settingsRes,
  ] = await Promise.all([
    supabase.from('rooms').select('*').eq('user_id', user.id).order('name'),
    supabase.from('controllers').select('*').eq('user_id', user.id).order('name'),
    supabase.from('devices').select('*').eq('user_id', user.id).order('name'),
    supabase.from('presets').select('*').eq('user_id', user.id).order('name'),
    supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('user_settings')
      .select(
        'key_hint, assistant_name, assistant_gender, assistant_styles, assistant_description, avatar_mode, custom_avatar_data'
      )
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  const initialPresets = presetsRes.error ? [] : presetsRes.data ?? [];
  const initialPresetsTableReady = !presetsRes.error;

  let settingsRow: {
    key_hint?: string | null;
    assistant_name?: string | null;
    assistant_gender?: string | null;
    assistant_styles?: string[] | null;
    assistant_description?: string | null;
    avatar_mode?: string | null;
    custom_avatar_data?: unknown;
  } | null = settingsRes.data;

  // Fallback bertahap jika kolom avatar atau profil asisten belum ditambahkan via ALTER TABLE
  if (settingsRes.error) {
    const midFallback = await supabase
      .from('user_settings')
      .select(
        'key_hint, assistant_name, assistant_gender, assistant_styles, assistant_description'
      )
      .eq('user_id', user.id)
      .maybeSingle();

    if (!midFallback.error) {
      settingsRow = midFallback.data;
    } else {
      const minFallback = await supabase
        .from('user_settings')
        .select('key_hint')
        .eq('user_id', user.id)
        .maybeSingle();
      settingsRow = minFallback.data;
    }
  }

  const keyHint: string | null = settingsRow?.key_hint ?? null;
  const parsedCustomAvatar = sanitizeCustomAvatar(settingsRow?.custom_avatar_data);

  const assistantProfile: AssistantProfile = settingsRow
    ? {
        name:
          settingsRow.assistant_name?.trim() || DEFAULT_ASSISTANT_PROFILE.name,
        gender:
          settingsRow.assistant_gender === 'perempuan'
            ? 'perempuan'
            : 'laki-laki',
        styles:
          Array.isArray(settingsRow.assistant_styles) &&
          settingsRow.assistant_styles.length > 0
            ? settingsRow.assistant_styles
            : DEFAULT_ASSISTANT_PROFILE.styles,
        description: settingsRow.assistant_description ?? '',
        avatarMode:
          settingsRow.avatar_mode === 'custom' && parsedCustomAvatar
            ? 'custom'
            : 'default',
        customAvatar: parsedCustomAvatar,
      }
    : DEFAULT_ASSISTANT_PROFILE;

  return (
    <DashboardClient
      userId={user.id}
      userEmail={user.email ?? 'Pengguna'}
      initialRooms={rooms ?? []}
      initialControllers={controllers ?? []}
      initialDevices={devices ?? []}
      initialPresets={initialPresets}
      initialPresetsTableReady={initialPresetsTableReady}
      initialMessages={(messages ?? []).reverse()}
      initialHasApiKey={Boolean(keyHint)}
      initialMaskedApiKey={keyHint}
      initialAssistantProfile={assistantProfile}
    />
  );
}
