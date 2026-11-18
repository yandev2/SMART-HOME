import type { AssistantGender, AssistantProfile, VoiceSettings } from './types';

export interface GpioOption {
  pin: number;
  label: string;
  note: string;
}

// Mapping standar pin NodeMCU ESP8266 (board label -> nomor GPIO)
export const NODEMCU_GPIO_OPTIONS: GpioOption[] = [
  { pin: 5, label: 'D1 (GPIO 5)', note: 'Direkomendasikan untuk relay' },
  { pin: 4, label: 'D2 (GPIO 4)', note: 'Direkomendasikan untuk relay' },
  { pin: 14, label: 'D5 (GPIO 14)', note: 'Direkomendasikan untuk relay' },
  { pin: 12, label: 'D6 (GPIO 12)', note: 'Direkomendasikan untuk relay' },
  { pin: 13, label: 'D7 (GPIO 13)', note: 'Direkomendasikan untuk relay' },
  { pin: 0, label: 'D3 (GPIO 0)', note: 'Hati-hati: harus HIGH saat boot' },
  { pin: 2, label: 'D4 (GPIO 2)', note: 'Terhubung LED internal NodeMCU' },
  { pin: 15, label: 'D8 (GPIO 15)', note: 'Harus LOW saat boot' },
  { pin: 16, label: 'D0 (GPIO 16)', note: 'Tidak mendukung semua fitur interrupt' },
];

export function formatGpioLabel(pin: number): string {
  const found = NODEMCU_GPIO_OPTIONS.find((item) => item.pin === pin);
  return found ? found.label : `GPIO ${pin}`;
}

// Controller dianggap online jika melakukan sync dalam 30 detik terakhir
export const CONTROLLER_ONLINE_THRESHOLD_MS = 30_000;

export function isControllerOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  const diff = Date.now() - new Date(lastSeen).getTime();
  return diff >= 0 && diff <= CONTROLLER_ONLINE_THRESHOLD_MS;
}

export interface StyleOption {
  id: string;
  label: string;
}

export const ASSISTANT_STYLE_OPTIONS: StyleOption[] = [
  { id: 'santai', label: 'Santai' },
  { id: 'ceria', label: 'Ceria' },
  { id: 'perhatian', label: 'Perhatian' },
  { id: 'suka bercanda', label: 'Suka Bercanda' },
  { id: 'sopan', label: 'Sopan & Ramah' },
  { id: 'gaul', label: 'Gaul & Akrab' },
  { id: 'ringkas', label: 'Ringkas & To-the-point' },
  { id: 'tenang', label: 'Tenang & Elegan' },
];

export const DEFAULT_ASSISTANT_PROFILE: AssistantProfile = {
  name: 'Surya',
  gender: 'laki-laki',
  styles: ['santai', 'ceria', 'suka bercanda'],
  description: '',
};

export interface VoiceOption {
  id: string;
  label: string;
  gender: AssistantGender;
  note: string;
}

export const VOICE_OPTIONS: VoiceOption[] = [
  {
    id: 'id-ID-GadisNeural',
    label: 'Gadis (Indonesia Asli)',
    gender: 'perempuan',
    note: 'Pelafalan Indonesia paling bersih',
  },
  {
    id: 'en-US-AvaMultilingualNeural',
    label: 'Ava (Multilingual — Hangat & Lembut)',
    gender: 'perempuan',
    note: 'Vokal halus, hangat & modern (sedikit aksen bilingual)',
  },
  {
    id: 'en-US-EmmaMultilingualNeural',
    label: 'Emma (Multilingual — Muda & Ceria)',
    gender: 'perempuan',
    note: 'Vokal terdengar muda & ekspresif (sedikit aksen bilingual)',
  },
  {
    id: 'id-ID-ArdiNeural',
    label: 'Ardi (Indonesia Asli)',
    gender: 'laki-laki',
    note: 'Pelafalan Indonesia paling bersih',
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    label: 'Andrew (Multilingual — Hangat & Tenang)',
    gender: 'laki-laki',
    note: 'Vokal hangat & kalem (sedikit aksen bilingual)',
  },
  {
    id: 'en-US-BrianMultilingualNeural',
    label: 'Brian (Multilingual — Santai & Ramah)',
    gender: 'laki-laki',
    note: 'Vokal santai & ringan (sedikit aksen bilingual)',
  },
];

export const GEMINI_VOICE_OPTIONS: VoiceOption[] = [
  {
    id: 'Leda',
    label: 'Leda — Youthful (Muda & Segar)',
    gender: 'perempuan',
    note: 'Suara perempuan terdengar muda, ringan, dan ekspresif',
  },
  {
    id: 'Aoede',
    label: 'Aoede — Breezy (Santai & Natural)',
    gender: 'perempuan',
    note: 'Suara perempuan santai dan mengalir seperti teman ngobrol',
  },
  {
    id: 'Sulafat',
    label: 'Sulafat — Warm (Hangat & Lembut)',
    gender: 'perempuan',
    note: 'Suara perempuan hangat, lembut, dan intim',
  },
  {
    id: 'Zephyr',
    label: 'Zephyr — Bright (Cerah & Jelas)',
    gender: 'perempuan',
    note: 'Suara perempuan cerah dan artikulatif ala asisten',
  },
  {
    id: 'Achernar',
    label: 'Achernar — Soft (Halus & Kalem)',
    gender: 'perempuan',
    note: 'Suara perempuan halus dan menenangkan',
  },
  {
    id: 'Puck',
    label: 'Puck — Upbeat (Ceria & Ramah)',
    gender: 'laki-laki',
    note: 'Suara laki-laki bersemangat dan ramah',
  },
  {
    id: 'Achird',
    label: 'Achird — Friendly (Akrab & Hangat)',
    gender: 'laki-laki',
    note: 'Suara laki-laki akrab dan natural',
  },
  {
    id: 'Zubenelgenubi',
    label: 'Zubenelgenubi — Casual (Santai)',
    gender: 'laki-laki',
    note: 'Suara laki-laki kasual untuk obrolan sehari-hari',
  },
  {
    id: 'Charon',
    label: 'Charon — Informative (Jelas)',
    gender: 'laki-laki',
    note: 'Suara laki-laki informatif dan tenang',
  },
  {
    id: 'Orus',
    label: 'Orus — Firm (Tegas & Berwibawa)',
    gender: 'laki-laki',
    note: 'Suara laki-laki tegas dan mantap',
  },
];

export interface VoicePreset {
  id: string;
  label: string;
  pitch: number;
  rate: number;
  warmEq: boolean;
}

export const VOICE_PRESETS: VoicePreset[] = [
  { id: 'muda-ceria', label: 'Muda & Ceria', pitch: 14, rate: 6, warmEq: true },
  { id: 'muda-manis', label: 'Muda & Manis', pitch: 10, rate: -2, warmEq: true },
  { id: 'hangat-lembut', label: 'Hangat & Lembut', pitch: -2, rate: -6, warmEq: true },
  { id: 'natural', label: 'Natural Seimbang', pitch: 6, rate: 4, warmEq: true },
];

export function getDefaultVoiceSettings(gender: AssistantGender): VoiceSettings {
  return gender === 'perempuan'
    ? {
        engine: 'edge-tts',
        voiceId: 'id-ID-GadisNeural',
        geminiVoice: 'Leda',
        pitch: 10,
        rate: 4,
        warmEq: true,
      }
    : {
        engine: 'edge-tts',
        voiceId: 'id-ID-ArdiNeural',
        geminiVoice: 'Puck',
        pitch: 4,
        rate: 4,
        warmEq: true,
      };
}

