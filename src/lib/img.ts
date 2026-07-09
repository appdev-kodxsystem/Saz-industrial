// Ask Supabase Storage for a resized/recompressed version of a public image.
// Uses the render/image transform endpoint. If transforms aren't enabled on the
// project the URL 404s — callers should fall back to the original via onError.
export function supabaseThumb(url: string, width: number, quality = 70): string {
  if (!url.includes("/storage/v1/object/public/")) return url;
  return (
    url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") +
    `?width=${width}&quality=${quality}`
  );
}
