import { NextResponse } from 'next/server';
import { DEFAULT_ASSISTANT_PROFILE } from '@/lib/constants';
import { decryptStoredApiKeys } from '@/lib/crypto';
import {
  type AssistantRunResult,
  streamSmartHomeAssistant,
  streamSmartHomeLiveAssistant,
} from '@/lib/gemini';
import {
  GEMINI_FREE_TIER_LIMITS,
  archiveDeletedChatQuota,
  classifyGeminiFailoverError,
  getPacificQuotaWindow,
  recordGeminiRequest,
  recordKeyRateLimit,
  selectOrderedCandidateKeys,
} from '@/lib/quota';
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

    // Arsipkan jumlah request hari ini sebelum menghapus riwayat agar penghitung kuota harian tetap akurat
    const { dayStartIso } = getPacificQuotaWindow();
    const { count: todayCount } = await supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('role', 'assistant')
      .gte('created_at', dayStartIso);

    if (todayCount && todayCount > 0) {
      archiveDeletedChatQuota(
        user.id,
        todayCount,
        todayCount * GEMINI_FREE_TIER_LIMITS.ESTIMATED_TOKENS_PER_CHAT
      );
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

    const body = (await request.json().catch(() => null)) as {
      message?: string;
      voiceMode?: boolean;
      engine?: string;
      geminiVoice?: string;
    } | null;
    const messageText = body?.message?.trim();
    const useLiveNativeAudio =
      Boolean(body?.voiceMode) && body?.engine !== 'edge-tts';

    if (!messageText) {
      return NextResponse.json({ error: 'Pesan tidak boleh kosong.' }, { status: 400 });
    }

    // Ambil konteks perangkat, preset, API key user, dan 10 riwayat terakhir secara paralel
    const [
      { data: rooms, error: roomsErr },
      { data: controllers, error: ctrlErr },
      { data: devices, error: devErr },
      presetsRes,
      wledRes,
      wledPresetsRes,
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
      supabase.from('presets').select('*').eq('user_id', user.id).order('name'),
      supabase.from('wled_devices').select('*').eq('user_id', user.id).order('name'),
      supabase.from('wled_presets').select('*').eq('user_id', user.id).order('name'),
      supabase
        .from('user_settings')
        .select(
          'encrypted_gemini_api_key, key_hint, assistant_name, assistant_gender, assistant_styles, assistant_description'
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

    const presets = presetsRes.error ? [] : presetsRes.data ?? [];
    const wledDevices = wledRes.error ? [] : wledRes.data ?? [];
    const wledPresets = wledPresetsRes.error ? [] : wledPresetsRes.data ?? [];

    let settingsData = settingsRes.data as {
      encrypted_gemini_api_key?: string | null;
      key_hint?: string | null;
      assistant_name?: string | null;
      assistant_gender?: string | null;
      assistant_styles?: string[] | null;
      assistant_description?: string | null;
    } | null;

    if (settingsRes.error) {
      const fallbackSettings = await supabase
        .from('user_settings')
        .select('encrypted_gemini_api_key, key_hint')
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

    // Dekripsi seluruh pool token milik user yang sedang login (100% terisolasi per user.id)
    const userApiKeys = decryptStoredApiKeys(
      settingsData?.encrypted_gemini_api_key,
      settingsData?.key_hint,
      user.id
    );

    if (userApiKeys.length === 0) {
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

    const candidateKeys = selectOrderedCandidateKeys(user.id, userApiKeys);
    const assistantProfile: AssistantProfile = {
      name: settingsData?.assistant_name?.trim() || DEFAULT_ASSISTANT_PROFILE.name,
      gender: settingsData?.assistant_gender === 'perempuan' ? 'perempuan' : 'laki-laki',
      styles:
        Array.isArray(settingsData?.assistant_styles) &&
        settingsData.assistant_styles.length > 0
          ? settingsData.assistant_styles
          : DEFAULT_ASSISTANT_PROFILE.styles,
      description: settingsData?.assistant_description ?? '',
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
          let aiResult: AssistantRunResult | null = null;
          let usedKey = candidateKeys[0];
          let lastError: unknown = null;

          // Loop Auto-Failover Multi-Token: jika Token A kena limit/gangguan, langsung switch ke Token B -> C dst.
          for (let idx = 0; idx < candidateKeys.length; idx++) {
            const currentKey = candidateKeys[idx];
            usedKey = currentKey;
            let emittedOutputOnThisKey = false;

            try {
              if (useLiveNativeAudio) {
                try {
                  aiResult = await streamSmartHomeLiveAssistant({
                    apiKey: currentKey.apiKey,
                    assistantProfile,
                    geminiVoice: body?.geminiVoice,
                    userId: user.id,
                    message: messageText,
                    history,
                    supabase,
                    rooms: rooms ?? [],
                    controllers: controllers ?? [],
                    devices: devices ?? [],
                    presets,
                    wledDevices,
                    wledPresets,
                    onStatus: (text) => sendEvent({ type: 'status', text }),
                    onActions: (actions) => {
                      emittedOutputOnThisKey = true;
                      sendEvent({ type: 'actions', actions });
                    },
                    onTextDelta: (text) => {
                      emittedOutputOnThisKey = true;
                      sendEvent({ type: 'delta', text });
                    },
                    onAudioChunk: (base64Pcm, sampleRate) => {
                      emittedOutputOnThisKey = true;
                      sendEvent({ type: 'audio', data: base64Pcm, sampleRate });
                    },
                  });
                } catch (liveErr) {
                  // Jika Live gagal karena limit/kuota dan masih ada token cadangan, lempar ke outer catch agar langsung switch ke token berikutnya!
                  const classification = classifyGeminiFailoverError(liveErr);
                  if (
                    !emittedOutputOnThisKey &&
                    classification.shouldFailover &&
                    idx + 1 < candidateKeys.length
                  ) {
                    throw liveErr;
                  }

                  console.warn(
                    `Gemini 3.8 Live gagal pada ${currentKey.label}, fallback ke mode teks:`,
                    liveErr instanceof Error ? liveErr.message : liveErr
                  );
                  aiResult = await streamSmartHomeAssistant({
                    apiKey: currentKey.apiKey,
                    assistantProfile,
                    userId: user.id,
                    message: messageText,
                    history,
                    supabase,
                    rooms: rooms ?? [],
                    controllers: controllers ?? [],
                    devices: devices ?? [],
                    presets,
                    wledDevices,
                    wledPresets,
                    onStatus: (text) => sendEvent({ type: 'status', text }),
                    onActions: (actions) => {
                      emittedOutputOnThisKey = true;
                      sendEvent({ type: 'actions', actions });
                    },
                    onTextDelta: (text) => {
                      emittedOutputOnThisKey = true;
                      sendEvent({ type: 'delta', text });
                    },
                  });
                }
              } else {
                aiResult = await streamSmartHomeAssistant({
                  apiKey: currentKey.apiKey,
                  assistantProfile,
                  userId: user.id,
                  message: messageText,
                  history,
                  supabase,
                  rooms: rooms ?? [],
                  controllers: controllers ?? [],
                  devices: devices ?? [],
                  presets,
                  wledDevices,
                  wledPresets,
                  onStatus: (text) => sendEvent({ type: 'status', text }),
                  onActions: (actions) => {
                    emittedOutputOnThisKey = true;
                    sendEvent({ type: 'actions', actions });
                  },
                  onTextDelta: (text) => {
                    emittedOutputOnThisKey = true;
                    sendEvent({ type: 'delta', text });
                  },
                });
              }

              // Berhasil pada currentKey -> hentikan loop failover
              break;
            } catch (attemptErr) {
              lastError = attemptErr;
              const classification = classifyGeminiFailoverError(attemptErr);

              if (classification.shouldFailover) {
                recordKeyRateLimit(user.id, currentKey.id, {
                  isDailyExhausted: classification.isDailyExhausted,
                  cooldownMs: 60_000,
                  errorMessage: classification.reason,
                });
              }

              const hasNextToken = idx + 1 < candidateKeys.length;
              if (!emittedOutputOnThisKey && hasNextToken) {
                const nextKey = candidateKeys[idx + 1];
                console.warn(
                  `[Auto-Failover User ${user.id}] ${currentKey.label} gagal (${classification.reason}), beralih ke ${nextKey.label}...`
                );
                sendEvent({
                  type: 'status',
                  text: `Beralih otomatis ke ${nextKey.label}...`,
                });
                continue;
              }

              throw attemptErr;
            }
          }

          if (!aiResult) {
            throw (
              lastError ??
              new Error('Semua token Gemini sedang mencapai batas kuota.')
            );
          }

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

          recordGeminiRequest(
            user.id,
            useLiveNativeAudio ? 'live-voice' : 'chat-text',
            1800 + Math.ceil((aiResult.reply?.length ?? 0) / 4),
            true,
            usedKey.id
          );

          sendEvent({
            type: 'done',
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            reply: aiResult.reply,
            actions: aiResult.actions,
            tokenUsed: {
              id: usedKey.id,
              label: usedKey.label,
              maskedKey: usedKey.maskedKey,
            },
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
