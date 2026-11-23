// Base64 → bytes without a per-byte JS callback (large screenshots are tens of MB).

/** The decoded bytes as a Blob, via the browser's own data-URL decoder. */
export async function base64Blob(base64: string, type: string): Promise<Blob> {
  const res = await fetch(`data:${type};base64,${base64}`);
  return res.blob();
}
