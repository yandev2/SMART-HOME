'use client';

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  lightDismiss?: boolean;
  maxWidthClass?: string;
}

export default function ModalDialog({
  open,
  onClose,
  title,
  children,
  lightDismiss = true,
  maxWidthClass = 'max-w-md',
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fallback light-dismiss ketika browser belum mendukung atribut native closedby
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !lightDismiss) return;
    if ('closedBy' in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };

    let pressedOutside = false;
    const handlePointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener('pointerdown', handlePointerDown);
    dialog.addEventListener('pointerup', handlePointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', handlePointerDown);
      dialog.removeEventListener('pointerup', handlePointerUp);
    };
  }, [lightDismiss]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) {
          dialogRef.current.returnValue = '';
        }
        onClose();
      }}
      {...(lightDismiss ? ({ closedby: 'any' } as Record<string, string>) : {})}
      className={`m-auto w-[calc(100%-2rem)] ${maxWidthClass} rounded-xl border border-slate-800 bg-slate-900 p-0 text-slate-100 shadow-2xl`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 id={titleId} className="text-sm font-semibold text-white">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup dialog"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}

