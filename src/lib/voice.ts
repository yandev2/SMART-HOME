'use client';

import { getDefaultVoiceSettings } from './constants';
import type { AssistantGender, TtsEngine, VoiceSettings } from './types';

export type ActiveVoiceEngine = TtsEngine | 'browser-fallback';

export const VOICE_WAVE_BANDS = 12;

export function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/`+/g, '')
    .replace(/[*_~#>]+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/\.\.\./g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitIntoSentences(raw: string): string[] {
  const parts = raw
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [raw.trim()].filter(Boolean);
}

export interface SpeechRecognitionAlternative {
  transcript: string;
  confidence?: number;
}

export interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}

export interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

export interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

const SMART_HOME_STT_KEYWORDS = [
  'nyalakan',
  'nyalain',
  'nyala',
  'hidupkan',
  'hidupin',
  'matikan',
  'matiin',
  'mati',
  'padamkan',
  'lampu',
  'kipas',
  'saklar',
  'perangkat',
  'ruangan',
  'kamar',
  'teras',
  'semua',
  'status',
  'cek',
];

/**
 * Memilih kandidat transkrip terbaik dari beberapa alternatif SpeechRecognition
 * dengan memberi bobot lebih pada kecocokan nama perangkat, ruangan, dan kata perintah.
 */
export function pickBestSmartHomeTranscript(
  result: SpeechRecognitionResult,
  domainHints: string[] = []
): string {
  const count = typeof result.length === 'number' && result.length > 0 ? result.length : 1;
  const fallback = result[0]?.transcript ?? '';
  if (count === 1) return fallback;

  const keywords = new Set<string>(SMART_HOME_STT_KEYWORDS);
  for (const hint of domainHints) {
    for (const token of hint.toLowerCase().split(/\s+/)) {
      const cleaned = token.replace(/[^a-z0-9]/g, '');
      if (cleaned.length >= 2) {
        keywords.add(cleaned);
      }
    }
  }

  let bestTranscript = fallback;
  let bestScore = -1;

  for (let i = 0; i < count; i++) {
    const candidate = result[i]?.transcript ?? '';
    if (!candidate.trim()) continue;

    const words = candidate
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter(Boolean);

    let score = (count - i) * 0.25;
    if (typeof result[i]?.confidence === 'number') {
      score += result[i].confidence! * 0.5;
    }

    for (const word of words) {
      if (keywords.has(word)) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTranscript = candidate;
    }
  }

  return bestTranscript;
}

export function getSpeechRecognitionConstructor():
  | (new () => BrowserSpeechRecognition)
  | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

interface DecodedAudioResult {
  buffer: AudioBuffer;
  engine: TtsEngine;
}

interface QueuedAudioItem {
  text: string;
  gender: AssistantGender;
  voiceSettings: VoiceSettings;
  audioPromise: Promise<DecodedAudioResult | null>;
}

interface ActivePcmStreamGraph {
  runId: number;
  inputNode: AudioNode;
  analyser: AnalyserNode;
  sources: Set<AudioBufferSourceNode>;
  nextStartTime: number;
  streamCompleted: boolean;
}

export class SmartHomeVoicePlayer {
  private audioContext: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private rafId: number | null = null;
  private pcmGraph: ActivePcmStreamGraph | null = null;
  private abortController: AbortController | null = null;
  private activeRunId = 0;
  private queue: QueuedAudioItem[] = [];
  private isProcessingQueue = false;

  private ensureAudioContext(): AudioContext {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
    return this.audioContext;
  }

  unlock() {
    if (typeof window === 'undefined') return;
    try {
      this.ensureAudioContext();
    } catch {
      // Abaikan jika belum diizinkan
    }
  }

  stop(
    onMouthLevel?: (level: number) => void,
    onSpeakingChange?: (speaking: boolean) => void,
    onWaveBins?: (bins: number[]) => void
  ) {
    this.activeRunId += 1;
    this.queue = [];
    this.isProcessingQueue = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {
        // Abaikan jika source sudah selesai
      }
      this.activeSource = null;
    }

    if (this.pcmGraph) {
      for (const src of this.pcmGraph.sources) {
        try {
          src.onended = null;
          src.stop();
          src.disconnect();
        } catch {
          // Abaikan
        }
      }
      this.pcmGraph.sources.clear();
      try {
        this.pcmGraph.analyser.disconnect();
      } catch {
        // Abaikan
      }
      this.pcmGraph = null;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    onMouthLevel?.(0);
    onWaveBins?.([]);
    onSpeakingChange?.(false);
  }

  private ensurePcmGraph(
    runId: number,
    warmEq: boolean,
    onMouthLevel: (level: number) => void,
    onSpeakingChange: (speaking: boolean) => void,
    onEngineUsed?: (engine: ActiveVoiceEngine) => void,
    onWaveBins?: (bins: number[]) => void
  ): ActivePcmStreamGraph {
    if (this.pcmGraph && this.pcmGraph.runId === runId) {
      return this.pcmGraph;
    }

    const ctx = this.ensureAudioContext();
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;

    let inputNode: AudioNode = analyser;

    if (warmEq) {
      const lowWarmth = ctx.createBiquadFilter();
      lowWarmth.type = 'lowshelf';
      lowWarmth.frequency.value = 180;
      lowWarmth.gain.value = 3.5;

      const deHarsh = ctx.createBiquadFilter();
      deHarsh.type = 'peaking';
      deHarsh.frequency.value = 3200;
      deHarsh.Q.value = 1.2;
      deHarsh.gain.value = -2.5;

      const airSilk = ctx.createBiquadFilter();
      airSilk.type = 'highshelf';
      airSilk.frequency.value = 7500;
      airSilk.gain.value = 2.0;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 12;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.15;

      lowWarmth.connect(deHarsh);
      deHarsh.connect(airSilk);
      airSilk.connect(compressor);
      compressor.connect(analyser);
      inputNode = lowWarmth;
    }

    analyser.connect(ctx.destination);

    const graph: ActivePcmStreamGraph = {
      runId,
      inputNode,
      analyser,
      sources: new Set(),
      nextStartTime: 0,
      streamCompleted: false,
    };
    this.pcmGraph = graph;

    onEngineUsed?.('gemini-tts');
    onSpeakingChange(true);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const freqArray = onWaveBins ? new Uint8Array(analyser.frequencyBinCount) : null;

    const tick = () => {
      if (this.activeRunId !== runId || this.pcmGraph !== graph) return;
      analyser.getByteTimeDomainData(dataArray);
      let sumSq = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSq += normalized * normalized;
      }
      const rms = Math.sqrt(sumSq / dataArray.length);
      const level = Math.min(1, Math.max(0, rms * 4.2));
      onMouthLevel(level);

      if (onWaveBins && freqArray) {
        analyser.getByteFrequencyData(freqArray);
        const bands: number[] = [];
        for (let b = 0; b < VOICE_WAVE_BANDS; b++) {
          const binStart = 1 + b * 2;
          const binEnd = Math.min(freqArray.length - 1, binStart + 1);
          const avg = (freqArray[binStart] + freqArray[binEnd]) / (2 * 255);
          bands.push(Math.min(1, Math.pow(avg, 0.85) * 1.25));
        }
        onWaveBins(bands);
      }

      this.rafId = requestAnimationFrame(tick);
    };

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = requestAnimationFrame(tick);

    return graph;
  }

  private finalizePcmGraphIfIdle(
    runId: number,
    onMouthLevel: (level: number) => void,
    onSpeakingChange: (speaking: boolean) => void,
    onWaveBins?: (bins: number[]) => void
  ) {
    if (this.activeRunId !== runId || !this.pcmGraph || this.pcmGraph.runId !== runId) {
      return;
    }
    if (this.pcmGraph.streamCompleted && this.pcmGraph.sources.size === 0) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      try {
        this.pcmGraph.analyser.disconnect();
      } catch {
        // Abaikan
      }
      this.pcmGraph = null;
      onMouthLevel(0);
      onWaveBins?.([]);
      onSpeakingChange(false);
    }
  }

  /**
   * Memutar chunk audio PCM 16-bit signed little-endian (24kHz mono) secara real-time
   * langsung dari stream Gemini 3.8 Live tanpa jeda dan tanpa request tambahan ke /api/tts.
   */
  enqueuePcmChunk(params: {
    base64Pcm: string;
    sampleRate?: number;
    voiceSettings?: VoiceSettings;
    onMouthLevel: (level: number) => void;
    onWaveBins?: (bins: number[]) => void;
    onSpeakingChange: (speaking: boolean) => void;
    onEngineUsed?: (engine: ActiveVoiceEngine) => void;
  }) {
    if (typeof window === 'undefined' || !params.base64Pcm) return;

    try {
      const binary = window.atob(params.base64Pcm);
      const sampleCount = Math.floor(binary.length / 2);
      if (sampleCount <= 0) return;

      const ctx = this.ensureAudioContext();
      const sampleRate = params.sampleRate ?? 24000;
      const audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < sampleCount; i++) {
        const lo = binary.charCodeAt(i * 2);
        const hi = binary.charCodeAt(i * 2 + 1);
        const int16 = (hi << 8) | lo;
        const signed = int16 >= 0x8000 ? int16 - 0x10000 : int16;
        channelData[i] = signed / 32768;
      }

      const runId = this.activeRunId;
      const warmEq = params.voiceSettings?.warmEq ?? true;
      const graph = this.ensurePcmGraph(
        runId,
        warmEq,
        params.onMouthLevel,
        params.onSpeakingChange,
        params.onEngineUsed,
        params.onWaveBins
      );

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(graph.inputNode);

      const now = ctx.currentTime;
      // Buffer awal 45ms untuk menyambung chunk secara sample-accurate tanpa klik/gap
      const startAt = graph.nextStartTime <= now ? now + 0.045 : graph.nextStartTime;
      graph.nextStartTime = startAt + audioBuffer.duration;
      graph.sources.add(source);

      source.onended = () => {
        graph.sources.delete(source);
        try {
          source.disconnect();
        } catch {
          // Abaikan
        }
        this.finalizePcmGraphIfIdle(
          runId,
          params.onMouthLevel,
          params.onSpeakingChange,
          params.onWaveBins
        );
      };

      source.start(startAt);
    } catch {
      // Abaikan chunk korup bila ada
    }
  }

  completePcmStream(
    onMouthLevel: (level: number) => void,
    onSpeakingChange: (speaking: boolean) => void,
    onWaveBins?: (bins: number[]) => void
  ) {
    if (!this.pcmGraph) return;
    this.pcmGraph.streamCompleted = true;
    this.finalizePcmGraphIfIdle(
      this.pcmGraph.runId,
      onMouthLevel,
      onSpeakingChange,
      onWaveBins
    );
  }

  enqueue(params: {
    text: string;
    gender: AssistantGender;
    voiceSettings?: VoiceSettings;
    onMouthLevel: (level: number) => void;
    onWaveBins?: (bins: number[]) => void;
    onSpeakingChange: (speaking: boolean) => void;
    onEngineUsed?: (engine: ActiveVoiceEngine) => void;
  }) {
    const cleaned = cleanTextForSpeech(params.text);
    if (!cleaned) return;

    if (!this.abortController) {
      this.abortController = new AbortController();
    }
    const signal = this.abortController.signal;
    const runId = this.activeRunId;
    const settings = params.voiceSettings ?? getDefaultVoiceSettings(params.gender);

    const audioPromise = this.fetchAndDecodeAudio(
      cleaned,
      params.gender,
      settings,
      signal,
      runId
    );

    this.queue.push({
      text: cleaned,
      gender: params.gender,
      voiceSettings: settings,
      audioPromise,
    });

    if (!this.isProcessingQueue) {
      void this.processQueue(
        runId,
        params.onMouthLevel,
        params.onSpeakingChange,
        params.onEngineUsed,
        params.onWaveBins
      );
    }
  }

  speak(params: {
    text: string;
    gender: AssistantGender;
    voiceSettings?: VoiceSettings;
    onMouthLevel: (level: number) => void;
    onWaveBins?: (bins: number[]) => void;
    onSpeakingChange: (speaking: boolean) => void;
    onEngineUsed?: (engine: ActiveVoiceEngine) => void;
  }) {
    this.stop(params.onMouthLevel, params.onSpeakingChange, params.onWaveBins);
    const settings = params.voiceSettings ?? getDefaultVoiceSettings(params.gender);

    // Untuk Gemini 3.8 TTS, kirim 1 request per balasan agar hemat kuota API Key user
    if (settings.engine === 'gemini-tts') {
      this.enqueue({
        text: params.text,
        gender: params.gender,
        voiceSettings: settings,
        onMouthLevel: params.onMouthLevel,
        onWaveBins: params.onWaveBins,
        onSpeakingChange: params.onSpeakingChange,
        onEngineUsed: params.onEngineUsed,
      });
      return;
    }

    const sentences = splitIntoSentences(params.text);
    for (const sentence of sentences) {
      this.enqueue({
        text: sentence,
        gender: params.gender,
        voiceSettings: settings,
        onMouthLevel: params.onMouthLevel,
        onWaveBins: params.onWaveBins,
        onSpeakingChange: params.onSpeakingChange,
        onEngineUsed: params.onEngineUsed,
      });
    }
  }

  private async fetchAndDecodeAudio(
    text: string,
    gender: AssistantGender,
    voiceSettings: VoiceSettings,
    signal: AbortSignal,
    runId: number
  ): Promise<DecodedAudioResult | null> {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          gender,
          engine: voiceSettings.engine,
          voiceId: voiceSettings.voiceId,
          geminiVoice: voiceSettings.geminiVoice,
          pitch: voiceSettings.pitch,
          rate: voiceSettings.rate,
        }),
        signal,
      });

      if (!res.ok || runId !== this.activeRunId) {
        return null;
      }

      const engineHeader = res.headers.get('x-tts-engine');
      const usedEngine: TtsEngine =
        engineHeader === 'gemini-tts' ? 'gemini-tts' : 'edge-tts';

      const arrayBuffer = await res.arrayBuffer();
      if (runId !== this.activeRunId) return null;

      const ctx = this.ensureAudioContext();
      const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      return { buffer, engine: usedEngine };
    } catch {
      return null;
    }
  }

  private async processQueue(
    runId: number,
    onMouthLevel: (level: number) => void,
    onSpeakingChange: (speaking: boolean) => void,
    onEngineUsed?: (engine: ActiveVoiceEngine) => void,
    onWaveBins?: (bins: number[]) => void
  ) {
    this.isProcessingQueue = true;
    onSpeakingChange(true);

    try {
      while (this.queue.length > 0 && runId === this.activeRunId) {
        const item = this.queue.shift();
        if (!item) continue;

        const decoded = await item.audioPromise;
        if (runId !== this.activeRunId) break;

        if (decoded) {
          onEngineUsed?.(decoded.engine);
          await this.playAudioBuffer(
            decoded.buffer,
            item.voiceSettings.warmEq,
            runId,
            onMouthLevel,
            onWaveBins
          );
        } else {
          onEngineUsed?.('browser-fallback');
          await this.playBrowserFallback(
            item.text,
            item.gender,
            item.voiceSettings,
            runId,
            onMouthLevel,
            onWaveBins
          );
        }
      }
    } finally {
      if (runId === this.activeRunId) {
        this.isProcessingQueue = false;
        onMouthLevel(0);
        onWaveBins?.([]);
        onSpeakingChange(false);
      }
    }
  }

  private playAudioBuffer(
    audioBuffer: AudioBuffer,
    warmEq: boolean,
    runId: number,
    onMouthLevel: (level: number) => void,
    onWaveBins?: (bins: number[]) => void
  ): Promise<void> {
    return new Promise((resolve) => {
      if (runId !== this.activeRunId) {
        resolve();
        return;
      }

      const ctx = this.ensureAudioContext();
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;

      if (warmEq) {
        // Rantai Studio Warmth EQ: tambah kehangatan vokal, kurangi ketajaman metalik, tambah airiness
        const lowWarmth = ctx.createBiquadFilter();
        lowWarmth.type = 'lowshelf';
        lowWarmth.frequency.value = 180;
        lowWarmth.gain.value = 3.5;

        const deHarsh = ctx.createBiquadFilter();
        deHarsh.type = 'peaking';
        deHarsh.frequency.value = 3200;
        deHarsh.Q.value = 1.2;
        deHarsh.gain.value = -2.5;

        const airSilk = ctx.createBiquadFilter();
        airSilk.type = 'highshelf';
        airSilk.frequency.value = 7500;
        airSilk.gain.value = 2.0;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 12;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.15;

        source.connect(lowWarmth);
        lowWarmth.connect(deHarsh);
        deHarsh.connect(airSilk);
        airSilk.connect(compressor);
        compressor.connect(analyser);
      } else {
        source.connect(analyser);
      }

      analyser.connect(ctx.destination);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const freqArray = onWaveBins ? new Uint8Array(analyser.frequencyBinCount) : null;
      this.activeSource = source;

      const tick = () => {
        if (runId !== this.activeRunId || this.activeSource !== source) return;
        analyser.getByteTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSq += normalized * normalized;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        const level = Math.min(1, Math.max(0, rms * 4.2));
        onMouthLevel(level);

        if (onWaveBins && freqArray) {
          analyser.getByteFrequencyData(freqArray);
          const bands: number[] = [];
          // Pita vokal manusia berada di bin ~1..26 dari 128 bin fftSize=256
          for (let b = 0; b < VOICE_WAVE_BANDS; b++) {
            const binStart = 1 + b * 2;
            const binEnd = Math.min(freqArray.length - 1, binStart + 1);
            const avg = (freqArray[binStart] + freqArray[binEnd]) / (2 * 255);
            bands.push(Math.min(1, Math.pow(avg, 0.85) * 1.25));
          }
          onWaveBins(bands);
        }

        this.rafId = requestAnimationFrame(tick);
      };

      source.onended = () => {
        if (this.rafId !== null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        if (this.activeSource === source) {
          this.activeSource = null;
        }
        onMouthLevel(0);
        onWaveBins?.([]);
        resolve();
      };

      source.start(0);
      this.rafId = requestAnimationFrame(tick);
    });
  }

  private playBrowserFallback(
    text: string,
    gender: AssistantGender,
    voiceSettings: VoiceSettings,
    runId: number,
    onMouthLevel: (level: number) => void,
    onWaveBins?: (bins: number[]) => void
  ): Promise<void> {
    return new Promise((resolve) => {
      if (
        typeof window === 'undefined' ||
        !('speechSynthesis' in window) ||
        runId !== this.activeRunId
      ) {
        onMouthLevel(0);
        onWaveBins?.([]);
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'id-ID';
      const basePitch = gender === 'perempuan' ? 1.08 : 0.95;
      utterance.pitch = Math.min(
        1.6,
        Math.max(0.7, basePitch + voiceSettings.pitch * 0.01)
      );
      utterance.rate = Math.min(
        1.4,
        Math.max(0.75, 1 + voiceSettings.rate * 0.008)
      );

      const voices = window.speechSynthesis.getVoices();
      const indoVoices = voices.filter((v) =>
        v.lang.toLowerCase().startsWith('id')
      );
      if (indoVoices.length > 0) {
        const preferred = indoVoices.find((v) =>
          gender === 'perempuan'
            ? /gadis|female|wanita|perempuan/i.test(v.name)
            : /ardi|male|pria|laki/i.test(v.name)
        );
        utterance.voice = preferred ?? indoVoices[0];
      }

      let phase = 0;
      const animateFallbackMouth = () => {
        if (runId !== this.activeRunId) return;
        phase += 0.35;
        const simulated =
          0.25 + 0.55 * Math.abs(Math.sin(phase) * Math.cos(phase * 0.45));
        onMouthLevel(simulated);
        if (onWaveBins) {
          const bands: number[] = [];
          for (let b = 0; b < VOICE_WAVE_BANDS; b++) {
            const envelope = 1 - b / (VOICE_WAVE_BANDS + 2);
            const harmonic = 0.4 + 0.6 * Math.abs(Math.sin(phase * 0.9 - b * 0.45));
            bands.push(Math.min(1, simulated * envelope * harmonic * 1.15));
          }
          onWaveBins(bands);
        }
        this.rafId = requestAnimationFrame(animateFallbackMouth);
      };

      const finish = () => {
        if (this.rafId !== null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        onMouthLevel(0);
        onWaveBins?.([]);
        resolve();
      };

      utterance.onstart = () => {
        if (runId === this.activeRunId) {
          this.rafId = requestAnimationFrame(animateFallbackMouth);
        }
      };
      utterance.onend = finish;
      utterance.onerror = finish;

      window.speechSynthesis.speak(utterance);
    });
  }
}
