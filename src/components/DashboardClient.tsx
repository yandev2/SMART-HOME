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
  Preset,
  Room,
  VoiceSettings,
} from '@/lib/types';
import ApiKeyManager from './ApiKeyManager';
import AssistantSettingsForm from './AssistantSettingsForm';
import ChatAssistant from './ChatAssistant';
import ControllerManager from './ControllerManager';
import DeviceManager from './DeviceManager';
import PresetManager from './PresetManager';
import RoomManager from './RoomManager';
import VoiceSettingsForm from './VoiceSettingsForm';

interface DashboardClientProps {
  userId: string;
  userEmail: string;
  initialRooms: Room[];
  initialControllers: Controller[];
  initialDevices: Device[];
  initialPresets: Preset[];
  initialPresetsTableReady: boolean;
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
  initialPresets,
  initialPresetsTableReady,
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
  const [presets, setPresets] = useState<Preset[]>(initialPresets);
  const [presetsTableReady, setPresetsTableReady] = useState(initialPresetsTableReady);
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
    const [{ data: r }, { data: c }, { data: d }, presetsRes] = await Promise.all([
      supabase.from('rooms').select('*').eq('user_id', userId).order('name'),
      supabase.from('controllers').select('*').eq('user_id', userId).order('name'),
      supabase.from('devices').select('*').eq('user_id', userId).order('name'),
      supabase.from('presets').select('*').eq('user_id', userId).order('name'),
    ]);
    if (r) setRooms(r);
    if (c) setControllers(c);
    if (d) setDevices(d);
    if (!presetsRes.error) {
      setPresetsTableReady(true);
      if (presetsRes.data) setPresets(presetsRes.data);
    }
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'presets', filter: `user_id=eq.${userId}` },
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
      ...presets.flatMap((p) => [p.name, p.keywords].filter(Boolean)),
    ],
    [rooms, devices, presets]
  );

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/90 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:px-4">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                <Home className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-bold leading-tight text-white">
                  {assistantProfile.name} Home AI
                </h1>
                <p className="truncate text-[11px] leading-tight text-slate-400">
                  {userEmail}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Keluar dari akun"
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-700/80 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white sm:hidden"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Keluar</span>
            </button>
          </div>

          <nav
            aria-label="Menu utama"
            className="grid w-full grid-cols-4 gap-1 border-t border-slate-800/80 pt-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:border-t-0 sm:pt-0"
          >
            <button
              type="button"
              onClick={() => setActiveTab('assistant')}
              aria-current={activeTab === 'assistant' ? 'page' : undefined}
              className={`inline-flex min-h-[40px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 text-[11px] font-medium transition sm:min-h-[34px] sm:flex-row sm:gap-1.5 sm:px-2.5 sm:text-xs ${
                activeTab === 'assistant'
                  ? 'bg-emerald-500 font-semibold text-slate-950 ring-1 ring-emerald-400'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Asisten &amp; Perangkat</span>
              <span aria-hidden="true" className="max-w-full truncate sm:hidden">
                Asisten
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('rooms')}
              aria-current={activeTab === 'rooms' ? 'page' : undefined}
              className={`inline-flex min-h-[40px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 text-[11px] font-medium transition sm:min-h-[34px] sm:flex-row sm:gap-1.5 sm:px-2.5 sm:text-xs ${
                activeTab === 'rooms'
                  ? 'bg-emerald-500 font-semibold text-slate-950 ring-1 ring-emerald-400'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <DoorOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Ruangan ({rooms.length})</span>
              <span aria-hidden="true" className="max-w-full truncate sm:hidden">
                Ruangan
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('controllers')}
              aria-current={activeTab === 'controllers' ? 'page' : undefined}
              className={`inline-flex min-h-[40px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 text-[11px] font-medium transition sm:min-h-[34px] sm:flex-row sm:gap-1.5 sm:px-2.5 sm:text-xs ${
                activeTab === 'controllers'
                  ? 'bg-emerald-500 font-semibold text-slate-950 ring-1 ring-emerald-400'
                  : 'text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">NodeMCU ({controllers.length})</span>
              <span aria-hidden="true" className="max-w-full truncate sm:hidden">
                NodeMCU
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              className={`relative inline-flex min-h-[40px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 text-[11px] font-medium transition sm:min-h-[34px] sm:flex-row sm:gap-1.5 sm:px-2.5 sm:text-xs ${
                activeTab === 'settings'
                  ? 'bg-emerald-500 font-semibold text-slate-950 ring-1 ring-emerald-400'
                  : hasApiKey
                    ? 'text-slate-300 hover:bg-slate-800'
                    : 'border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
              }`}
            >
              <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">
                Pengaturan {!hasApiKey && '(API Key Kosong)'}
              </span>
              <span aria-hidden="true" className="max-w-full truncate sm:hidden">
                Setelan
              </span>
              {!hasApiKey && (
                <span
                  aria-hidden="true"
                  className="absolute right-2 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400 sm:hidden"
                />
              )}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              className="hidden min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-700/80 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white sm:inline-flex"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Keluar</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-3 py-3 sm:px-4 sm:py-4">
        {activeTab === 'assistant' && (
          <div className="grid items-start gap-4 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-6">
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
            <div className="min-w-0 space-y-5 lg:col-span-6">
              <PresetManager
                userId={userId}
                rooms={rooms}
                devices={devices}
                presets={presets}
                tableReady={presetsTableReady}
                onChanged={refreshData}
              />
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
            <div className="min-w-0 space-y-6">
              <AssistantSettingsForm
                initialProfile={assistantProfile}
                onProfileChanged={handleProfileChanged}
              />
            </div>
            <div className="min-w-0 space-y-6">
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
