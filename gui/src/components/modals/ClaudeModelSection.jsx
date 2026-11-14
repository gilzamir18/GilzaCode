import React from 'react';
import { useTranslation } from 'react-i18next';

// Settings > General: which model service Claude Code uses when GilzaCode starts
// it (/api/settings/model-provider, model_provider.py). The choice only changes
// the environment of the `claude` processes GilzaCode starts: the panel's
// session, Translate and Look up. Saving a change closes the panel's session,
// which was started with the old environment; `onSessionReplaced` lets the
// panel start the new one at once.
//
// Ollama is a local server (whose `:cloud` models run on ollama.com once it is
// signed in) or ollama.com itself, which needs an API key. The server never
// sends the stored key back, only `ollama_api_key_set`; the key field is sent
// only when the user types a new key or removes it.

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const FALLBACK_CLOUD_URL = 'https://ollama.com';
const PROVIDER_FIELDS = ['kind', 'ollama_url', 'ollama_model', 'ollama_fast_model'];

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const pickProvider = (source) => Object.fromEntries(PROVIDER_FIELDS.map(k => [k, source[k]]));
const sameProvider = (a, b) => Boolean(a && b) && PROVIDER_FIELDS.every(k => a[k] === b[k]);
const sameUrl = (a, b) => (a || '').trim().replace(/\/+$/, '') === (b || '').trim().replace(/\/+$/, '');

