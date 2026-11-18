'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Bot,
  KeyRound,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  User,
} from 'lucide-react';
import type {
  ActionLog,
  AssistantProfile,
  ChatMessage,
  VoiceSettings,
} from '@/lib/types';
import {
  type ActiveVoiceEngine,
  type BrowserSpeechRecognition,
  SmartHomeVoicePlayer,
  getSpeechRecognitionConstructor,
  pickBestSmartHomeTranscript,
} from '@/lib/voice';
import AssistantAvatar from './AssistantAvatar';
import ModalDialog from './ModalDialog';
import VoiceWaveVisualizer from './VoiceWaveVisualizer';

interface ChatAssistantProps {
  messages: ChatMessage[];
  assistantProfile: AssistantProfile;
  voiceSettings: VoiceSettings;
  deviceHints?: string[];
  hasApiKey: boolean;
  onOpenApiKeySettings: () => void;
  onMessagesChange: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  onDevicesUpdated: () => Promise<void> | void;
}

type InteractionMode = 'chat' | 'voice';

// Render **bold** dan *italic* ringan menjadi JSX aman tanpa dangerouslySetInnerHTML
function renderFormattedText(text: string) {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={idx} className="italic text-slate-200">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

export default function ChatAssistant({
  messages,
  assistantProfile,
  voiceSettings,
  deviceHints = [],
  hasApiKey,
  onOpenApiKeySettings,
  onMessagesChange,
  onDevicesUpdated,
}: ChatAssistantProps) {
  const assistantName = assistantProfile.name || 'Surya';
  const quickPrompts = [
    `Halo ${assistantName}! Gimana kabar rumah hari ini?`,
    'Sebutkan semua perangkat & statusnya dong',
    'Nyalain semua perangkat sekarang!',
  ];

  const [mode, setMode] = useState<InteractionMode>('chat');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLabel, setStatusLabel] = useState(`${assistantName} sedang mengetik...`);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Voice & Audio visualizer state
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState<ActiveVoiceEngine | null>(null);
  const [mouthLevel, setMouthLevel] = useState(0);
  const [waveBins, setWaveBins] = useState<number[]>([]);
  const [sttSupported, setSttSupported] = useState(false);
  const [micPhase, setMicPhase] = useState<'idle' | 'starting' | 'ready' | 'listening'>('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [lastVoiceActions, setLastVoiceActions] = useState<ActionLog[]>([]);
  const isListening = micPhase !== 'idle';

  const bottomRef = useRef<HTMLDivElement>(null);
  const voicePlayerRef = useRef<SmartHomeVoicePlayer | null>(null);
  const modeRef = useRef<InteractionMode>('chat');
  const genderRef = useRef(assistantProfile.gender);
  const voiceSettingsRef = useRef(voiceSettings);
  const deviceHintsRef = useRef(deviceHints);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');
  const hadSpeechResultRef = useRef(false);
  const cancelledSpeechRef = useRef(false);
  const autoStopTimerRef = useRef<number | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    genderRef.current = assistantProfile.gender;
  }, [assistantProfile.gender]);

  useEffect(() => {
    voiceSettingsRef.current = voiceSettings;
  }, [voiceSettings]);

  useEffect(() => {
    deviceHintsRef.current = deviceHints;
  }, [deviceHints]);

  useEffect(() => {
    voicePlayerRef.current = new SmartHomeVoicePlayer();
    setSttSupported(Boolean(getSpeechRecognitionConstructor()));
    try {
      const savedMode = window.localStorage.getItem('smart-home-interaction-mode');
      if (savedMode === 'voice') {
        setMode('voice');
      }
    } catch {
      // Abaikan jika localStorage tidak tersedia
    }

    return () => {
      if (autoStopTimerRef.current !== null) {
        window.clearTimeout(autoStopTimerRef.current);
      }
      cancelledSpeechRef.current = true;
      voicePlayerRef.current?.stop();
      recognitionRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (mode === 'chat') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, sending, mode]);

  function clearAutoStopTimer() {
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
  }

  function stopVoice() {
    voicePlayerRef.current?.stop(setMouthLevel, setIsSpeaking, setWaveBins);
    setVoiceEngine(null);
  }

  function abortListening() {
    clearAutoStopTimer();
    cancelledSpeechRef.current = true;
    finalTranscriptRef.current = '';
    hadSpeechResultRef.current = false;
    setLiveTranscript('');
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Abaikan jika recognition sudah berhenti
      }
      recognitionRef.current = null;
    }
    setMicPhase('idle');
  }

  function switchMode(nextMode: InteractionMode) {
    if (nextMode === mode) return;
    setErrorMsg(null);

    if (nextMode === 'chat') {
      stopVoice();
      abortListening();
    } else {
      voicePlayerRef.current?.unlock();
    }

    setMode(nextMode);
    try {
      window.localStorage.setItem('smart-home-interaction-mode', nextMode);
    } catch {
      // Abaikan jika storage penuh
    }
  }

  function toggleListening() {
    if (isListening) {
      clearAutoStopTimer();
      recognitionRef.current?.stop();
      return;
    }

    const RecognitionCtor = getSpeechRecognitionConstructor();
    if (!RecognitionCtor) {
      setErrorMsg('Browser ini belum mendukung input suara (coba Chrome atau Edge).');
      return;
    }

    stopVoice();
    clearAutoStopTimer();
    setErrorMsg(null);
    cancelledSpeechRef.current = false;
    finalTranscriptRef.current = '';
    hadSpeechResultRef.current = false;
    setLiveTranscript('');
    setMicPhase('starting');

    const recognition = new RecognitionCtor();
    recognition.lang = 'id-ID';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 5;

    recognition.onstart = () => {
      setMicPhase((prev) => (prev === 'starting' ? 'ready' : prev));
    };

    recognition.onaudiostart = () => {
      setMicPhase((prev) => (prev === 'starting' || prev === 'ready' ? 'ready' : prev));
    };

    recognition.onspeechstart = () => {
      setMicPhase('listening');
    };

    recognition.onresult = (event) => {
      clearAutoStopTimer();
      setMicPhase('listening');

      const parts: string[] = [];
      let allFinal = event.results.length > 0;

      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (!res.isFinal) {
          allFinal = false;
        }
        const segment = (
          res.isFinal
            ? pickBestSmartHomeTranscript(res, deviceHintsRef.current)
            : res[0]?.transcript ?? ''
        ).trim();
        if (segment) {
          parts.push(segment);
        }
      }

      const combined = parts.join(' ').trim();
      if (combined) {
        hadSpeechResultRef.current = true;
        finalTranscriptRef.current = combined;
        setLiveTranscript(combined);
      }

      if (allFinal && combined) {
        // Begitu browser memfinalisasi kalimat, hentikan cepat tanpa menunggu timeout hening 2 detik
        autoStopTimerRef.current = window.setTimeout(() => {
          autoStopTimerRef.current = null;
          try {
            recognition.stop();
          } catch {
            // Abaikan jika recognition sudah berhenti
          }
        }, 280);
      }
    };

    recognition.onerror = (event) => {
      clearAutoStopTimer();
      setMicPhase('idle');
      if (cancelledSpeechRef.current) return;

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setErrorMsg(
          'Izin mikrofon ditolak browser. Aktifkan izin mikrofon untuk memakai perintah suara.'
        );
      } else if (event.error === 'audio-capture') {
        setErrorMsg('Mikrofon tidak terdeteksi atau sedang dipakai aplikasi lain.');
      } else if (event.error === 'network') {
        setErrorMsg('Layanan pengenal suara browser gagal terhubung ke internet.');
      } else if (event.error === 'no-speech' && !hadSpeechResultRef.current) {
        setErrorMsg(
          'Suara belum tertangkap mic. Tunggu status "Silakan Bicara..." lalu ucapkan perintah lebih jelas.'
        );
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setErrorMsg(`Gagal menangkap suara (${event.error}).`);
      }
    };

    recognition.onend = () => {
      clearAutoStopTimer();
      setMicPhase('idle');
      recognitionRef.current = null;

      if (cancelledSpeechRef.current) {
        cancelledSpeechRef.current = false;
        finalTranscriptRef.current = '';
        return;
      }

      const spoken = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = '';
      if (spoken) {
        void sendMessage(spoken);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setMicPhase('idle');
      recognitionRef.current = null;
      setErrorMsg('Gagal menyalakan mikrofon. Coba tekan tombol mic sekali lagi.');
    }
  }

  function handleVoiceStageMicClick() {
    if (sending) return;
    if (isSpeaking) {
      stopVoice();
    }
    toggleListening();
  }

  async function sendMessage(textToSend: string) {
    const trimmed = textToSend.trim();
    if (!trimmed || sending) return;

    const isVoiceTurn = modeRef.current === 'voice';
    if (isVoiceTurn) {
      stopVoice();
      voicePlayerRef.current?.unlock();
    }

    setErrorMsg(null);
    if (!isVoiceTurn) {
      setInput('');
    }
    setLastVoiceActions([]);
    setSending(true);
    setStatusLabel(`${assistantName} sedang berpikir...`);

    const nowIso = new Date().toISOString();
    const tempUserId = `temp-user-${Date.now()}`;
    const tempAsstId = `temp-asst-${Date.now()}`;

    const optimisticUser: ChatMessage = {
      id: tempUserId,
      user_id: '',
      role: 'user',
      content: trimmed,
      actions: [],
      created_at: nowIso,
    };

    const optimisticAssistant: ChatMessage = {
      id: tempAsstId,
      user_id: '',
      role: 'assistant',
      content: '',
      actions: [],
      created_at: nowIso,
    };

    onMessagesChange((prev) => [...prev, optimisticUser, optimisticAssistant]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || 'Gagal mengirim pesan.');
      }

      if (!res.body) {
        throw new Error('Stream respons tidak tersedia.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedText = '';
      let spokenOffset = 0;
      let streamedActions: ActionLog[] = [];
      let receivedDone = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const rawEvent of events) {
          const line = rawEvent
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!line) continue;

          const data = JSON.parse(line.slice(6)) as {
            type: string;
            text?: string;
            actions?: ActionLog[];
            userMessage?: ChatMessage | null;
            assistantMessage?: ChatMessage | null;
            reply?: string;
            error?: string;
          };

          if (data.type === 'status' && data.text) {
            setStatusLabel(data.text);
          } else if (data.type === 'actions' && Array.isArray(data.actions)) {
            streamedActions = [...streamedActions, ...data.actions];
            setLastVoiceActions(streamedActions);
            onMessagesChange((prev) =>
              prev.map((m) =>
                m.id === tempAsstId ? { ...m, actions: streamedActions } : m
              )
            );
            void onDevicesUpdated();
          } else if (data.type === 'delta' && data.text) {
            streamedText += data.text;
            onMessagesChange((prev) =>
              prev.map((m) =>
                m.id === tempAsstId ? { ...m, content: streamedText } : m
              )
            );

            // TTS hanya berjalan saat mode === 'voice' (Mode Chat bebas suara)
            if (
              modeRef.current === 'voice' &&
              voicePlayerRef.current &&
              voiceSettingsRef.current.engine !== 'gemini-tts'
            ) {
              while (true) {
                const unqueued = streamedText.slice(spokenOffset);
                const match = unqueued.match(/^([\s\S]*?(?:[.!?](?=\s)|\n+))/);
                if (!match) break;
                const sentence = match[1];
                if (sentence.trim().length < 8) break;
                spokenOffset += sentence.length;
                voicePlayerRef.current.enqueue({
                  text: sentence,
                  gender: genderRef.current,
                  voiceSettings: voiceSettingsRef.current,
                  onMouthLevel: setMouthLevel,
                  onWaveBins: setWaveBins,
                  onSpeakingChange: setIsSpeaking,
                  onEngineUsed: setVoiceEngine,
                });
              }
            }
          } else if (data.type === 'done') {
            receivedDone = true;
            const finalUser: ChatMessage = data.userMessage ?? optimisticUser;
            const finalAsst: ChatMessage = data.assistantMessage ?? {
              ...optimisticAssistant,
              content: data.reply ?? streamedText,
              actions: data.actions ?? streamedActions,
            };

            if (Array.isArray(finalAsst.actions)) {
              setLastVoiceActions(finalAsst.actions);
            }

            onMessagesChange((prev) =>
              prev.map((m) => {
                if (m.id === tempUserId) return finalUser;
                if (m.id === tempAsstId) return finalAsst;
                return m;
              })
            );

            if (
              modeRef.current === 'voice' &&
              finalAsst.content &&
              voicePlayerRef.current
            ) {
              const remaining = finalAsst.content.slice(spokenOffset).trim();
              if (remaining) {
                voicePlayerRef.current.enqueue({
                  text: remaining,
                  gender: genderRef.current,
                  voiceSettings: voiceSettingsRef.current,
                  onMouthLevel: setMouthLevel,
                  onWaveBins: setWaveBins,
                  onSpeakingChange: setIsSpeaking,
                  onEngineUsed: setVoiceEngine,
                });
              }
            }
          } else if (data.type === 'error') {
            throw new Error(data.error || 'Terjadi kesalahan saat memproses chat.');
          }
        }
      }

      if (!receivedDone && !streamedText) {
        throw new Error('Koneksi terputus sebelum respons selesai.');
      }
    } catch (err) {
      onMessagesChange((prev) =>
        prev.filter((m) => m.id !== tempUserId && m.id !== tempAsstId)
      );
      if (!isVoiceTurn) {
        setInput(trimmed);
      }
      setErrorMsg(
        err instanceof Error ? err.message : 'Terjadi kesalahan saat menghubungi AI.'
      );
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void sendMessage(input);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  async function handleResetChat() {
    stopVoice();
    setResetting(true);
    try {
      const res = await fetch('/api/chat', { method: 'DELETE' });
      if (res.ok) {
        onMessagesChange([]);
        setLastVoiceActions([]);
        setLiveTranscript('');
        setResetOpen(false);
      }
    } finally {
      setResetting(false);
    }
  }

  const engineLabel =
    voiceEngine === 'gemini-tts'
      ? 'Gemini 3.8 TTS'
      : voiceEngine === 'browser-fallback'
        ? 'Suara Browser'
        : 'Edge Neural';

  const voiceVisualState: 'idle' | 'listening' | 'thinking' | 'speaking' = isListening
    ? 'listening'
    : isSpeaking
      ? 'speaking'
      : sending
        ? 'thinking'
        : 'idle';

  const voiceStatusText =
    micPhase === 'starting'
      ? 'Menghubungkan mikrofon...'
      : micPhase === 'ready'
        ? 'Mic aktif — Silakan bicara'
        : micPhase === 'listening'
          ? 'Mendengarkan suara kamu...'
          : sending
            ? statusLabel
            : isSpeaking
              ? `Sedang berbicara (${engineLabel})...`
              : 'Siap mendengarkan — Ketuk mic';

  return (
    <section
      aria-labelledby="chat-heading"
      className="flex h-[52dvh] min-h-[360px] max-h-[460px] flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70 sm:h-[calc(100dvh-7.5rem)] sm:max-h-[560px]"
    >
      {/* Header Asisten + Switch Mode (Chat | Voice) */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 sm:px-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {mode === 'chat' ? (
            <AssistantAvatar
              gender={assistantProfile.gender}
              mouthLevel={0}
              isSpeaking={false}
            />
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
              <AudioLines className="h-4 w-4" aria-hidden="true" />
            </div>
          )}

          <div className="min-w-0">
            <h2
              id="chat-heading"
              className="truncate text-sm font-semibold leading-tight text-white"
            >
              Asisten {assistantName}
            </h2>
            <p className="truncate text-[11px] leading-tight text-slate-400">
              {mode === 'voice'
                ? 'Mode Voice AI • Bicara langsung'
                : `${assistantProfile.gender === 'perempuan' ? 'Perempuan' : 'Laki-laki'} • Mode Chat Teks`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div
            role="group"
            aria-label="Mode asisten"
            className="inline-flex rounded-lg border border-slate-700/90 bg-slate-950/90 p-0.5"
          >
            <button
              type="button"
              aria-pressed={mode === 'chat'}
              onClick={() => switchMode('chat')}
              className="inline-flex min-h-[30px] items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:text-white aria-[pressed=true]:bg-emerald-500 aria-[pressed=true]:font-semibold aria-[pressed=true]:text-slate-950 aria-[pressed=true]:ring-1 aria-[pressed=true]:ring-emerald-400"
            >
              <MessageSquare className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>Chat</span>
            </button>

            <button
              type="button"
              aria-pressed={mode === 'voice'}
              onClick={() => switchMode('voice')}
              className="inline-flex min-h-[30px] items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-400 transition hover:text-white aria-[pressed=true]:bg-emerald-500 aria-[pressed=true]:font-semibold aria-[pressed=true]:text-slate-950 aria-[pressed=true]:ring-1 aria-[pressed=true]:ring-emerald-400"
            >
              <Mic className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>Voice</span>
            </button>
          </div>

          {mode === 'chat' && messages.length > 0 && (
            <button
              type="button"
              onClick={() => setResetOpen(true)}
              aria-label="Reset riwayat obrolan"
              title="Reset riwayat obrolan"
              className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800 hover:text-white sm:px-2.5"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              <span className="hidden sm:inline">Reset</span>
            </button>
          )}
        </div>
      </div>

      {mode === 'chat' ? (
        /* ==================== MODE CHAT (TEKS TANPA SUARA) ==================== */
        <>
          <div className="flex-1 space-y-2.5 overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
            {!hasApiKey && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-100">
                <div className="flex min-w-0 items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                  <span>
                    Kamu belum menambahkan <strong>Gemini API Key</strong>. Tambahkan dulu
                    agar {assistantName} bisa membalas chat!
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onOpenApiKeySettings}
                  className="rounded-md bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-300"
                >
                  Atur API Key
                </button>
              </div>
            )}

            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </div>
                <p className="max-w-xs text-xs font-medium leading-relaxed text-slate-200">
                  Halo! Ini <strong>Mode Chat Teks</strong> dengan {assistantName}. Ketik
                  perintah atau ngobrol santai tanpa suara.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void sendMessage(prompt)}
                      className="rounded-full border border-slate-700 bg-slate-950/70 px-3 py-1.5 text-[11px] text-slate-300 transition hover:border-emerald-500/50 hover:text-emerald-300"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                const isUser = msg.role === 'user';
                const isEmptyStreaming = !isUser && !msg.content && sending;

                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-2 ${
                      isUser ? 'flex-row-reverse' : 'flex-row'
                    }`}
                  >
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                        isUser
                          ? 'bg-sky-500/15 text-sky-300'
                          : 'bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      {isUser ? (
                        <User className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </div>

                    <div
                      className={`min-w-0 max-w-[85%] space-y-1.5 rounded-xl px-3 py-2 text-[13px] leading-snug ${
                        isUser
                          ? 'bg-sky-600 text-white'
                          : 'border border-slate-800 bg-slate-950/80 text-slate-100'
                      }`}
                    >
                      {isEmptyStreaming ? (
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          <span>{statusLabel}</span>
                        </div>
                      ) : (
                        <p className="min-w-0 whitespace-pre-wrap break-words">
                          {renderFormattedText(msg.content)}
                        </p>
                      )}

                      {Array.isArray(msg.actions) && msg.actions.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {msg.actions.map((act, idx) => (
                            <span
                              key={`${act.device_id}-${idx}`}
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                act.is_on
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {act.device_name}: {act.is_on ? 'NYALA' : 'MATI'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            <div ref={bottomRef} />
          </div>

          {errorMsg && (
            <div
              role="status"
              aria-live="polite"
              className="border-t border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200"
            >
              {errorMsg}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2 border-t border-slate-800 bg-slate-950/60 p-2.5"
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="chat-input" className="sr-only">
                Ketik pesan untuk asisten smart home
              </label>
              <textarea
                id="chat-input"
                name="message"
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                enterKeyHint="send"
                placeholder={`Ketik perintah untuk ${assistantName}...`}
                className="max-h-24 min-h-[40px] w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500 sm:min-h-[38px]"
              />
            </div>

            <button
              type="submit"
              disabled={sending || !input.trim()}
              aria-label="Kirim pesan"
              className="inline-flex h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 sm:h-[38px]"
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Kirim</span>
            </button>
          </form>
        </>
      ) : (
        /* ==================== MODE VOICE (AVATAR BESAR + GELOMBANG + MIC) ==================== */
        <div className="relative flex flex-1 flex-col items-center justify-between overflow-y-auto px-4 py-4 text-center">
          {/* Bar Status Atas */}
          <div className="flex w-full flex-col items-center gap-2">
            {!hasApiKey ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-left text-xs text-amber-100">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                  <span>Tambahkan Gemini API Key agar {assistantName} bisa menjawab.</span>
                </div>
                <button
                  type="button"
                  onClick={onOpenApiKeySettings}
                  className="shrink-0 rounded-md bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-amber-300"
                >
                  Atur API Key
                </button>
              </div>
            ) : (
              <div
                role="status"
                aria-live="polite"
                className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${
                  isListening
                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                    : isSpeaking
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                      : sending
                        ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
                        : 'border-slate-800 bg-slate-950/70 text-slate-300'
                }`}
              >
                {sending && !isSpeaking && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                )}
                <span className="truncate">{voiceStatusText}</span>
              </div>
            )}
          </div>

          {/* Panggung Tengah: Avatar Besar + Gelombang Audio + Caption/Aksi Ringkas */}
          <div className="my-auto flex w-full max-w-sm flex-col items-center gap-3 py-2">
            <AssistantAvatar
              gender={assistantProfile.gender}
              mouthLevel={mouthLevel}
              isSpeaking={isSpeaking}
              isListening={isListening}
              isThinking={sending && !isSpeaking}
              size="lg"
            />

            <VoiceWaveVisualizer
              state={voiceVisualState}
              waveBins={waveBins}
              mouthLevel={mouthLevel}
            />

            {/* Teks ucapan sementara saat mic aktif atau aksi perangkat terbaru */}
            <div className="min-h-[24px] w-full space-y-1.5 px-2">
              {liveTranscript && (isListening || sending) && (
                <p className="line-clamp-2 text-xs italic text-slate-300">
                  &ldquo;{liveTranscript}&rdquo;
                </p>
              )}

              {lastVoiceActions.length > 0 && (
                <div className="flex flex-wrap justify-center gap-1">
                  {lastVoiceActions.map((act, idx) => (
                    <span
                      key={`${act.device_id}-${idx}`}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        act.is_on
                          ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30'
                          : 'bg-slate-800 text-slate-300 ring-1 ring-slate-700'
                      }`}
                    >
                      {act.device_name}: {act.is_on ? 'NYALA' : 'MATI'}
                    </span>
                  ))}
                </div>
              )}

              {errorMsg && (
                <p
                  role="status"
                  aria-live="polite"
                  className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-200"
                >
                  {errorMsg}
                </p>
              )}
            </div>
          </div>

          {/* Tombol Mic Utama di Bawah */}
          <div className="flex w-full flex-col items-center gap-2 pt-1">
            {!sttSupported ? (
              <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs text-slate-300">
                <p>Browser ini belum mendukung pengenalan suara (coba Chrome / Edge).</p>
                <button
                  type="button"
                  onClick={() => switchMode('chat')}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
                >
                  <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                  Gunakan Mode Chat Teks
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleVoiceStageMicClick}
                    disabled={sending}
                    aria-pressed={isListening}
                    aria-label={
                      isListening
                        ? 'Selesai berbicara dan kirim perintah'
                        : isSpeaking
                          ? 'Interupsi asisten dan mulai berbicara'
                          : 'Mulai berbicara ke asisten'
                    }
                    className={`relative flex h-16 w-16 items-center justify-center rounded-full shadow-lg transition focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 ${
                      isListening
                        ? 'animate-pulse bg-rose-500 text-white shadow-rose-500/35 ring-4 ring-rose-500/30 hover:bg-rose-400'
                        : sending
                          ? 'bg-slate-800 text-slate-400 ring-1 ring-slate-700'
                          : 'bg-emerald-500 text-slate-950 shadow-emerald-500/30 ring-4 ring-emerald-500/20 hover:bg-emerald-400'
                    }`}
                  >
                    {sending ? (
                      <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
                    ) : isListening ? (
                      <MicOff className="h-7 w-7" aria-hidden="true" />
                    ) : (
                      <Mic className="h-7 w-7" aria-hidden="true" />
                    )}
                  </button>

                  {isSpeaking && (
                    <button
                      type="button"
                      onClick={stopVoice}
                      aria-label="Hentikan suara asisten"
                      className="inline-flex h-11 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/15 px-3.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/25"
                    >
                      <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                      <span>Stop</span>
                    </button>
                  )}
                </div>

                <span className="text-[11px] font-medium text-slate-400">
                  {isListening
                    ? 'Ketuk lagi untuk kirim'
                    : sending
                      ? 'Sedang memproses...'
                      : isSpeaking
                        ? 'Ketuk mic untuk interupsi'
                        : 'Ketuk mic untuk berbicara'}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      <ModalDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset Riwayat Obrolan?"
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300">
            Semua pesan obrolan dengan {assistantName} akan dihapus dan sesi percakapan
            dimulai dari awal. Data ruangan dan perangkatmu tetap aman.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setResetOpen(false)}
              className="min-h-[36px] rounded-lg border border-slate-700 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handleResetChat}
              disabled={resetting}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-60"
            >
              {resetting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Ya, Reset
            </button>
          </div>
        </div>
      </ModalDialog>
    </section>
  );
}
