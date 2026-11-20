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

export interface ActionLog {
  device_id: string;
  device_name: string;
  is_on: boolean;
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

export interface AssistantProfile {
  name: string;
  gender: AssistantGender;
  styles: string[];
  description: string;
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

