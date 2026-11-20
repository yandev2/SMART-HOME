import type {
  AssistantGender,
  AssistantProfile,
  AvatarRig,
  CustomAvatarConfig,
  VoiceSettings,
  WledEffect,
} from './types';

export interface GpioOption {
  pin: number;
  label: string;
  note: string;
}

// Mapping standar pin NodeMCU ESP8266 (board label -> nomor GPIO)
export const NODEMCU_GPIO_OPTIONS: GpioOption[] = [
  { pin: 5, label: 'D1 (GPIO 5)', note: 'Relay CH1 PCB (direkomendasikan)' },
  { pin: 4, label: 'D2 (GPIO 4)', note: 'Relay CH2 PCB (direkomendasikan)' },
  { pin: 14, label: 'D5 (GPIO 14)', note: 'Relay CH3 PCB (direkomendasikan)' },
  { pin: 12, label: 'D6 (GPIO 12)', note: 'Relay CH4 PCB (direkomendasikan)' },
  { pin: 13, label: 'D7 (GPIO 13)', note: 'Input Push Button CH1 pada PCB 4CH' },
  { pin: 0, label: 'D3 (GPIO 0)', note: 'Input Push Button CH3 pada PCB 4CH (HIGH saat boot)' },
  { pin: 2, label: 'D4 (GPIO 2)', note: 'Input Push Button CH2 pada PCB 4CH / LED internal' },
  { pin: 15, label: 'D8 (GPIO 15)', note: 'Harus LOW saat boot' },
  { pin: 16, label: 'D0 (GPIO 16)', note: 'Input Push Button CH4 (wajib pull-up 4.7k)' },
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

export const DEFAULT_AVATAR_RIG: AvatarRig = {
  leftEye: { x: 0.405, y: 0.415, rx: 0.065, ry: 0.045 },
  rightEye: { x: 0.595, y: 0.415, rx: 0.065, ry: 0.045 },
  mouth: { x: 0.5, y: 0.555, rx: 0.085, ry: 0.055, curve: -0.25 },
  neckY: 0.67,
  motionIntensity: 1.0,
};

function clampRange(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

export function sanitizeAvatarRig(raw: unknown): AvatarRig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const le = (r.leftEye && typeof r.leftEye === 'object' ? r.leftEye : {}) as Record<string, unknown>;
  const re = (r.rightEye && typeof r.rightEye === 'object' ? r.rightEye : {}) as Record<string, unknown>;
  const mo = (r.mouth && typeof r.mouth === 'object' ? r.mouth : {}) as Record<string, unknown>;

  return {
    leftEye: {
      x: clampRange(le.x, 0.08, 0.92, DEFAULT_AVATAR_RIG.leftEye.x),
      y: clampRange(le.y, 0.08, 0.92, DEFAULT_AVATAR_RIG.leftEye.y),
      rx: clampRange(le.rx, 0.025, 0.16, DEFAULT_AVATAR_RIG.leftEye.rx),
      ry: clampRange(le.ry, 0.02, 0.14, DEFAULT_AVATAR_RIG.leftEye.ry),
    },
    rightEye: {
      x: clampRange(re.x, 0.08, 0.92, DEFAULT_AVATAR_RIG.rightEye.x),
      y: clampRange(re.y, 0.08, 0.92, DEFAULT_AVATAR_RIG.rightEye.y),
      rx: clampRange(re.rx, 0.025, 0.16, DEFAULT_AVATAR_RIG.rightEye.rx),
      ry: clampRange(re.ry, 0.02, 0.14, DEFAULT_AVATAR_RIG.rightEye.ry),
    },
    mouth: {
      x: clampRange(mo.x, 0.1, 0.9, DEFAULT_AVATAR_RIG.mouth.x),
      y: clampRange(mo.y, 0.15, 0.92, DEFAULT_AVATAR_RIG.mouth.y),
      rx: clampRange(mo.rx, 0.03, 0.22, DEFAULT_AVATAR_RIG.mouth.rx),
      ry: clampRange(mo.ry, 0.02, 0.15, DEFAULT_AVATAR_RIG.mouth.ry),
      curve: clampRange(mo.curve, -0.6, 0.45, DEFAULT_AVATAR_RIG.mouth.curve ?? -0.25),
    },
    neckY: clampRange(r.neckY, 0.35, 0.95, DEFAULT_AVATAR_RIG.neckY),
    motionIntensity: clampRange(r.motionIntensity, 0.2, 1.6, DEFAULT_AVATAR_RIG.motionIntensity),
  };
}

export function sanitizeCustomAvatar(raw: unknown): CustomAvatarConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const dataUrl = typeof obj.imageDataUrl === 'string' ? obj.imageDataUrl.trim() : '';
  const validPrefix =
    dataUrl.startsWith('data:image/webp;base64,') ||
    dataUrl.startsWith('data:image/png;base64,') ||
    dataUrl.startsWith('data:image/jpeg;base64,');

  if (!validPrefix || dataUrl.length > 750_000) {
    return null;
  }

  return {
    imageDataUrl: dataUrl,
    rig: sanitizeAvatarRig(obj.rig),
  };
}

