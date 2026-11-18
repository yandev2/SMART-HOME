'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Bot,
  KeyRound,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  User,
  Volume2,
  VolumeX,
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
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusLabel, setStatusLabel] = useState(`${assistantName} sedang mengetik...`);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Voice (STT + Edge TTS + Fallback browser + Lip-sync)
  const [voiceAutoPlay, setVoiceAutoPlay] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState<ActiveVoiceEngine | null>(null);
  const [mouthLevel, setMouthLevel] = useState(0);
  const [sttSupported, setSttSupported] = useState(false);
  const [micPhase, setMicPhase] = useState<'idle' | 'starting' | 'ready' | 'listening'>('idle');
  const isListening = micPhase !== 'idle';

  const bottomRef = useRef<HTMLDivElement>(null);
  const voicePlayerRef = useRef<SmartHomeVoicePlayer | null>(null);
  const voiceAutoPlayRef = useRef(true);
  const genderRef = useRef(assistantProfile.gender);
  const voiceSettingsRef = useRef(voiceSettings);
  const deviceHintsRef = useRef(deviceHints);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const finalTranscriptRef = useRef('');
  const hadSpeechResultRef = useRef(false);
  const autoStopTimerRef = useRef<number | null>(null);

  useEffect(() => {
    voiceAutoPlayRef.current = voiceAutoPlay;
  }, [voiceAutoPlay]);

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
    const saved = window.localStorage.getItem('smart-home-voice-autoplay');
    if (saved === 'false') {
      setVoiceAutoPlay(false);
    }

    return () => {
      if (autoStopTimerRef.current !== null) {
        window.clearTimeout(autoStopTimerRef.current);
      }
      voicePlayerRef.current?.stop();
      recognitionRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  function speakText(text: string) {
    if (!text.trim() || !voicePlayerRef.current) return;
    voicePlayerRef.current.unlock();
    voicePlayerRef.current.speak({
      text,
      gender: genderRef.current,
      voiceSettings: voiceSettingsRef.current,
      onMouthLevel: setMouthLevel,
      onSpeakingChange: setIsSpeaking,
      onEngineUsed: setVoiceEngine,
    });
  }

  function stopVoice() {
    voicePlayerRef.current?.stop(setMouthLevel, setIsSpeaking);
    setVoiceEngine(null);
  }

  function toggleVoiceAutoPlay() {
    setVoiceAutoPlay((prev) => {
      const next = !prev;
      window.localStorage.setItem('smart-home-voice-autoplay', String(next));
      if (!next) {
        stopVoice();
      }
      return next;
    });
  }

  function clearAutoStopTimer() {
    if (autoStopTimerRef.current !== null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
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
    finalTranscriptRef.current = '';
    hadSpeechResultRef.current = false;
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
        setInput(combined);
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
          'Suara belum tertangkap mic. Tunggu tulisan "Mic aktif!" lalu bicara lebih jelas/dekat.'
        );
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setErrorMsg(`Gagal menangkap suara (${event.error}).`);
      }
    };

    recognition.onend = () => {
      clearAutoStopTimer();
      setMicPhase('idle');
      recognitionRef.current = null;
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

  async function sendMessage(textToSend: string) {
    const trimmed = textToSend.trim();
    if (!trimmed || sending) return;

    if (voiceAutoPlayRef.current) {
      stopVoice();
      voicePlayerRef.current?.unlock();
    }

    setErrorMsg(null);
    setInput('');
    setSending(true);
    setStatusLabel(`${assistantName} sedang mengetik...`);

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

            // Pipelining per kalimat hanya untuk Edge Neural; Gemini TTS dikirim 1x utuh di 'done' agar hemat kuota
            if (
              voiceAutoPlayRef.current &&
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

            onMessagesChange((prev) =>
              prev.map((m) => {
                if (m.id === tempUserId) return finalUser;
                if (m.id === tempAsstId) return finalAsst;
                return m;
              })
            );

            if (voiceAutoPlayRef.current && finalAsst.content && voicePlayerRef.current) {
              const remaining = finalAsst.content.slice(spokenOffset).trim();
              if (remaining) {
                voicePlayerRef.current.enqueue({
                  text: remaining,
                  gender: genderRef.current,
                  voiceSettings: voiceSettingsRef.current,
                  onMouthLevel: setMouthLevel,
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
      setInput(trimmed);
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
        setResetOpen(false);
      }
    } finally {
      setResetting(false);
    }
  }

  return (
    <section
      aria-labelledby="chat-heading"
      className="flex h-[calc(100vh-6.25rem)] min-h-[420px] max-h-[560px] flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <AssistantAvatar
            gender={assistantProfile.gender}
            mouthLevel={mouthLevel}
            isSpeaking={isSpeaking}
          />
          <div className="min-w-0">
            <h2
              id="chat-heading"
              className="truncate text-sm font-semibold leading-tight text-white"
            >
              Asisten {assistantName}
            </h2>
            <p className="truncate text-[11px] leading-tight text-slate-400">
              {isSpeaking
                ? voiceEngine === 'gemini-tts'
                  ? 'Sedang berbicara (Gemini 3.8 TTS)...'
                  : voiceEngine === 'browser-fallback'
                    ? 'Sedang berbicara (Suara Browser)...'
                    : 'Sedang berbicara (Edge Neural)...'
                : `${assistantProfile.gender === 'perempuan' ? 'Perempuan' : 'Laki-laki'} • ${assistantProfile.styles.join(', ')}`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {isSpeaking && (
            <button
              type="button"
              onClick={stopVoice}
              aria-label="Hentikan suara asisten"
              className="inline-flex min-h-[30px] items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              Stop
            </button>
          )}

          <button
            type="button"
            onClick={toggleVoiceAutoPlay}
            aria-pressed={voiceAutoPlay}
            title={voiceAutoPlay ? 'Matikan suara otomatis' : 'Aktifkan suara otomatis'}
            className={`inline-flex min-h-[30px] items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
              voiceAutoPlay
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white'
            }`}
          >
            {voiceAutoPlay ? (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">Suara</span>
          </button>

          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setResetOpen(true)}
              className="inline-flex min-h-[30px] items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {!hasApiKey && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-100">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
              <span>
                Kamu belum menambahkan <strong>Gemini API Key</strong>. Tambahkan dulu agar{' '}
                {assistantName} bisa membalas chat!
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
              Halo! Aku {assistantName}, asisten smart home kamu. Mau ngobrol santai, cek
              status lampu, atau kontrol perangkat? Tinggal bilang aja!
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
                  className={`max-w-[84%] space-y-1.5 rounded-xl px-3 py-2 text-[13px] leading-snug ${
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
                    <div className="flex items-start gap-2">
                      <p className="flex-1 whitespace-pre-wrap">
                        {renderFormattedText(msg.content)}
                      </p>
                      {!isUser && msg.content && (
                        <button
                          type="button"
                          onClick={() => speakText(msg.content)}
                          aria-label="Putar suara balasan ini"
                          title="Putar suara"
                          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-emerald-300"
                        >
                          <Volume2 className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>
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
        <div className="flex-1">
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
            placeholder={
              micPhase === 'starting'
                ? 'Menghubungkan mikrofon...'
                : micPhase === 'ready'
                  ? 'Mic aktif! Silakan bicara sekarang...'
                  : micPhase === 'listening'
                    ? 'Mendengarkan suara kamu...'
                    : 'Ketik atau tekan mic untuk perintah suara...'
            }
            className="max-h-24 min-h-[38px] w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500"
          />
        </div>
        {sttSupported && (
          <button
            type="button"
            onClick={toggleListening}
            disabled={sending}
            aria-pressed={isListening}
            aria-label={isListening ? 'Hentikan rekaman suara' : 'Bicara lewat mikrofon'}
            title={isListening ? 'Berhenti mendengarkan' : 'Perintah suara (STT)'}
            className={`inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border transition disabled:opacity-50 ${
              isListening
                ? 'animate-pulse border-rose-500 bg-rose-500/20 text-rose-300'
                : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            {isListening ? (
              <MicOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Mic className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
        <button
          type="submit"
          disabled={sending || !input.trim()}
          aria-label="Kirim pesan"
          className="inline-flex h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Kirim</span>
        </button>
      </form>

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
