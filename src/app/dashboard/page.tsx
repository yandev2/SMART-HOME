import { redirect } from 'next/navigation';
import DashboardClient from '@/components/DashboardClient';
import { DEFAULT_ASSISTANT_PROFILE } from '@/lib/constants';
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
    { data: messages },
    settingsRes,
  ] = await Promise.all([
    supabase.from('rooms').select('*').eq('user_id', user.id).order('name'),
    supabase.from('controllers').select('*').eq('user_id', user.id).order('name'),
    supabase.from('devices').select('*').eq('user_id', user.id).order('name'),
    supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('user_settings')
      .select(
        'key_hint, assistant_name, assistant_gender, assistant_styles, assistant_description'
      )
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  let keyHint: string | null = settingsRes.data?.key_hint ?? null;

  // Fallback jika kolom profil asisten belum ditambahkan via ALTER TABLE
  if (settingsRes.error) {
    const fallbackRes = await supabase
      .from('user_settings')
      .select('key_hint')
      .eq('user_id', user.id)
      .maybeSingle();
    keyHint = fallbackRes.data?.key_hint ?? null;
  }

  const assistantProfile: AssistantProfile = settingsRes.data
    ? {
        name:
          settingsRes.data.assistant_name?.trim() || DEFAULT_ASSISTANT_PROFILE.name,
        gender:
          settingsRes.data.assistant_gender === 'perempuan'
            ? 'perempuan'
            : 'laki-laki',
        styles:
          Array.isArray(settingsRes.data.assistant_styles) &&
          settingsRes.data.assistant_styles.length > 0
            ? settingsRes.data.assistant_styles
            : DEFAULT_ASSISTANT_PROFILE.styles,
        description: settingsRes.data.assistant_description ?? '',
      }
    : DEFAULT_ASSISTANT_PROFILE;

  return (
    <DashboardClient
      userId={user.id}
      userEmail={user.email ?? 'Pengguna'}
      initialRooms={rooms ?? []}
      initialControllers={controllers ?? []}
      initialDevices={devices ?? []}
      initialMessages={(messages ?? []).reverse()}
      initialHasApiKey={Boolean(keyHint)}
      initialMaskedApiKey={keyHint}
      initialAssistantProfile={assistantProfile}
    />
  );
}
