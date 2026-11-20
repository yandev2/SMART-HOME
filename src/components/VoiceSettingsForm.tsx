'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Clock,
  Gauge,
  RefreshCw,
  Square,
  Volume2,
  Zap,
} from 'lucide-react';
import {
  GEMINI_VOICE_OPTIONS,
  VOICE_OPTIONS,
  VOICE_PRESETS,
} from '@/lib/constants';
import type {
  AssistantGender,
  AvatarMode,
  CustomAvatarConfig,
  VoiceSettings,
} from '@/lib/types';
import { type ActiveVoiceEngine, SmartHomeVoicePlayer } from '@/lib/voice';
import AssistantAvatar from './AssistantAvatar';

interface QuotaTokenItem {
  id: string;
  label: string;
  maskedKey: string;
  priority: number;
  isPrimary: boolean;
  isActiveNow: boolean;
  status: 'ready' | 'cooldown' | 'exhausted';
  cooldownRemainingSec: number;
  usedToday: number;
  remainingToday: number;
  limitToday: number;
}

interface QuotaResponseData {
  hasApiKey: boolean;
  tokenCount?: number;
  readyTokensCount?: number;
  activeToken?: {
    id: string;
    label: string;
    maskedKey: string;
    priority: number;
  } | null;
  status: 'ready' | 'cooldown' | 'no-key';
  cooldownRemainingSec: number;
  rpd: {
    used: number;
    remaining: number;
    limit: number;
    perTokenLimit?: number;
    percentRemaining: number;
    breakdown: {
      chatAndVoice: number;
      voiceTestPreview: number;
    };
  };
  rpm: {
    used: number;
    remaining: number;
    limit: number;
    perTokenLimit?: number;
  };
  tokensToday: {
    used: number;
    remaining: number;
    limit: number;
  };
  tokens?: QuotaTokenItem[];
  reset: {
    dayStartIso: string;
    nextResetIso: string;
    resetInSeconds: number;
    resetWibLabel: string;
  };
}

function formatResetDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) {
    return `${hours}j ${minutes}m lagi`;
  }
  return `${Math.max(1, minutes)}m lagi`;
}

function formatCompactTokens(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2).replace('.', ',')} Jt`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1).replace('.', ',')} rb`;
  }
  return String(num);
}

interface VoiceSettingsFormProps {
  assistantName: string;
  gender: AssistantGender;
  avatarMode?: AvatarMode;
  customAvatar?: CustomAvatarConfig | null;
  hasApiKey: boolean;
  voiceSettings: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}