export default function ClaudeModelSection({ onSessionReplaced }) {
  const { t } = useTranslation();
  const [stored, setStored] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [cloudUrl, setCloudUrl] = React.useState(FALLBACK_CLOUD_URL);
  // null: keep the stored key; a string: replace it with what was typed.
  const [typedKey, setTypedKey] = React.useState(null);
  const [removeKey, setRemoveKey] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  const [models, setModels] = React.useState(null); // null until listed
  const [listing, setListing] = React.useState(false);
  const [listError, setListError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [saveError, setSaveError] = React.useState('');

  // Without `apiKey`, the server sends the stored key, and only to its own URL.
  const listModels = React.useCallback((url, apiKey) => {
    setListing(true);
    setListError('');
    const body = apiKey === undefined ? { url } : { url, api_key: apiKey };
    return fetch('/api/settings/model-provider/ollama-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(readJson)
      .then(data => setModels(data.models))
      .catch(err => { setModels(null); setListError(String(err.message || err)); })
      .finally(() => setListing(false));
  }, []);

  React.useEffect(() => {
    fetch('/api/settings/model-provider')
      .then(readJson)
      .then(data => {
        setStored(data.provider);
        setDraft(pickProvider(data.provider));
        if (data.ollama_cloud_url) setCloudUrl(data.ollama_cloud_url);
        if (data.provider.kind === 'ollama') listModels(data.provider.ollama_url);
      })
      .catch(err => setLoadError(String(err.message || err)));
  }, [listModels]);

  if (loadError) {
    return (
      <Section title={t('settingsModal.claudeModelTitle', 'Claude Code model')}>
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{loadError}</span>
      </Section>
    );
  }
  if (!draft) return null;

  const clearNotices = () => { setMessage(''); setSaveError(''); };
  const update = (changes) => { setDraft(current => ({ ...current, ...changes })); clearNotices(); };

  // The key the next listing should send: the typed one, none (removed), or
  // the stored one (`undefined`, which the server sends only to its own URL).
  const keyForListing = () => {
    if (typedKey !== null && typedKey.trim()) return typedKey.trim();
    if (removeKey) return '';
    return undefined;
  };

  const chooseKind = (kind) => {
    const url = draft.ollama_url || DEFAULT_OLLAMA_URL;
    update({ kind, ollama_url: url });
    if (kind === 'ollama' && models === null && !listing) listModels(url, keyForListing());
  };

  const pickServer = (url) => {
    update({ ollama_url: url });
    setModels(null);
    listModels(url, keyForListing());
  };

  const save = () => {
    const payload = { ...draft };
    if (typedKey !== null && typedKey.trim()) payload.ollama_api_key = typedKey.trim();
    else if (removeKey) payload.ollama_api_key = '';
    setSaving(true);
    clearNotices();
    fetch('/api/settings/model-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
      .then(readJson)
      .then(data => {
        setStored(data.provider);
        setDraft(pickProvider(data.provider));
        setTypedKey(null);
        setRemoveKey(false);
        if (data.restarted) {
          onSessionReplaced?.();
          setMessage(t('settingsModal.claudeModelSavedRestarted', 'Saved. Claude Code was restarted with the new model.'));
        } else {
          setMessage(t('settingsModal.claudeModelSaved', 'Saved. Claude Code uses it from its next start.'));
        }
      })
      .catch(err => setSaveError(t('settingsModal.claudeModelSaveError', 'Could not save: ') + String(err.message || err)))
      .finally(() => setSaving(false));
  };

  const isOllama = draft.kind === 'ollama';
  const keyStored = Boolean(stored?.ollama_api_key_set) && !removeKey;
  const keyChanged = (typedKey !== null && typedKey.trim() !== '') || removeKey;
  const dirty = !sameProvider(draft, stored) || keyChanged;
  const canSave = dirty && !saving && (!isOllama || (draft.ollama_url.trim() && draft.ollama_model.trim()));
  const onCloud = sameUrl(draft.ollama_url, cloudUrl);

  const info = (name) => (models || []).find(m => m.name === name);
  const describe = (m) => {
    const extra = [m.parameter_size, m.remote ? t('settingsModal.claudeModelRemote', 'cloud') : ''].filter(Boolean);
    return extra.join(', ');
  };
  const noTools = (name) => info(name)?.tools === false;

  return (
    <Section title={t('settingsModal.claudeModelTitle', 'Claude Code model')}>
      <label style={radioRow}>
        <input type="radio" name="claude-model-kind" checked={draft.kind === 'anthropic'} onChange={() => chooseKind('anthropic')} />
        {t('settingsModal.claudeModelAnthropic', 'Anthropic account (default)')}
      </label>
      <label style={radioRow}>
        <input type="radio" name="claude-model-kind" checked={isOllama} onChange={() => chooseKind('ollama')} />
        {t('settingsModal.claudeModelOllama', 'Ollama (local server or ollama.com)')}
      </label>

      {isOllama && (
        <div className="flex flex-col" style={{ gap: '6px', paddingLeft: '22px' }}>
          <span style={fieldLabel}>{t('settingsModal.claudeModelUrl', 'Server')}</span>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button className="vscode-button-secondary" disabled={sameUrl(draft.ollama_url, DEFAULT_OLLAMA_URL)}
              onClick={() => pickServer(DEFAULT_OLLAMA_URL)}>
              {t('settingsModal.claudeModelServerLocal', 'Local Ollama')}
            </button>
            <button className="vscode-button-secondary" disabled={onCloud} onClick={() => pickServer(cloudUrl)}>
              {t('settingsModal.claudeModelServerCloud', 'ollama.com (API key)')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={draft.ollama_url}
              placeholder={DEFAULT_OLLAMA_URL}
              onChange={(e) => update({ ollama_url: e.target.value })}
              className="vscode-settings-input"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="vscode-button-secondary" disabled={listing || !draft.ollama_url.trim()}
              onClick={() => listModels(draft.ollama_url.trim(), keyForListing())}>
              {listing ? t('settingsModal.claudeModelTesting', 'Testing…') : t('settingsModal.claudeModelTest', 'Test')}
            </button>
          </div>

          <span style={fieldLabel}>{t('settingsModal.claudeModelApiKey', 'API key')}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="password"
              autoComplete="off"
              value={typedKey ?? ''}
              placeholder={keyStored
                ? t('settingsModal.claudeModelApiKeyStored', 'Saved. Type a new key to replace it.')
                : t('settingsModal.claudeModelApiKeyNone', 'Not needed for a local Ollama')}
              onChange={(e) => { setTypedKey(e.target.value); setRemoveKey(false); clearNotices(); }}
              className="vscode-settings-input"
              style={{ flex: 1, minWidth: 0 }}
            />
            {keyStored && (
              <button className="vscode-button-secondary" onClick={() => { setRemoveKey(true); setTypedKey(null); clearNotices(); }}>
                {t('settingsModal.claudeModelApiKeyRemove', 'Remove')}
              </button>
            )}
          </div>
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {removeKey
              ? t('settingsModal.claudeModelApiKeyWillRemove', 'The saved key will be removed when you save.')
              : t('settingsModal.claudeModelApiKeyHint', 'Needed for ollama.com: create one at ollama.com/settings/keys. It is sent only to the server above and is stored in a file only your user can read, never in settings.json. A local Ollama signed in with "ollama signin" runs the :cloud models without a key.')}
          </span>

          {models && !listError && (
            <span role="status" style={{ ...smallText, color: 'var(--battery-good)' }}>
              {models.length
                ? t('settingsModal.claudeModelConnected', { count: models.length })
                : t('settingsModal.claudeModelNoModels', 'The server is answering, but offers no model. On a local Ollama, install one with "ollama pull <model>".')}
            </span>
          )}
          {listError && (
            <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{listError}</span>
          )}

          {/* Free text with the listed models as suggestions: a model can be
              named before the server can be listed (not running, no key yet). */}
          <datalist id="claude-model-ollama-models">
            {(models || []).map(m => <option key={m.name} value={m.name} label={describe(m)} />)}
          </datalist>

          <span style={fieldLabel}>{t('settingsModal.claudeModelMain', 'Model')}</span>
          <input
            type="text"
            list="claude-model-ollama-models"
            value={draft.ollama_model}
            placeholder={t('settingsModal.claudeModelChoose', 'Choose or type a model')}
            onChange={(e) => update({ ollama_model: e.target.value })}
            className="vscode-settings-input"
            style={{ width: '100%' }}
          />
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('settingsModal.claudeModelMainHint', 'Used by the Claude Code panel and by Look up.')}
          </span>
          {noTools(draft.ollama_model) && <ToolsWarning t={t} />}

          <span style={fieldLabel}>{t('settingsModal.claudeModelFast', 'Fast model')}</span>
          <input
            type="text"
            list="claude-model-ollama-models"
            value={draft.ollama_fast_model}
            placeholder={t('settingsModal.claudeModelSameAsMain', 'Same as the model')}
            onChange={(e) => update({ ollama_fast_model: e.target.value })}
            className="vscode-settings-input"
            style={{ width: '100%' }}
          />
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('settingsModal.claudeModelFastHint', 'Used by Translate and by Claude Code\'s quick background tasks. Leave it empty to use the model above.')}
          </span>
          {noTools(draft.ollama_fast_model) && <ToolsWarning t={t} />}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button className="vscode-button" disabled={!canSave} onClick={save}>
          {saving ? t('settingsModal.claudeModelSaving', 'Saving…') : t('settingsModal.claudeModelSave', 'Save')}
        </button>
        {dirty && !saving && (
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('settingsModal.claudeModelRestartWarning', 'Saving restarts the Claude Code session in the panel. /resume brings the conversation back.')}
          </span>
        )}
      </div>
      {message && <span role="status" style={{ ...smallText, color: 'var(--battery-good)' }}>{message}</span>}
      {saveError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{saveError}</span>
      )}
      <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
        {isOllama
          ? t('settingsModal.claudeModelOllamaHint', 'Only the Claude Code that GilzaCode starts uses Ollama. Claude Code needs a model that supports tools; on a local server, Ollama also needs a context of at least 64k tokens (OLLAMA_CONTEXT_LENGTH).')
          : t('settingsModal.claudeModelAnthropicHint', 'Claude Code uses your claude.ai login, or the variables you set for it yourself.')}
      </span>
    </Section>
  );
}

const smallText = { fontSize: '11px', lineHeight: 1.4 };
const fieldLabel = { fontSize: '12px', color: 'var(--vscode-text-fg)' };
const radioRow = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-text-fg)' };

function ToolsWarning({ t }) {
  return (
    <span role="alert" style={{ ...smallText, color: 'var(--vscode-editorWarning-foreground, var(--vscode-errorForeground))' }}>
      {t('settingsModal.claudeModelNoTools', 'The server says this model does not support tools. Claude Code works through tools, so it will not be able to read or edit files with it.')}
    </span>
  );
}

function Section({ title, children }) {
  return (
    <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
      <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{title}</label>
      {children}
    </div>
  );
}
