// Open a URL outside the application.
//
// `target="_blank"` alone is not enough: the desktop shell is a pywebview
// window with no createWindow handler, so a blank-target click there does
// nothing at all and the user is left staring at a URL they cannot follow.
// The backend hands the URL to the desktop's default browser instead, which
// works in the webview and in a plain browser tab alike.
//
// Returns true when a browser was launched, so the caller can keep showing the
// URL for manual copying when it was not.
export async function openExternal(url) {
  if (!url) return false;
  try {
    const res = await fetch('/api/system/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const payload = await res.json();
    return !!payload.opened;
  } catch (_) {
    return false;
  }
}

// Click handler for an <a> that must open outside the app. The href is kept in
// the markup so the link still reads as a link (hover, context menu, copy
// address); this only takes over the click itself.
export function handleExternalClick(url) {
  return (event) => {
    event.preventDefault();
    openExternal(url);
  };
}
