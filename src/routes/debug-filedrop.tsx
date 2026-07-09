"use client";

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import FileDrop from "@/components/ui/file-drop";

export const Route = createFileRoute("/debug-filedrop")({
  ssr: false,
  component: DebugFileDrop,
});

function DebugFileDrop() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  function handleFile(f: File | null) {
    setFile(f);
    if (!f) return setPreview(null);
    const r = new FileReader();
    r.onload = () => setPreview(r.result as string);
    r.readAsDataURL(f);
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <h1 className="mb-4 text-lg font-semibold">Debug FileDrop</h1>
      <FileDrop file={file} previewUrl={preview} onChange={handleFile} accept={"image/*,application/pdf"} />
      <div className="mt-4">
        <div>Selected: {file ? file.name : "(none)"}</div>
      </div>
    </div>
  );
}

export default DebugFileDrop;
