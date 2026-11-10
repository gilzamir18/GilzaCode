// HttpOnly cookies authenticate fetch, EventSource, PDF and video requests alike.
// Establish the session before mounting anything that accesses the backend.
export async function establishLocalSession(fetcher = fetch) {
  const response = await fetcher('/api/session', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-GilzaCode-Bootstrap': '1' },
  });
  if (!response.ok) throw new Error('Could not establish the local application session.');
  const verified = await fetcher('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!verified.ok) throw new Error('The local application session could not be verified.');
}
