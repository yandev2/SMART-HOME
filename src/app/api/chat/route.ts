import { NextResponse } from 'next/server';
import { DEFAULT_ASSISTANT_PROFILE } from '@/lib/constants';
import { decryptSecret } from '@/lib/crypto';
import { streamSmartHomeAssistant } from '@/lib/gemini';
import { createClient } from '@/lib/supabase/server';
import type { AssistantProfile } from '@/lib/types';

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ messages: (messages ?? []).reverse() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
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

    await supabase.from('chat_messages').delete().eq('user_id', user.id);

    return NextResponse.json({ ok: true });
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
      return NextResponse.json({ error: 'Silakan login terlebih dahulu.' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as { message?: string } | null;
    const messageText = body?.message?.trim();

    if (!messageText) {
      return NextResponse.json({ error: 'Pesan tidak boleh kosong.' }, { status: 400 });
    }

    // Ambil konteks perangkat, API key user, dan 10 riwayat terakhir secara paralel
    const [
      { data: rooms, error: roomsErr },
      { data: controllers, error: ctrlErr },
      { data: devices, error: devErr },
      settingsRes,
      { data: recentMessages },
    ] = await Promise.all([
      supabase.from('rooms').select('*').eq('user_id', user.id).order('name'),
      supabase
        .from('controllers')
        .select('id, user_id, name, last_seen, created_at')
        .eq('user_id', user.id)
        .order('name'),
      supabase.from('devices').select('*').eq('user_id', user.id).order('name'),
      supabase
        .from('user_settings')
        .select(
          'encrypted_gemini_api_key, assistant_name, assistant_gender, assistant_styles, assistant_description'
        )
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase
        .from('chat_messages')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    let settingsData = settingsRes.data as {
      encrypted_gemini_api_key?: string | null;
      assistant_name?: string | null;
      assistant_gender?: string | null;
      assistant_styles?: string[] | null;
      assistant_description?: string | null;
    } | null;

    if (settingsRes.error) {
      const fallbackSettings = await supabase
        .from('user_settings')
        .select('encrypted_gemini_api_key')
        .eq('user_id', user.id)
        .maybeSingle();

      if (fallbackSettings.error) {
        return NextResponse.json(
          {
            error:
              'Tabel user_settings belum tersedia. Jalankan supabase/schema.sql di Supabase SQL Editor.',
          },
          { status: 500 }
        );
      }
      settingsData = fallbackSettings.data;
    }

    if (!settingsData?.encrypted_gemini_api_key) {
      return NextResponse.json(
        {
          error:
            'API Key Gemini kamu belum diatur. Buka tab "Pengaturan" untuk menambahkan Gemini API Key kamu.',
        },
        { status: 400 }
      );
    }

    if (roomsErr || ctrlErr || devErr) {
      return NextResponse.json(
        { error: 'Gagal memuat data perangkat dari Supabase.' },
        { status: 500 }
      );
    }

    const userGeminiApiKey = decryptSecret(settingsData.encrypted_gemini_api_key);
    const assistantProfile: AssistantProfile = {
      name: settingsData.assistant_name?.trim() || DEFAULT_ASSISTANT_PROFILE.name,
      gender: settingsData.assistant_gender === 'perempuan' ? 'perempuan' : 'laki-laki',
      styles:
        Array.isArray(settingsData.assistant_styles) &&
        settingsData.assistant_styles.length > 0
          ? settingsData.assistant_styles
          : DEFAULT_ASSISTANT_PROFILE.styles,
      description: settingsData.assistant_description ?? '',
    };
    const history = (recentMessages ?? []).reverse();

    // Simpan pesan user secara paralel dengan pemanggilan Gemini
    const userInsertPromise = supabase
      .from('chat_messages')
      .insert({
        user_id: user.id,
        role: 'user',
        content: messageText,
        actions: [],
      })
      .select('*')
      .single();

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          const aiResult = await streamSmartHomeAssistant({
            apiKey: userGeminiApiKey,
            assistantProfile,
            userId: user.id,
            message: messageText,
            history,
            supabase,
            rooms: rooms ?? [],
            controllers: controllers ?? [],
            devices: devices ?? [],
            onStatus: (text) => sendEvent({ type: 'status', text }),
            onActions: (actions) => sendEvent({ type: 'actions', actions }),
            onTextDelta: (text) => sendEvent({ type: 'delta', text }),
          });

          const [{ data: userMsg, error: userErr }, { data: assistantMsg, error: asstErr }] =
            await Promise.all([
              userInsertPromise,
              supabase
                .from('chat_messages')
                .insert({
                  user_id: user.id,
                  role: 'assistant',
                  content: aiResult.reply,
                  actions: aiResult.actions,
                })
                .select('*')
                .single(),
            ]);

          if (userErr || asstErr) {
            console.error('Gagal menyimpan riwayat chat:', userErr || asstErr);
          }

          sendEvent({
            type: 'done',
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            reply: aiResult.reply,
            actions: aiResult.actions,
          });
        } catch (err) {
          console.error('Chat Stream Error:', err);
          const msg =
            err instanceof Error
              ? err.message
              : 'Terjadi kesalahan saat menghubungi asisten AI.';
          sendEvent({ type: 'error', error: msg });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('Chat API Error:', err);
    const message =
      err instanceof Error ? err.message : 'Terjadi kesalahan saat menghubungi asisten AI.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
