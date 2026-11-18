'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cpu, DoorOpen, Home, LogOut, MessageSquare, Settings } from 'lucide-react';
import {
  GEMINI_VOICE_OPTIONS,
  VOICE_OPTIONS,
  getDefaultVoiceSettings,
} from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import type {
  AssistantProfile,
  ChatMessage,
  Controller,
  Device,
  Room,
  VoiceSettings,
} from '@/lib/types';
import ApiKeyManager from './ApiKeyManager';
import AssistantSettingsForm from './AssistantSettingsForm';
import ChatAssistant from './ChatAssistant';
import ControllerManager from './ControllerManager';
import DeviceManager from './DeviceManager';
import RoomManager from './RoomManager';
import VoiceSettingsForm from './VoiceSettingsForm';

interface DashboardClientProps {
  userId: string;
  userEmail: string;
  initialRooms: Room[];
  initialControllers: Controller[];
  initialDevices: Device[];
  initialMessages: ChatMessage[];
  initialHasApiKey: boolean;
  initialMaskedApiKey: string | null;
  initialAssistantProfile: AssistantProfile;
}

type TabKey = 'assistant' | 'rooms' | 'controllers' | 'settings';

export default function DashboardClient({
  userId,
  userEmail,
  initialRooms,
  initialControllers,
  initialDevices,
  initialMessages,
  initialHasApiKey,
  initialMaskedApiKey,
  initialAssistantProfile,
}: DashboardClientProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>('assistant');
  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [controllers, setControllers] = useState<Controller[]>(initialControllers);
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [hasApiKey, setHasApiKey] = useState(initialHasApiKey);
  const [maskedApiKey, setMaskedApiKey] = useState<string | null>(initialMaskedApiKey);
  const [assistantProfile, setAssistantProfile] = useState<AssistantProfile>(
    initialAssistantProfile
  );
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(() =>
    getDefaultVoiceSettings(initialAssistantProfile.gender)
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('smart-home-voice-settings');
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
        const defaults = getDefaultVoiceSettings(initialAssistantProfile.gender);
        setVoiceSettings({
          engine: parsed.engine === 'gemini-tts' ? 'gemini-tts' : 'edge-tts',
          voiceId:
            typeof parsed.voiceId === 'string' &&
            VOICE_OPTIONS.some((v) => v.id === parsed.voiceId)
              ? parsed.voiceId
              : defaults.voiceId,
          geminiVoice:
            typeof parsed.geminiVoice === 'string' &&
            GEMINI_VOICE_OPTIONS.some((v) => v.id === parsed.geminiVoice)
              ? parsed.geminiVoice
              : defaults.geminiVoice,
          pitch:
            typeof parsed.pitch === 'number' ? parsed.pitch : defaults.pitch,
          rate: typeof parsed.rate === 'number' ? parsed.rate : defaults.rate,
          warmEq:
            typeof parsed.warmEq === 'boolean' ? parsed.warmEq : defaults.warmEq,
        });
      }
    } catch {
      // Abaikan jika localStorage tidak valid
    }
  }, [initialAssistantProfile.gender]);

  function updateVoiceSettings(next: VoiceSettings) {
    setVoiceSettings(next);
    try {
      window.localStorage.setItem('smart-home-voice-settings', JSON.stringify(next));
    } catch {
      // Abaikan jika storage penuh
    }
  }

  function handleProfileChanged(nextProfile: AssistantProfile) {
    setAssistantProfile(nextProfile);
    // Jika gender asisten berubah, sesuaikan default voice bila model suara sebelumnya berlawanan gender
    const currentEdge = VOICE_OPTIONS.find((v) => v.id === voiceSettings.voiceId);
    const currentGemini = GEMINI_VOICE_OPTIONS.find(
      (v) => v.id === voiceSettings.geminiVoice
    );
    const nextDefaults = getDefaultVoiceSettings(nextProfile.gender);
    const needEdgeSwap = currentEdge && currentEdge.gender !== nextProfile.gender;
    const needGeminiSwap = currentGemini && currentGemini.gender !== nextProfile.gender;

    if (needEdgeSwap || needGeminiSwap) {
      updateVoiceSettings({
        ...voiceSettings,
        ...(needEdgeSwap
          ? { voiceId: nextDefaults.voiceId, pitch: nextDefaults.pitch }
          : {}),
        ...(needGeminiSwap ? { geminiVoice: nextDefaults.geminiVoice } : {}),
      });
    }
  }

  const refreshData = useCallback(async () => {
    const supabase = createClient();
    const [{ data: r }, { data: c }, { data: d }] = await Promise.all([
      supabase.from('rooms').select('*').eq('user_id', userId).order('name'),
      supabase.from('controllers').select('*').eq('user_id', userId).order('name'),
      supabase.from('devices').select('*').eq('user_id', userId).order('name'),
    ]);
    if (r) setRooms(r);
    if (c) setControllers(c);
    if (d) setDevices(d);
  }, [userId]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`smart-home-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'devices', filter: `user_id=eq.${userId}` },
        () => {
          void refreshData();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'controllers',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void refreshData();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `user_id=eq.${userId}` },
        () => {
          void refreshData();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, refreshData]);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  const deviceHints = useMemo(
    () => [
      ...rooms.map((r) => r.name),
      ...devices.flatMap((d) => [d.name, d.aliases].filter(Boolean)),
    ],
    [rooms, devices]
  );

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/90 bg-slate-900/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
              <Home className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-tight text-white">
                {assistantProfile.name} Home AI
              </h1>
              <p className="text-[11px] leading-tight text-slate-400">{userEmail}</p>
            </div>
          </div>

          <nav aria-label="Menu utama" className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('assistant')}
              className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                activeTab === 'assistant'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              Asisten &amp; Perangkat
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('rooms')}
              className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                activeTab === 'rooms'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <DoorOpen className="h-3.5 w-3.5" aria-hidden="true" />
              Ruangan ({rooms.length})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('controllers')}
              className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                activeTab === 'controllers'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
              NodeMCU ({controllers.length})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                activeTab === 'settings'
                  ? 'bg-emerald-500 text-slate-950'
                  : hasApiKey
                    ? 'text-slate-300 hover:bg-slate-800'
                    : 'border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
              }`}
            >
              <Settings className="h-3.5 w-3.5" aria-hidden="true" />
              Pengaturan {!hasApiKey && '(API Key Kosong)'}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-slate-700/80 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Keluar</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        {activeTab === 'assistant' && (
          <div className="grid items-start gap-4 lg:grid-cols-12">
            <div className="lg:col-span-6">
              <ChatAssistant
                messages={messages}
                assistantProfile={assistantProfile}
                voiceSettings={voiceSettings}
                deviceHints={deviceHints}
                hasApiKey={hasApiKey}
                onOpenApiKeySettings={() => setActiveTab('settings')}
                onMessagesChange={setMessages}
                onDevicesUpdated={refreshData}
              />
            </div>
            <div className="lg:col-span-6">
              <DeviceManager
                userId={userId}
                rooms={rooms}
                controllers={controllers}
                devices={devices}
                onChanged={refreshData}
              />
            </div>
          </div>
        )}

        {activeTab === 'rooms' && (
          <RoomManager
            userId={userId}
            rooms={rooms}
            devices={devices}
            onChanged={refreshData}
          />
        )}

        {activeTab === 'controllers' && (
          <ControllerManager
            userId={userId}
            controllers={controllers}
            devices={devices}
            onChanged={refreshData}
          />
        )}

        {activeTab === 'settings' && (
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <div className="space-y-6">
              <AssistantSettingsForm
                initialProfile={assistantProfile}
                onProfileChanged={handleProfileChanged}
              />
            </div>
            <div className="space-y-6">
              <VoiceSettingsForm
                assistantName={assistantProfile.name}
                gender={assistantProfile.gender}
                hasApiKey={hasApiKey}
                voiceSettings={voiceSettings}
                onChange={updateVoiceSettings}
              />
              <ApiKeyManager
                assistantName={assistantProfile.name}
                initialHasKey={hasApiKey}
                initialMaskedKey={maskedApiKey}
                onStatusChanged={(nextHas, nextMasked) => {
                  setHasApiKey(nextHas);
                  setMaskedApiKey(nextMasked);
                }}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
