import React from 'react';
import { useTranslation } from 'react-i18next';

// Settings > General: which model service Claude Code uses when GilzaCode starts
// it (/api/settings/model-provider, model_provider.py). The choice only changes
// the environment of the `claude` processes GilzaCode starts: the panel's
// session, Translate and Look up. Saving a change closes the panel's session,
// which was started with the old environment; `onSessionReplaced` lets the
// panel start the new one at once.

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const sameProvider = (a, b) => Boolean(a && b)
  && a.kind === b.kind && a.ollama_url === b.ollama_url
  && a.ollama_model === b.ollama_model && a.ollama_fast_model === b.ollama_fast_model;

export default function ClaudeModelSection({ onSessionReplaced }) {
  const { t } = useTranslation();
  const [stored, setStored] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [loadError, setLoadError] = React.useState('');
  const [models, setModels] = React.useState(null); // null until listed
  const [listing, setListing] = React.useState(false);
  const [listError, setListError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [saveError, setSaveError] = React.useState('');

  const listModels = React.useCallback((url) => {
    setListing(true);
    setListError('');
    return fetch(`/api/settings/model-provider/ollama-models?${new URLSearchParams({ url })}`)
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
        setDraft(data.provider);
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

  const update = (changes) => {
    setDraft(current => ({ ...current, ...changes }));
    setMessage('');
    setSaveError('');
  };

  const chooseKind = (kind) => {
    update({ kind, ollama_url: draft.ollama_url || DEFAULT_OLLAMA_URL });
    if (kind === 'ollama' && models === null && !listing) listModels(draft.ollama_url || DEFAULT_OLLAMA_URL);
  };

  const save = () => {
    setSaving(true);
    setMessage('');
    setSaveError('');
    fetch('/api/settings/model-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    })
      .then(readJson)
      .then(data => {
        setStored(data.provider);
        setDraft(data.provider);
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

  // The saved model stays selectable while Ollama cannot be listed (not running yet).
  const modelNames = (models || []).map(m => m.name);
  const withCurrent = (name) => (name && !modelNames.includes(name) ? [name, ...modelNames] : modelNames);
  const describe = (name) => {
    const info = (models || []).find(m => m.name === name);
    if (!info) return name;
    const extra = [info.parameter_size, info.remote ? t('settingsModal.claudeModelRemote', 'cloud') : ''].filter(Boolean);
    return extra.length ? `${name} (${extra.join(', ')})` : name;
  };
  const isOllama = draft.kind === 'ollama';
  const dirty = !sameProvider(draft, stored);
  const canSave = dirty && !saving && (!isOllama || (draft.ollama_url.trim() && draft.ollama_model));

  return (
    <Section title={t('settingsModal.claudeModelTitle', 'Claude Code model')}>
      <label style={radioRow}>
        <input type="radio" name="claude-model-kind" checked={draft.kind === 'anthropic'} onChange={() => chooseKind('anthropic')} />
        {t('settingsModal.claudeModelAnthropic', 'Anthropic account (default)')}
      </label>
      <label style={radioRow}>
        <input type="radio" name="claude-model-kind" checked={isOllama} onChange={() => chooseKind('ollama')} />
        {t('settingsModal.claudeModelOllama', 'Ollama (local models)')}
      </label>

      {isOllama && (
        <div className="flex flex-col" style={{ gap: '6px', paddingLeft: '22px' }}>
          <span style={fieldLabel}>{t('settingsModal.claudeModelUrl', 'Ollama URL')}</span>
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
              onClick={() => listModels(draft.ollama_url.trim())}>
              {listing ? t('settingsModal.claudeModelTesting', 'Testing…') : t('settingsModal.claudeModelTest', 'Test')}
            </button>
          </div>
          {models && !listError && (
            <span role="status" style={{ ...smallText, color: 'var(--battery-good)' }}>
              {models.length
                ? t('settingsModal.claudeModelConnected', { count: models.length })
                : t('settingsModal.claudeModelNoModels', 'Ollama is answering, but no model is installed. Install one with "ollama pull <model>".')}
            </span>
          )}
          {listError && (
            <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{listError}</span>
          )}

          <span style={fieldLabel}>{t('settingsModal.claudeModelMain', 'Model')}</span>
          <select value={draft.ollama_model} onChange={(e) => update({ ollama_model: e.target.value })}
            className="vscode-settings-input" style={{ width: '100%' }}>
            <option value="" disabled>{t('settingsModal.claudeModelChoose', 'Choose a model')}</option>
            {withCurrent(draft.ollama_model).map(name => <option key={name} value={name}>{describe(name)}</option>)}
          </select>
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('settingsModal.claudeModelMainHint', 'Used by the Claude Code panel and by Look up.')}
          </span>

          <span style={fieldLabel}>{t('settingsModal.claudeModelFast', 'Fast model')}</span>
          <select value={draft.ollama_fast_model} onChange={(e) => update({ ollama_fast_model: e.target.value })}
            className="vscode-settings-input" style={{ width: '100%' }}>
            <option value="">{t('settingsModal.claudeModelSameAsMain', 'Same as the model')}</option>
            {withCurrent(draft.ollama_fast_model).map(name => <option key={name} value={name}>{describe(name)}</option>)}
          </select>
          <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
            {t('settingsModal.claudeModelFastHint', 'Used by Translate and by Claude Code\'s quick background tasks.')}
          </span>
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
          ? t('settingsModal.claudeModelOllamaHint', 'Only the Claude Code that GilzaCode starts uses Ollama. Ollama needs a context of at least 64k tokens (OLLAMA_CONTEXT_LENGTH) and a model that supports tools; local models make more mistakes in long tasks than Claude.')
          : t('settingsModal.claudeModelAnthropicHint', 'Claude Code uses your claude.ai login, or the variables you set for it yourself.')}
      </span>
    </Section>
  );
}

const smallText = { fontSize: '11px', lineHeight: 1.4 };
const fieldLabel = { fontSize: '12px', color: 'var(--vscode-text-fg)' };
const radioRow = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-text-fg)' };

function Section({ title, children }) {
  return (
    <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
      <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{title}</label>
      {children}
    </div>
  );
}