export default function VoiceSettingsForm({
  assistantName,
  gender,
  avatarMode,
  customAvatar,
  hasApiKey,
  voiceSettings,
  onChange,
}: VoiceSettingsFormProps) {
  const [testing, setTesting] = useState(false);
  const [mouthLevel, setMouthLevel] = useState(0);
  const [engineUsed, setEngineUsed] = useState<ActiveVoiceEngine | null>(null);
  const [quota, setQuota] = useState<QuotaResponseData | null>(null);
  const [loadingQuota, setLoadingQuota] = useState(false);
  const playerRef = useRef<SmartHomeVoicePlayer | null>(null);
  const prevTestingRef = useRef(false);

  const fetchQuota = useCallback(async () => {
    setLoadingQuota(true);
    try {
      const res = await fetch('/api/settings/quota', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as QuotaResponseData;
        setQuota(data);
      }
    } catch {
      // Abaikan jika gagal memuat kuota
    } finally {
      setLoadingQuota(false);
    }
  }, []);

  useEffect(() => {
    playerRef.current = new SmartHomeVoicePlayer();
    void fetchQuota();
    const interval = window.setInterval(() => {
      void fetchQuota();
    }, 30000);
    const onKeysUpdated = () => {
      void fetchQuota();
    };
    window.addEventListener('smart-home-keys-updated', onKeysUpdated);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('smart-home-keys-updated', onKeysUpdated);
      playerRef.current?.stop();
    };
  }, [fetchQuota, hasApiKey]);

  useEffect(() => {
    // Segarkan angka kuota segera setelah tes suara selesai diputar
    if (prevTestingRef.current && !testing) {
      void fetchQuota();
    }
    prevTestingRef.current = testing;
  }, [testing, fetchQuota]);

  const isGemini = voiceSettings.engine === 'gemini-tts';
  const activeList = isGemini ? GEMINI_VOICE_OPTIONS : VOICE_OPTIONS;
  const activeVoiceId = isGemini ? voiceSettings.geminiVoice : voiceSettings.voiceId;
  const selectedOption = activeList.find((v) => v.id === activeVoiceId);

  function handleTestVoice() {
    if (!playerRef.current) return;
    if (testing) {
      playerRef.current.stop(setMouthLevel, setTesting);
      return;
    }

    playerRef.current.unlock();
    playerRef.current.speak({
      text: `Halo Bos! Ini ${assistantName}, suara aku sekarang sudah disetel. Gimana menurutmu, udah enak dan pas belum?`,
      gender,
      voiceSettings,
      onMouthLevel: setMouthLevel,
      onSpeakingChange: setTesting,
      onEngineUsed: setEngineUsed,
    });
  }

  const engineLabel =
    engineUsed === 'gemini-tts'
      ? 'Gemini 3.8 Live'
      : engineUsed === 'browser-fallback'
        ? 'Browser Fallback'
        : 'Edge Neural';

  return (
    <section aria-labelledby="voice-tuning-heading" className="space-y-3">
      <div>
        <h2 id="voice-tuning-heading" className="text-sm font-semibold text-white">
          Tuning Suara &amp; Audio Asisten
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Pilih mesin suara (Gemini 3.8 Live Native Audio 1x Request atau Edge Neural
          alternatif), nada, kecepatan, dan Studio Warmth EQ.
        </p>
      </div>

      <div className="space-y-3.5 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-slate-200">
            Mesin Suara (Voice Engine)
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition ${
                isGemini
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-100'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name="tts_engine"
                value="gemini-tts"
                checked={isGemini}
                onChange={() => onChange({ ...voiceSettings, engine: 'gemini-tts' })}
                className="mt-0.5 h-3.5 w-3.5 accent-emerald-500"
              />
              <span>
                <strong className="block font-semibold">
                  Gemini 3.8 Live Native (Disarankan)
                </strong>
                <span className="text-[10px] text-slate-400">
                  Suara natural 1x Request (~1.500/hari, streaming cepat ~1.6 dtk)
                </span>
              </span>
            </label>

            <label
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-xs transition ${
                !isGemini
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-100'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name="tts_engine"
                value="edge-tts"
                checked={!isGemini}
                onChange={() => onChange({ ...voiceSettings, engine: 'edge-tts' })}
                className="mt-0.5 h-3.5 w-3.5 accent-emerald-500"
              />
              <span>
                <strong className="block font-semibold">Edge Neural (Cadangan)</strong>
                <span className="text-[10px] text-slate-400">
                  Alternatif tanpa memakai kuota Google API
                </span>
              </span>
            </label>
          </div>
          {isGemini && !hasApiKey && (
            <p className="text-[11px] text-amber-300">
              API Key Gemini belum diisi — sistem akan otomatis memakai Edge Neural sampai
              API Key ditambahkan.
            </p>
          )}
          {isGemini && hasApiKey && (
            <p className="text-[11px] text-slate-400">
              Mode Suara menggunakan arsitektur 1x Request Native Audio (Gemini 3.8 Live):
              kontrol perangkat, teks, dan suara mengalir sekaligus tanpa panggilan TTS terpisah.
            </p>
          )}
        </fieldset>

        {/* Monitor Sisa Kuota & Limit Gemini API (Free Tier) */}
        <div className="space-y-2.5 rounded-xl border border-slate-800/90 bg-slate-950/75 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              <span className="text-xs font-semibold text-white">
                Monitor Sisa Kuota &amp; Limit Gemini API
              </span>
              {quota && (
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    !isGemini
                      ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                      : quota.status === 'ready'
                        ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                        : quota.status === 'cooldown'
                          ? 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30'
                          : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {!isGemini
                    ? 'Hemat Kuota (Edge Aktif)'
                    : quota.status === 'ready'
                      ? `${quota.tokenCount || 1} Token • ${
                          (quota.tokenCount || 1) > 1 ? 'Auto-Failover Siap' : 'Free Tier Siap'
                        }`
                      : quota.status === 'cooldown'
                        ? `Semua Cooldown (${quota.cooldownRemainingSec}d)`
                        : 'API Key Belum Ada'}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => void fetchQuota()}
              disabled={loadingQuota}
              aria-label="Segarkan informasi kuota"
              className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[10px] font-medium text-slate-300 transition hover:border-slate-700 hover:text-white disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${loadingQuota ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </button>
          </div>

          {quota ? (
            <>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {/* Kartu Sisa Kuota Harian (RPD) */}
                <div className="space-y-1.5 rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1 text-slate-300">
                      <Zap className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                      Sisa Kuota Harian (RPD)
                    </span>
                    <span className="font-mono font-semibold text-emerald-300">
                      {quota.rpd.remaining.toLocaleString('id-ID')} /{' '}
                      {quota.rpd.limit.toLocaleString('id-ID')}
                    </span>
                  </div>

                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full transition-all ${
                        quota.rpd.percentRemaining > 50
                          ? 'bg-emerald-500'
                          : quota.rpd.percentRemaining > 20
                            ? 'bg-amber-400'
                            : 'bg-rose-500'
                      }`}
                      style={{ width: `${Math.max(2, quota.rpd.percentRemaining)}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>
                      Terpakai hari ini: <strong className="text-slate-200">{quota.rpd.used}x</strong>
                    </span>
                    <span>Sisa {quota.rpd.percentRemaining}%</span>
                  </div>
                </div>

                {/* Kartu Batas Kecepatan per Menit (RPM) */}
                <div className="space-y-1.5 rounded-lg border border-slate-800/80 bg-slate-900/60 p-2.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1 text-slate-300">
                      <Activity className="h-3 w-3 text-sky-400" aria-hidden="true" />
                      Batas Kecepatan (RPM)
                    </span>
                    <span className="font-mono font-semibold text-sky-300">
                      {quota.rpm.remaining} / {quota.rpm.limit} /mnt
                    </span>
                  </div>

                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full transition-all ${
                        quota.rpm.remaining > 5
                          ? 'bg-sky-400'
                          : quota.rpm.remaining > 2
                            ? 'bg-amber-400'
                            : 'bg-rose-500'
                      }`}
                      style={{
                        width: `${Math.max(
                          4,
                          Math.round((quota.rpm.remaining / quota.rpm.limit) * 100)
                        )}%`,
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>
                      1 mnt terakhir: <strong className="text-slate-200">{quota.rpm.used}x</strong>
                    </span>
                    <span>Maks {quota.rpm.limit} req/menit</span>
                  </div>
                </div>
              </div>

              {quota.activeToken && (
                <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-slate-800/70 bg-slate-900/40 px-2.5 py-1.5 text-[10px] text-slate-300">
                  <span>
                    Token Aktif Saat Ini:{' '}
                    <strong className="text-emerald-300">
                      #{quota.activeToken.priority} {quota.activeToken.label}
                    </strong>{' '}
                    <span className="font-mono text-slate-400">
                      ({quota.activeToken.maskedKey})
                    </span>
                  </span>
                  {(quota.tokenCount ?? 0) > 1 && (
                    <span className="text-emerald-400">
                      {quota.readyTokensCount}/{quota.tokenCount} token siap failover
                    </span>
                  )}
                </div>
              )}

              {/* Baris Estimasi Token & Jadwal Reset */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2 text-[10px] text-slate-400">
                <span>
                  Estimasi token hari ini:{' '}
                  <strong className="font-mono text-slate-200">
                    ~{formatCompactTokens(quota.tokensToday.used)}
                  </strong>{' '}
                  / {formatCompactTokens(quota.tokensToday.limit)} token
                </span>

                <span className="inline-flex items-center gap-1 text-slate-300">
                  <Clock className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                  Reset kuota: <strong>{quota.reset.resetWibLabel}</strong> (
                  {formatResetDuration(quota.reset.resetInSeconds)})
                </span>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-slate-400">Memuat data kuota harian...</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="voice-model" className="text-xs font-medium text-slate-200">
            {isGemini ? 'Model Suara Google Gemini' : 'Model Suara Edge Neural'}
          </label>
          <select
            id="voice-model"
            value={activeVoiceId}
            onChange={(e) =>
              onChange(
                isGemini
                  ? { ...voiceSettings, geminiVoice: e.target.value }
                  : { ...voiceSettings, voiceId: e.target.value }
              )
            }
            aria-describedby="voice-model-note"
            className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
          >
            <optgroup label="Suara Perempuan">
              {activeList
                .filter((v) => v.gender === 'perempuan')
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Suara Laki-laki">
              {activeList
                .filter((v) => v.gender === 'laki-laki')
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
            </optgroup>
          </select>
          {selectedOption && (
            <span id="voice-model-note" className="text-[11px] text-slate-400">
              {selectedOption.note}
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-slate-200">
            Preset Karakter Suara
          </span>
          <div className="flex flex-wrap gap-1.5">
            {VOICE_PRESETS.map((preset) => {
              const active =
                voiceSettings.pitch === preset.pitch &&
                voiceSettings.rate === preset.rate &&
                voiceSettings.warmEq === preset.warmEq;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...voiceSettings,
                      pitch: preset.pitch,
                      rate: preset.rate,
                      warmEq: preset.warmEq,
                    })
                  }
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                    active
                      ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="voice-pitch" className="font-medium text-slate-200">
                {isGemini ? 'Arah Nada (Gaya)' : 'Tinggi Nada (Pitch)'}
              </label>
              <span className="font-mono text-[11px] text-emerald-300">
                {voiceSettings.pitch >= 0 ? `+${voiceSettings.pitch}%` : `${voiceSettings.pitch}%`}
              </span>
            </div>
            <input
              id="voice-pitch"
              type="range"
              min={-15}
              max={25}
              step={1}
              value={voiceSettings.pitch}
              onChange={(e) =>
                onChange({ ...voiceSettings, pitch: Number(e.target.value) })
              }
              className="h-2 w-full cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Lebih Berat (-15%)</span>
              <span>Lebih Muda (+25%)</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="voice-rate" className="font-medium text-slate-200">
                Kecepatan Bicara
              </label>
              <span className="font-mono text-[11px] text-emerald-300">
                {voiceSettings.rate >= 0 ? `+${voiceSettings.rate}%` : `${voiceSettings.rate}%`}
              </span>
            </div>
            <input
              id="voice-rate"
              type="range"
              min={-20}
              max={25}
              step={1}
              value={voiceSettings.rate}
              onChange={(e) =>
                onChange({ ...voiceSettings, rate: Number(e.target.value) })
              }
              className="h-2 w-full cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Santai (-20%)</span>
              <span>Cepat (+25%)</span>
            </div>
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={voiceSettings.warmEq}
            onChange={(e) =>
              onChange({ ...voiceSettings, warmEq: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 accent-emerald-500"
          />
          <span>
            <strong className="font-medium text-white">Studio Warmth EQ</strong>
            <span className="block text-[11px] text-slate-400">
              Menambah kehangatan vokal, mengurangi nada metalik, dan meratakan volume
              secara real-time.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3">
          <div className="flex items-center gap-2.5">
            <AssistantAvatar
              gender={gender}
              mouthLevel={mouthLevel}
              isSpeaking={testing}
              avatarMode={avatarMode}
              customAvatar={customAvatar}
            />
            <div className="text-xs">
              <p className="font-medium text-slate-200">Uji Hasil Audio</p>
              <p className="text-[11px] text-slate-400">
                {testing
                  ? `Memutar via ${engineLabel}...`
                  : 'Klik Tes Suara untuk mendengar langsung.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleTestVoice}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
              testing
                ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
            }`}
          >
            {testing ? (
              <>
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                Stop Tes
              </>
            ) : (
              <>
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                Tes Suara
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
