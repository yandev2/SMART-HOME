import { GoogleGenAI } from '@google/genai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { NextResponse } from 'next/server';
import {
  GEMINI_VOICE_OPTIONS,
  VOICE_OPTIONS,
  getDefaultVoiceSettings,
} from '@/lib/constants';
import { decryptStoredApiKeys } from '@/lib/crypto';
import {
  classifyGeminiFailoverError,
  clearGeminiCooldown,
  recordGeminiRequest,
  recordKeyRateLimit,
  selectOrderedCandidateKeys,
} from '@/lib/quota';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const ALLOWED_EDGE_VOICES = new Set(VOICE_OPTIONS.map((v) => v.id));
const ALLOWED_GEMINI_VOICES = new Set(GEMINI_VOICE_OPTIONS.map((v) => v.id));

const globalForTts = globalThis as unknown as {
  __edgeTtsPool?: Map<string, MsEdgeTTS>;
  __geminiTtsCooldownUntil?: Map<string, number>;
};

const GEMINI_COOLDOWN_MS = 60 * 1000; // 1 menit cooldown bila terkena rate limit RPM Free Tier

function getPool(): Map<string, MsEdgeTTS> {
  if (!globalForTts.__edgeTtsPool) {
    globalForTts.__edgeTtsPool = new Map();
  }
  return globalForTts.__edgeTtsPool;
}

function getGeminiCooldownMap(): Map<string, number> {
  if (!globalForTts.__geminiTtsCooldownUntil) {
    globalForTts.__geminiTtsCooldownUntil = new Map();
  }
  return globalForTts.__geminiTtsCooldownUntil;
}

async function getWarmTts(voice: string): Promise<MsEdgeTTS> {
  const pool = getPool();
  let instance = pool.get(voice);

  if (!instance) {
    instance = new MsEdgeTTS({
      connectionTimeoutMs: 5000,
      synthesisTimeoutMs: 12000,
    });
    pool.set(voice, instance);
  }

  await instance.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  return instance;
}

