import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Trash2, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Picker and download manager for local Piper voices.
 *
 * A voice is ~63 MB, so this is a deliberate, visible download rather than
 * something that happens behind a spinner: the list shows the size before the
 * user commits, progress is reported while it runs, and an installed voice can
 * be removed to get the disk back.
 *
 * The backend verifies each file's checksum and discards a corrupt download
 * (gilzabots/voice_store.py), so anything listed as installed is known good.
 */

const formatMb = (bytes) => `${Math.round((Number(bytes) || 0) / 1e6)} MB`;

export default function SpeechVoiceManager({ selected, onSelect, onChanged }) {
  const { t } = useTranslation();
  const [state, setState] = useState({
    catalog: [], installed: [], downloads: {}, phonemizer_problem: '', catalog_error: '',
  });
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  const load = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/speech/voices${refresh ? '?refresh=1' : ''}`);
      if (!res.ok) return;
      const data = await res.json();
      setState(data);
    } catch {
      // Leave whatever is on screen: the list is informational, and the
      // installed voices keep working whether or not the catalog loads.
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // While a download runs the POST is still open, so progress is polled from
  // the same endpoint that lists the catalog.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const installed = useMemo(() => new Set(state.installed || []), [state.installed]);

  const languages = useMemo(() => {
    const seen = new Map();
    for (const voice of state.catalog || []) {
      if (!seen.has(voice.language_code)) {
        seen.set(voice.language_code, `${voice.language_name} (${voice.language_code})`);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [state.catalog]);

  // Installed voices lead, then the chosen language. Without a filter the list
  // is 177 rows, which is a directory, not a choice.
  const visible = useMemo(() => {
    const all = state.catalog || [];
    const isInstalled = (v) => installed.has(v.key);
    if (!language) return all.filter(isInstalled);
    return all.filter((v) => v.language_code === language || isInstalled(v));
  }, [state.catalog, language, installed]);

  const download = async (key) => {
    setBusy(key);
    setError('');
    pollRef.current = setInterval(() => load(), 700);
    try {
      const res = await fetch('/api/speech/voices/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      // A freshly downloaded voice is almost certainly the one they want.
      if (!selected) onSelect(key);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setBusy('');
      load();
      onChanged?.();
    }
  };

  const remove = async (key) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/speech/voices/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (selected === key) onSelect('');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy('');
      load();
      onChanged?.();
    }
  };

  return (
    <div className="flex flex-col" style={{ gap: '6px' }}>
      {state.phonemizer_problem && (
        <div className="speech-voice-warning">
          <AlertTriangle size={13} style={{ flexShrink: 0 }} />
          <span>{state.phonemizer_problem}</span>
        </div>
      )}

      <div className="flex" style={{ gap: '8px', alignItems: 'center' }}>
        <select
          className="vscode-settings-input"
          style={{ flex: 1 }}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="">{t('speechVoices.installedOnly', 'Installed voices')}</option>
          {languages.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
        <button
          type="button"
          className="vscode-bottom-panel-clear-btn"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}
          onClick={() => load(true)}
          title={t('speechVoices.refresh', 'Refresh the voice catalog')}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {state.catalog_error && (
        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
          {t('speechVoices.catalogOffline', 'The voice catalog could not be reached. Installed voices still work offline.')}
        </span>
      )}

      {error && <div className="speech-voice-warning">{error}</div>}

      <div className="speech-voice-list">
        {visible.length === 0 && (
          <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', padding: '6px' }}>
            {t('speechVoices.empty', 'No voice installed yet. Pick a language above to see what can be downloaded.')}
          </span>
        )}
        {visible.map((voice) => {
          const here = installed.has(voice.key);
          const progress = state.downloads?.[voice.key];
          const isBusy = busy === voice.key;
          const pct = progress?.total
            ? Math.round((progress.done / progress.total) * 100)
            : 0;
          return (
            <div
              key={voice.key}
              className={`speech-voice-row${selected === voice.key ? ' is-selected' : ''}`}
            >
              <label className="speech-voice-label">
                <input
                  type="radio"
                  name="local-voice"
                  checked={selected === voice.key}
                  disabled={!here}
                  onChange={() => onSelect(voice.key)}
                />
                <span className="speech-voice-name">
                  {voice.name} · {voice.quality}
                  <span className="speech-voice-lang">
                    {voice.language_native || voice.language_name}
                    {voice.country ? ` — ${voice.country}` : ''}
                  </span>
                </span>
              </label>

              {isBusy && progress?.state === 'downloading' ? (
                <span className="speech-voice-progress">{pct}%</span>
              ) : here ? (
                <>
                  <Check size={13} style={{ color: 'var(--vscode-fg-success, #4ade80)' }} />
                  <button
                    type="button"
                    className="speech-voice-btn"
                    disabled={isBusy}
                    onClick={() => remove(voice.key)}
                    title={t('speechVoices.remove', 'Remove this voice')}
                    aria-label={t('speechVoices.remove', 'Remove this voice')}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="speech-voice-btn"
                  disabled={Boolean(busy)}
                  onClick={() => download(voice.key)}
                  title={t('speechVoices.download', 'Download ({{size}})', { size: formatMb(voice.size_bytes) })}
                >
                  <Download size={13} />
                  <span style={{ fontSize: '10px' }}>{formatMb(voice.size_bytes)}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
