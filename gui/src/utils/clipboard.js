// Reads the system clipboard, falling back to the backend API when the
// browser Clipboard API is unavailable (e.g., inside pywebview/Qt).
export async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text !== undefined) return text;
  } catch (_) {
    // fall through to backend fallback
  }
  try {
    const res = await fetch('/api/clipboard/read');
    const data = await res.json();
    return data.text ?? '';
  } catch (_) {
    return '';
  }
}

// Writes text to the system clipboard, with the same two-step fallback as
// `readClipboard`: the browser API first, the backend endpoint for the embedded
// QtWebEngine shell that does not implement it. Copy and paste have to reach
// the same clipboard, so neither half is allowed to be the one that only works
// in a real browser.
// Returns whether the text actually made it to the clipboard.
export async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // fall through to backend fallback
  }
  try {
    const res = await fetch('/api/clipboard/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// Reads an image from the system clipboard. The async Clipboard API is tried
// first for real browsers; the embedded QtWebEngine shell does not implement
// it, so the backend endpoint is the one that actually answers there.
// Returns { blob, mime } or null when the clipboard holds no image.
export async function readClipboardImage() {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const mime = (item.types || []).find((type) => type.startsWith('image/'));
        if (mime) return { blob: await item.getType(mime), mime };
      }
    }
  } catch (_) {
    // fall through to backend fallback
  }
  try {
    const res = await fetch('/api/clipboard/read-image');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.data_b64) return null;
    return { data_b64: data.data_b64, mime: data.mime || 'image/png' };
  } catch (_) {
    return null;
  }
}
