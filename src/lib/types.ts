export interface Room {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface Controller {
  id: string;
  user_id: string;
  name: string;
  api_token: string;
  last_seen: string | null;
  created_at: string;
}

export interface Device {
  id: string;
  user_id: string;
  room_id: string | null;
  controller_id: string | null;
  name: string;
  aliases: string;
  gpio_pin: number;
  active_low: boolean;
  is_on: boolean;
  updated_at: string;
}

export interface Preset {
  id: string;
  user_id: string;
  room_id: string | null;
  name: string;
  keywords: string;
  device_ids: string[];
  turn_off_others: boolean;
  created_at: string;
  updated_at: string;
}

export type WledEffect =
  | 'solid'
  | 'breathe'
  | 'rainbow'
  | 'chase'
  | 'sparkle'
  | 'fire'
  | 'meteor'
  | 'gradient';

export interface WledDevice {
  id: string;
  user_id: string;
  room_id: string | null;
  name: string;
  aliases: string;
  api_token: string;
  gpio_pin: number;
  led_count: number;
  is_on: boolean;
  brightness: number;
  color_hex: string;
  effect: WledEffect;
  speed: number;
  active_preset_id: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface WledPreset {
  id: string;
  user_id: string;
  wled_device_id: string | null;
  name: string;
  keywords: string;
  is_on: boolean;
  color_hex: string;
  brightness: number;
  effect: WledEffect;
  speed: number;
  created_at: string;
  updated_at: string;
}

export interface ActionLog {
  device_id: string;
  device_name: string;
  is_on: boolean;
  kind?: 'switch' | 'wled';
  color_hex?: string;
  effect?: WledEffect | string;
  brightness?: number;
  preset_name?: string;
}

export interface ChatMessage {
  id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  actions: ActionLog[];
  created_at: string;
}

export type AssistantGender = 'laki-laki' | 'perempuan';

export type AvatarMode = 'default' | 'custom';

export interface EyeRigPoint {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface MouthRigPoint {
  x: number;
  y: number;
  rx: number;
  ry: number;
  curve?: number;
}

export interface AvatarRig {
  leftEye: EyeRigPoint;
  rightEye: EyeRigPoint;
  mouth: MouthRigPoint;
  neckY: number;
  motionIntensity: number;
}

export interface CustomAvatarConfig {
  imageDataUrl: string;
  rig: AvatarRig;
}

export interface AssistantProfile {
  name: string;
  gender: AssistantGender;
  styles: string[];
  description: string;
  avatarMode?: AvatarMode;
  customAvatar?: CustomAvatarConfig | null;
}

export type TtsEngine = 'edge-tts' | 'gemini-tts';

export interface VoiceSettings {
  engine: TtsEngine;
  voiceId: string;
  geminiVoice: string;
  pitch: number; // Persentase -15 s/d +25
  rate: number; // Persentase -20 s/d +25
  warmEq: boolean;
}

