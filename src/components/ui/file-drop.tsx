"use client";

import React, { useRef } from 'react';
import { Trash2, UploadCloud } from 'lucide-react';

export default function FileDrop({
  file,
  previewUrl,
  accept = 'image/*,application/pdf',
  onChange,
}: {
  file: File | null;
  previewUrl?: string | null;
  accept?: string;
  onChange: (f: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      onClick={() => inputRef.current?.click()}
      className="relative rounded-lg border-2 border-dashed border-hairline bg-surface p-3 hover:bg-surface/50 cursor-pointer"
      aria-label="File upload"
    >
      {/* Hidden input — NOT overlaid, so it can't intercept clicks */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        // stopPropagation: the programmatic inputRef.click() dispatches a click that bubbles
        // back to the dropzone div, re-triggering it and opening the picker twice.
        // clear value so re-selecting the same file still fires onChange.
        onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLInputElement).value = ''; }}
        onChange={(e) => {
          onChange(e.target.files?.[0] ?? null);
        }}
      />

      {!file ? (
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-md bg-primary/5 p-4">
            <UploadCloud className="size-8 text-primary-foreground" />
          </div>
          <div className="text-sm font-medium text-foreground">Browse files to upload</div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {previewUrl ? (
              <img src={previewUrl} alt="preview" className="h-20 w-20 shrink-0 rounded-md object-cover" />
            ) : (
              <div className="h-20 w-20 shrink-0 rounded-md bg-surface-muted grid place-items-center">
                <UploadCloud className="size-6 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground" title={file.name}>{file.name}</div>
              <div className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</div>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            aria-label="Remove file"
            className="text-destructive"
          >
            <Trash2 className="size-5" />
          </button>
        </div>
      )}
    </div>
  );
}