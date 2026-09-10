// Ask Supabase Storage for a resized/recompressed version of a public image.
// Uses the render/image transform endpoint. If transforms aren't enabled on the
// project the URL 404s — callers should fall back to the original via onError.
//
// Nullable in, nullable out: most callers hold an `image_url` that may be null,
// and every one of them was writing the same guard around this.
export function supabaseThumb(url: string | null | undefined, width: number, quality = 70) {
  if (!url) return null;
  if (!url.includes("/storage/v1/object/public/")) return url;
  return (
    url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") +
    `?width=${width}&quality=${quality}`
  );
}