export const DEFAULT_ASSISTANT_PROFILE: AssistantProfile = {
  name: 'Surya',
  gender: 'laki-laki',
  styles: ['santai', 'ceria', 'suka bercanda'],
  description: '',
  avatarMode: 'default',
  customAvatar: null,
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

export interface WledEffectOption {
  id: WledEffect;
  label: string;
  note: string;
}

export const WLED_EFFECT_OPTIONS: WledEffectOption[] = [
  { id: 'solid', label: 'Solid (Diam)', note: 'Warna stabil merata' },
  { id: 'breathe', label: 'Breathe (Bernapas)', note: 'Redup-terang lembut & tenang' },
  { id: 'rainbow', label: 'Rainbow (Pelangi)', note: 'Spektrum warna mengalir' },
  { id: 'gradient', label: 'Gradient (Gradasi)', note: 'Perpaduan warna harmonis' },
  { id: 'sparkle', label: 'Sparkle (Kerlip)', note: 'Kilau bintang di atas warna' },
  { id: 'chase', label: 'Chase (Berjalan)', note: 'Titik cahaya berlari' },
  { id: 'meteor', label: 'Meteor (Komet)', note: 'Ekor cahaya melintas' },
  { id: 'fire', label: 'Fire (Api Hangat)', note: 'Simulasi cahaya api hangat' },
];

export interface WledColorSwatch {
  name: string;
  hex: string;
}

export const WLED_QUICK_COLORS: WledColorSwatch[] = [
  { name: 'Biru', hex: '#2563EB' },
  { name: 'Merah', hex: '#EF4444' },
  { name: 'Hijau', hex: '#22C55E' },
  { name: 'Kuning', hex: '#FACC15' },
  { name: 'Pink', hex: '#EC4899' },
  { name: 'Ungu', hex: '#9333EA' },
  { name: 'Cyan', hex: '#06B6D4' },
  { name: 'Oranye', hex: '#F97316' },
  { name: 'Warm White', hex: '#FDBA74' },
  { name: 'Cool White', hex: '#E0F2FE' },
];

export const WLED_GPIO_OPTIONS: GpioOption[] = [
  { pin: 2, label: 'D4 (GPIO 2)', note: 'Direkomendasikan untuk WS2812 Data' },
  { pin: 4, label: 'D2 (GPIO 4)', note: 'Alternatif pin Data WS2812' },
  { pin: 5, label: 'D1 (GPIO 5)', note: 'Alternatif pin Data WS2812' },
  { pin: 14, label: 'D5 (GPIO 14)', note: 'Alternatif pin Data WS2812' },
  { pin: 12, label: 'D6 (GPIO 12)', note: 'Alternatif pin Data WS2812' },
  { pin: 13, label: 'D7 (GPIO 13)', note: 'Alternatif pin Data WS2812' },
];

export function formatWledGpioLabel(pin: number): string {
  const found = WLED_GPIO_OPTIONS.find((item) => item.pin === pin);
  return found ? found.label : formatGpioLabel(pin);
}

export function sanitizeHexColor(raw: unknown, fallback = '#38BDF8'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^[0-9A-F]{6}$/.test(cleaned)) {
    return `#${cleaned}`;
  }
  return fallback;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const safe = sanitizeHexColor(hex);
  const num = parseInt(safe.slice(1), 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

export function isValidWledEffect(val: unknown): val is WledEffect {
  return typeof val === 'string' && WLED_EFFECT_OPTIONS.some((e) => e.id === val);
}

export function clampWledByte(
  val: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, Math.round(val)));
}

