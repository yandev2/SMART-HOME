'use client';

import { useEffect, useRef, useState } from 'react';
import {
  type SampledFaceAppearance,
  analyzeFaceAppearance,
  renderAnimatedFaceCanvas,
} from '@/lib/faceMesh2d';
import type { AvatarRig } from '@/lib/types';

interface MeshAvatarCanvasProps {
  imageDataUrl: string;
  rig: AvatarRig;
  mouthLevel: number;
  isSpeaking: boolean;
  isListening?: boolean;
  isThinking?: boolean;
  className?: string;
}

export default function MeshAvatarCanvas({
  imageDataUrl,
  rig,
  mouthLevel,
  isSpeaking,
  isListening = false,
  isThinking = false,
  className = '',
}: MeshAvatarCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const appearanceRef = useRef<SampledFaceAppearance | null>(null);
  const [imageReady, setImageReady] = useState(false);

  const targetMouthRef = useRef(0);
  const smoothMouthRef = useRef(0);
  const smoothSpeakEnergyRef = useRef(0);
  const smoothRollRadRef = useRef(0);
  const smoothShiftXNormRef = useRef(0);
  const smoothShiftYNormRef = useRef(0);
  const isSpeakingRef = useRef(isSpeaking);
  const isListeningRef = useRef(isListening);
  const isThinkingRef = useRef(isThinking);
  const rigRef = useRef(rig);

  useEffect(() => {
    targetMouthRef.current = Math.min(1, Math.max(0, mouthLevel));
  }, [mouthLevel]);

  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
  }, [isSpeaking]);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    isThinkingRef.current = isThinking;
  }, [isThinking]);

  useEffect(() => {
    rigRef.current = rig;
    if (imgRef.current && imageReady) {
      appearanceRef.current = analyzeFaceAppearance(imgRef.current, rig);
    }
  }, [rig, imageReady]);

  useEffect(() => {
    let active = true;
    setImageReady(false);
    const img = new Image();
    img.onload = () => {
      if (!active) return;
      imgRef.current = img;
      appearanceRef.current = analyzeFaceAppearance(img, rigRef.current);
      setImageReady(true);
    };
    img.onerror = () => {
      if (!active) return;
      imgRef.current = null;
      appearanceRef.current = null;
      setImageReady(false);
    };
    img.src = imageDataUrl;
    return () => {
      active = false;
    };
  }, [imageDataUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    const appearance = appearanceRef.current;
    if (!canvas || !img || !appearance || !imageReady) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rectSize = Math.max(128, Math.round(canvas.clientWidth || 160));
    const renderSize = Math.min(440, Math.round(rectSize * dpr));
    if (canvas.width !== renderSize || canvas.height !== renderSize) {
      canvas.width = renderSize;
      canvas.height = renderSize;
    }

    if (prefersReducedMotion) {
      renderAnimatedFaceCanvas(
        ctx,
        img,
        rigRef.current,
        appearance,
        {
          timeSec: 0,
          mouthOpen: 0,
          blink: 0,
          isSpeaking: false,
          isListening: false,
          isThinking: false,
        },
        canvas.width,
        canvas.height
      );
      return;
    }

    let rafId = 0;
    const startMs = performance.now();
    let nextBlinkMs = startMs + 1800 + Math.random() * 2400;
    let blinkStartMs = 0;

    const loop = (nowMs: number) => {
      const timeSec = (nowMs - startMs) / 1000;
      const target = targetMouthRef.current;
      smoothMouthRef.current += (target - smoothMouthRef.current) * 0.44;

      // Exponential smoothing pada energi bicara & gerakan leher (mengikuti pola smoothMouthRef)
      // agar leher mengayun lembut tanpa pernah melompat/snap saat berganti status bicara/mendengar.
      const speakTarget = isSpeakingRef.current
        ? Math.min(1, 0.25 + smoothMouthRef.current * 0.85)
        : 0;
      const energyAlpha = speakTarget > smoothSpeakEnergyRef.current ? 0.14 : 0.08;
      smoothSpeakEnergyRef.current +=
        (speakTarget - smoothSpeakEnergyRef.current) * energyAlpha;

      const speakEnergy = smoothSpeakEnergyRef.current;
      const idleSway = Math.sin(timeSec * 1.1) * 0.0085;
      const speakTilt = Math.sin(timeSec * 2.4) * (0.011 + speakEnergy * 0.014) * speakEnergy;
      const poseTilt = isListeningRef.current
        ? 0.02
        : isThinkingRef.current
          ? -0.014
          : 0;

      const targetRollRad = idleSway + speakTilt + poseTilt;
      const targetShiftXNorm =
        Math.sin(timeSec * 0.72) * 0.0022 +
        Math.sin(timeSec * 2.7) * 0.0032 * speakEnergy;
      const targetShiftYNorm =
        Math.sin(timeSec * 1.55) * 0.0022 +
        Math.sin(timeSec * 5.2) * (0.004 + smoothMouthRef.current * 0.008) * speakEnergy;

      smoothRollRadRef.current += (targetRollRad - smoothRollRadRef.current) * 0.12;
      smoothShiftXNormRef.current +=
        (targetShiftXNorm - smoothShiftXNormRef.current) * 0.12;
      smoothShiftYNormRef.current +=
        (targetShiftYNorm - smoothShiftYNormRef.current) * 0.14;

      let blink = 0;
      if (blinkStartMs === 0 && nowMs >= nextBlinkMs) {
        blinkStartMs = nowMs;
      }
      if (blinkStartMs > 0) {
        const elapsed = nowMs - blinkStartMs;
        const duration = 170;
        if (elapsed >= duration) {
          blinkStartMs = 0;
          const isDouble = Math.random() < 0.18;
          nextBlinkMs = nowMs + (isDouble ? 240 : 2500 + Math.random() * 2800);
        } else {
          blink = Math.sin((elapsed / duration) * Math.PI);
        }
      }

      renderAnimatedFaceCanvas(
        ctx,
        img,
        rigRef.current,
        appearanceRef.current ?? appearance,
        {
          timeSec,
          mouthOpen: smoothMouthRef.current,
          blink,
          isSpeaking: isSpeakingRef.current,
          isListening: isListeningRef.current,
          isThinking: isThinkingRef.current,
          smoothRollRad: smoothRollRadRef.current,
          smoothShiftXNorm: smoothShiftXNormRef.current,
          smoothShiftYNorm: smoothShiftYNormRef.current,
        },
        canvas.width,
        canvas.height
      );

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [imageReady, rig]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`block h-full w-full ${className}`}
    />
  );
}
