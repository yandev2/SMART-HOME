'use client';

import type { AssistantGender } from '@/lib/types';

interface AssistantAvatarProps {
  gender: AssistantGender;
  mouthLevel: number; // 0 (diam) sampai 1 (terbuka penuh saat berbicara)
  isSpeaking: boolean;
}

export default function AssistantAvatar({
  gender,
  mouthLevel,
  isSpeaking,
}: AssistantAvatarProps) {
  const clamped = Math.min(1, Math.max(0, mouthLevel));
  // Tinggi bukaan mulut antara 1.2 (senyum santai) hingga 6.2 (mulut terbuka)
  const mouthOpen = 1.2 + clamped * 5;
  const isFemale = gender === 'perempuan';

  return (
    <div
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
        isSpeaking
          ? 'bg-emerald-500/20 ring-2 ring-emerald-400/70'
          : 'bg-emerald-500/15 ring-1 ring-emerald-500/30'
      }`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 40 40"
        className="h-9 w-9"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Rambut belakang untuk karakter perempuan */}
        {isFemale && (
          <path
            d="M9 20C9 12.5 13.8 7 20 7C26.2 7 31 12.5 31 20V29C31 30.5 29.5 31.5 28 31H12C10.5 31.5 9 30.5 9 29V20Z"
            fill={isFemale ? '#334155' : '#1e293b'}
          />
        )}

        {/* Wajah */}
        <circle cx="20" cy="21" r="10" fill="#FCD5B5" />

        {/* Gaya rambut depan */}
        {isFemale ? (
          <path
            d="M10 19C10.5 13 14.5 9 20 9C25.5 9 29.5 13 30 19C27.5 16 24.5 14.5 20 14.5C15.5 14.5 12.5 16 10 19Z"
            fill="#1e293b"
          />
        ) : (
          <path
            d="M10 18.5C10.2 12.5 14.4 8.5 20 8.5C25.6 8.5 29.8 12.5 30 18.5C28 15 24 13.5 20 13.5C16 13.5 12 15 10 18.5Z"
            fill="#0f172a"
          />
        )}

        {/* Mata */}
        <circle cx="16.2" cy="20.2" r="1.35" fill="#0f172a" />
        <circle cx="23.8" cy="20.2" r="1.35" fill="#0f172a" />
        <circle cx="16.6" cy="19.8" r="0.45" fill="#ffffff" />
        <circle cx="24.2" cy="19.8" r="0.45" fill="#ffffff" />

        {/* Pipi */}
        <circle cx="13.8" cy="22.8" r="1.5" fill="#FDA4AF" fillOpacity="0.45" />
        <circle cx="26.2" cy="22.8" r="1.5" fill="#FDA4AF" fillOpacity="0.45" />

        {/* Mulut lip-sync dinamis */}
        {clamped < 0.08 ? (
          <path
            d="M16.5 25.3C17.8 26.6 22.2 26.6 23.5 25.3"
            stroke="#9f1239"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ) : (
          <ellipse
            cx="20"
            cy="25.8"
            rx={3.2 + clamped * 0.9}
            ry={mouthOpen / 2}
            fill="#9f1239"
          />
        )}
      </svg>

      {isSpeaking && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
      )}
    </div>
  );
}