function resetTts(voice: string) {
  const pool = getPool();
  const instance = pool.get(voice);
  if (instance) {
    try {
      instance.close();
    } catch {
      // Abaikan error saat menutup socket lama
    }
    pool.delete(voice);
  }
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/`+/g, '')
    .replace(/[*_~#>]+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/\.\.\./g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function clampPercent(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, num));
}

function formatPercent(num: number): string {
  return `${num >= 0 ? '+' : ''}${num}%`;
}

function buildGeminiSpeechStyle(
  pitch: number,
  rate: number,
  styles: string[] | null | undefined
): string {
  const descriptors = ['natural Indonesian conversational accent'];

  if (pitch >= 10) {
    descriptors.push('youthful, bright, and light vocal tone');
  } else if (pitch <= 0) {
    descriptors.push('warm, soft, and intimate vocal tone');
  } else {
    descriptors.push('warm and friendly vocal tone');
  }

  if (rate <= -4) {
    descriptors.push('calm, relaxed, unhurried pace');
  } else if (rate >= 8) {
    descriptors.push('lively, upbeat pace');
  }

  if (Array.isArray(styles) && styles.length > 0) {
    descriptors.push(`personality: ${styles.join(', ')}`);
  }

  return descriptors.join(', ');
}

async function synthesizeEdgeMp3(
  voice: string,
  cleanedText: string,
  prosody: { rate: string; pitch: string }
): Promise<Buffer> {
  const escaped = escapeXml(cleanedText);
  const runOnce = async () => {
    const tts = await getWarmTts(voice);
    const { audioStream } = tts.toStream(escaped, prosody);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      audioStream.on('end', () => resolve());
      audioStream.on('close', () => resolve());
      audioStream.on('error', (err: Error) => reject(err));
    });
    const audioBuffer = Buffer.concat(chunks);
    if (audioBuffer.length === 0) {
      throw new Error('Edge TTS mengembalikan audio kosong.');
    }
    return audioBuffer;
  };

  try {
    return await runOnce();
  } catch {
    resetTts(voice);
    return await runOnce();
  }
}

async function synthesizeGeminiWav(params: {
  apiKey: string;
  voice: string;
  cleanedText: string;
  style: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey, apiVersion: 'v1beta' });
  const interaction = await ai.interactions.create(
    {
      model: 'gemini-3.8-flash-lite-tts',
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: params.cleanedText,
              annotations: [
                {
                  type: 'speech_metadata',
                  style: params.style,
                },
              ],
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: params.voice }],
      },
    },
    {
      timeout_ms: 15000,
      retries: { strategy: 'none' },
    }
  );

  const audio = interaction.output_audio;
  if (!audio?.data) {
    throw new Error('Gemini TTS tidak mengembalikan data audio.');
  }

  return {
    buffer: Buffer.from(audio.data, 'base64'),
    mimeType: audio.mime_type || 'audio/wav',
  };
}

export async function POST(request: Request) {
  let edgeVoice = 'id-ID-ArdiNeural';

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as {
      text?: string;
      gender?: string;
      engine?: string;
      voiceId?: string;
      geminiVoice?: string;
      pitch?: number;
      rate?: number;
    } | null;

    const cleaned = cleanTextForSpeech(body?.text ?? '');
    if (!cleaned) {
      return NextResponse.json(
        { error: 'Teks untuk dibacakan kosong.' },
        { status: 400 }
      );
    }

    const gender = body?.gender === 'perempuan' ? 'perempuan' : 'laki-laki';
    const defaults = getDefaultVoiceSettings(gender);

    edgeVoice =
      body?.voiceId && ALLOWED_EDGE_VOICES.has(body.voiceId)
        ? body.voiceId
        : defaults.voiceId;

    const geminiVoice =
      body?.geminiVoice && ALLOWED_GEMINI_VOICES.has(body.geminiVoice)
        ? body.geminiVoice
        : defaults.geminiVoice;

    const pitchNum = clampPercent(body?.pitch, defaults.pitch, -20, 30);
    const rateNum = clampPercent(body?.rate, defaults.rate, -25, 30);

    let geminiFallbackReason = '';

    // Jika user memilih Gemini 3.8 TTS, gunakan pool token milik user dengan Auto-Failover (Token A -> Token B -> dst.)
    if (body?.engine === 'gemini-tts') {
      try {
        const settingsRes = await supabase
          .from('user_settings')
          .select('encrypted_gemini_api_key, key_hint, assistant_styles')
          .eq('user_id', user.id)
          .maybeSingle();

        let encryptedKey = settingsRes.data?.encrypted_gemini_api_key ?? null;
        let keyHint = settingsRes.data?.key_hint ?? null;
        const assistantStyles = settingsRes.data?.assistant_styles ?? null;

        if (settingsRes.error) {
          const fallbackRes = await supabase
            .from('user_settings')
            .select('encrypted_gemini_api_key, key_hint')
            .eq('user_id', user.id)
            .maybeSingle();
          encryptedKey = fallbackRes.data?.encrypted_gemini_api_key ?? null;
          keyHint = fallbackRes.data?.key_hint ?? null;
        }

        const userApiKeys = decryptStoredApiKeys(encryptedKey, keyHint, user.id);

        if (userApiKeys.length > 0) {
          const candidateKeys = selectOrderedCandidateKeys(user.id, userApiKeys);
          const style = buildGeminiSpeechStyle(pitchNum, rateNum, assistantStyles);

          for (let idx = 0; idx < candidateKeys.length; idx++) {
            const currentKey = candidateKeys[idx];
            try {
              const { buffer, mimeType } = await synthesizeGeminiWav({
                apiKey: currentKey.apiKey,
                voice: geminiVoice,
                cleanedText: cleaned,
                style,
              });

              clearGeminiCooldown(user.id, currentKey.id);
              recordGeminiRequest(user.id, 'tts-preview', 450, false, currentKey.id);

              return new NextResponse(new Uint8Array(buffer), {
                status: 200,
                headers: {
                  'Content-Type': mimeType,
                  'Content-Length': String(buffer.length),
                  'Cache-Control': 'no-store',
                  'X-TTS-Engine': 'gemini-tts',
                  'X-TTS-Token-Label': encodeURIComponent(currentKey.label),
                },
              });
            } catch (keyErr) {
              const classification = classifyGeminiFailoverError(keyErr);
              if (classification.shouldFailover) {
                recordKeyRateLimit(user.id, currentKey.id, {
                  isDailyExhausted: classification.isDailyExhausted,
                  cooldownMs: GEMINI_COOLDOWN_MS,
                  errorMessage: classification.reason,
                });
                geminiFallbackReason = 'quota-exceeded';
              } else {
                geminiFallbackReason = 'gemini-error';
              }

              if (idx + 1 < candidateKeys.length) {
                console.warn(
                  `[TTS Auto-Failover User ${user.id}] ${currentKey.label} gagal, mencoba ${candidateKeys[idx + 1].label}...`
                );
                continue;
              }

              console.warn(
                'Semua token Gemini TTS gagal, otomatis fallback ke Edge Neural:',
                keyErr instanceof Error ? keyErr.message : String(keyErr)
              );
            }
          }
        } else {
          geminiFallbackReason = 'no-api-key';
        }
      } catch (outerErr) {
        geminiFallbackReason = 'gemini-error';
        console.warn('Gemini TTS gagal:', outerErr);
      }
    }

    const audioBuffer = await synthesizeEdgeMp3(edgeVoice, cleaned, {
      pitch: formatPercent(pitchNum),
      rate: formatPercent(rateNum),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(audioBuffer.length),
      'Cache-Control': 'no-store',
      'X-TTS-Engine': 'edge-neural',
    };
    if (geminiFallbackReason) {
      headers['X-TTS-Fallback-Reason'] = geminiFallbackReason;
    }

    return new NextResponse(new Uint8Array(audioBuffer), {
      status: 200,
      headers,
    });
  } catch (err) {
    resetTts(edgeVoice);
    console.error('TTS Error (akan fallback ke browser):', err);
    return NextResponse.json(
      { error: 'Layanan TTS server sedang tidak tersedia.' },
      { status: 503 }
    );
  }
}
