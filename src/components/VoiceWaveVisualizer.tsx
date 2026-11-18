'use client';

import type { CSSProperties } from 'react';
import { VOICE_WAVE_BANDS } from '@/lib/voice';

interface VoiceWaveVisualizerProps {
  state: 'idle' | 'listening' | 'thinking' | 'speaking';
  waveBins: number[];
  mouthLevel: number;
}

// 21 bar simetris dari kiri -> tengah (band 0 energi vokal paling tinggi) -> kanan
const SYMMETRIC_BAND_INDEXES = [
  10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

export default function VoiceWaveVisualizer({
  state,
  waveBins,
  mouthLevel,
}: VoiceWaveVisualizerProps) {
  const hasRealBins = waveBins.length >= VOICE_WAVE_BANDS;

  return (
    <div
      className="flex h-11 items-center justify-center gap-1 px-2"
      aria-hidden="true"
    >
      {SYMMETRIC_BAND_INDEXES.map((bandIdx, barPos) => {
        const distFromCenter = Math.abs(barPos - 10);
        const centerWeight = 1 - distFromCenter * 0.055;

        if (state === 'listening') {
          const delayMs = distFromCenter * 75;
          return (
            <span
              key={barPos}
              style={{ '--bar-delay': `${delayMs}ms` } as CSSProperties}
              className="voice-bar-listening h-10 w-1 origin-center rounded-full bg-gradient-to-t from-rose-500/75 via-rose-400 to-rose-200 sm:w-1.5"
            />
          );
        }

        if (state === 'thinking') {
          const delayMs = barPos * 55;
          return (
            <span
              key={barPos}
              style={{ '--bar-delay': `${delayMs}ms` } as CSSProperties}
              className="voice-bar-thinking h-10 w-1 origin-center rounded-full bg-gradient-to-t from-sky-500/70 via-sky-400 to-cyan-200 sm:w-1.5"
            />
          );
        }

        if (state === 'speaking') {
          const binVal = hasRealBins
            ? waveBins[bandIdx] ?? mouthLevel
            : mouthLevel * centerWeight;
          const level = Math.min(1, Math.max(0.14, binVal * (0.7 + centerWeight * 0.45)));
          return (
            <span
              key={barPos}
              style={{ transform: `scaleY(${level.toFixed(3)})` }}
              className="h-10 w-1 origin-center rounded-full bg-gradient-to-t from-emerald-600 via-emerald-400 to-teal-200 transition-transform duration-75 sm:w-1.5"
            />
          );
        }

        // Idle: gelombang tenang simetris sangat tipis
        const idleScale = 0.12 + centerWeight * 0.06;
        return (
          <span
            key={barPos}
            style={{ transform: `scaleY(${idleScale.toFixed(3)})` }}
            className="h-10 w-1 origin-center rounded-full bg-slate-700/80 sm:w-1.5"
          />
        );
      })}
    </div>
  );
}

