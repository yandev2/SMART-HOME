'use client';

import { useEffect, useRef, useState } from 'react';
import { Square, Volume2 } from 'lucide-react';
import {
  GEMINI_VOICE_OPTIONS,
  VOICE_OPTIONS,
  VOICE_PRESETS,
} from '@/lib/constants';
import type { AssistantGender, VoiceSettings } from '@/lib/types';
import { type ActiveVoiceEngine, SmartHomeVoicePlayer } from '@/lib/voice';
import AssistantAvatar from './AssistantAvatar';

interface VoiceSettingsFormProps {
  assistantName: string;
  gender: AssistantGender;
  hasApiKey: boolean;
  voiceSettings: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}

export default function VoiceSettingsForm({
  assistantName,
  gender,
  hasApiKey,
  voiceSettings,
  onChange,
}: VoiceSettingsFormProps) {
  const [testing, setTesting] = useState(false);
  const [mouthLevel, setMouthLevel] = useState(0);
  const [engineUsed, setEngineUsed] = useState<ActiveVoiceEngine | null>(null);
  const playerRef = useRef<SmartHomeVoicePlayer | null>(null);

  useEffect(() => {
    playerRef.current = new SmartHomeVoicePlayer();
    return () => {
      playerRef.current?.stop();
    };
  }, []);

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
      ? 'Gemini 3.8 TTS'
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
          Pilih mesin suara (Edge Neural gratis tanpa kuota atau Gemini 3.8 TTS ala Google
          modern), nada, kecepatan, dan Studio Warmth EQ.
        </p>
      </div>

      <div className="space-y-3.5 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-slate-200">
            Mesin Suara (TTS Engine)
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
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
                <strong className="block font-semibold">Edge Neural (Disarankan)</strong>
                <span className="text-[10px] text-slate-400">
                  Cepat, gratis, tanpa batas kuota harian
                </span>
              </span>
            </label>

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
                <strong className="block font-semibold">Gemini 3.8 TTS</strong>
                <span className="text-[10px] text-slate-400">
                  Suara Google (Free Tier maks 10/hari, jeda ~6–30 dtk)
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
              Catatan: Google Gemini TTS pada Free Tier dibatasi 10 permintaan/hari dan
              memproses audio lebih lama (~6–30 detik). Jika kuota habis atau timeout, suara
              otomatis beralih cepat ke Edge Neural.
            </p>
          )}
        </fieldset>

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
