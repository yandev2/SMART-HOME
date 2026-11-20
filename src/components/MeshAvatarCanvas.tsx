'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type FaceMeshModel,
  buildFaceMesh,
  renderAnimatedFaceMesh,
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
  const [imageReady, setImageReady] = useState(false);

  // Ref agar loop requestAnimationFrame selalu membaca state terbaru tanpa restart loop
  const targetMouthRef = useRef(0);
  const smoothMouthRef = useRef(0);
  const isSpeakingRef = useRef(isSpeaking);
  const isListeningRef = useRef(isListening);
  const isThinkingRef = useRef(isThinking);
  const rigRef = useRef(rig);

  const mesh = useMemo<FaceMeshModel>(() => buildFaceMesh(rig), [rig]);
  const meshRef = useRef<FaceMeshModel>(mesh);

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
    meshRef.current = mesh;
  }, [rig, mesh]);

  useEffect(() => {
    let active = true;
    setImageReady(false);
    const img = new Image();
    img.onload = () => {
      if (!active) return;
      imgRef.current = img;
      setImageReady(true);
    };
    img.onerror = () => {
      if (!active) return;
      imgRef.current = null;
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
    if (!canvas || !img || !imageReady) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rectSize = Math.max(128, Math.round(canvas.clientWidth || 160));
    const renderSize = Math.min(340, Math.round(rectSize * dpr));
    if (canvas.width !== renderSize || canvas.height !== renderSize) {
      canvas.width = renderSize;
      canvas.height = renderSize;
    }

    // Jika pengguna memilih Reduce Motion, gambar 1 frame diam yang bersih
    if (prefersReducedMotion) {
      renderAnimatedFaceMesh(
        ctx,
        img,
        meshRef.current,
        rigRef.current,
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
      const target = targetMouthRef.current;
      smoothMouthRef.current += (target - smoothMouthRef.current) * 0.42;

      // Jadwalkan kedipan mata alami setiap 2.6 - 5.2 detik
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

      renderAnimatedFaceMesh(
        ctx,
        img,
        meshRef.current,
        rigRef.current,
        {
          timeSec: (nowMs - startMs) / 1000,
          mouthOpen: smoothMouthRef.current,
          blink,
          isSpeaking: isSpeakingRef.current,
          isListening: isListeningRef.current,
          isThinking: isThinkingRef.current,
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
