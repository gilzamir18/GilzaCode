import React from 'react';
import { useTranslation } from 'react-i18next';
import { effectiveModel } from '../../utils/helperModels.js';

// Settings > General: the Claude model each helper task runs on
// (/api/settings/helper-models, helper_models.py). Helper tasks are the
// one-off calls the context menus start. A choice is saved as soon as it is
// made; it applies to the next call and restarts nothing. With the Ollama
// provider each alias runs on one of the chosen Ollama models, which the
// section names.

const TASKS = [
  { key: 'translate_model', label: ['settingsModal.helperTranslate', 'Translate'] },
  { key: 'lookup_model', label: ['settingsModal.helperLookUp', 'Look up'] },
  { key: 'tex_change_model', label: ['settingsModal.helperChangeTex', 'Change .tex'] },
  { key: 'inline_edit_model', label: ['settingsModal.helperInlineEdit', 'Refine, Generate content, Create illustration (Ctrl+L)'] },
];

const ALIAS_NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export default function HelperModelsSection() {
  const { t } = useTranslation();
  const [data, setData] = React.useState(null);
  const [provider, setProvider] = React.useState(null);
  const [loadError, setLoadError] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [savedTask, setSavedTask] = React.useState('');

  React.useEffect(() => {
    fetch('/api/settings/helper-models').then(readJson).then(setData)
      .catch(err => setLoadError(String(err.message || err)));
    fetch('/api/settings/model-provider').then(readJson).then(d => setProvider(d.provider)).catch(() => {});
  }, []);

  const choose = (task, value) => {
    setSaveError('');
    setSavedTask('');
    fetch('/api/settings/helper-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: { [task]: value } }),
    })
      .then(readJson)
      .then(result => { setData(prev => ({ ...prev, models: result.models })); setSavedTask(task); })
      .catch(err => setSaveError(String(err.message || err)));
  };

  const taskName = (key) => {
    const task = TASKS.find(item => item.key === key);
    return task ? t(...task.label) : key;
  };

  return (
    <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
      <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
        {t('settingsModal.helperModelsTitle', 'Helper task models')}
      </label>
      <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
        {t('settingsModal.helperModelsHint', 'The model each action of the context menus uses. A change applies to the next call.')}
      </span>
      {loadError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{loadError}</span>
      )}
      {data && TASKS.map(({ key, label }) => {
        const spec = data.tasks[key] || {};
        const fallback = spec.default
          ? t('settingsModal.helperDefault', { model: ALIAS_NAMES[spec.default] || spec.default, defaultValue: 'Default ({{model}})' })
          : t('settingsModal.helperFollows', {
            task: taskName(spec.follows),
            model: ALIAS_NAMES[effectiveModel(spec.follows, data.models, data.tasks)] || effectiveModel(spec.follows, data.models, data.tasks),
            defaultValue: 'Same as {{task}} ({{model}})',
          });
        const value = data.models[key] || '';
        return (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 240px', gap: '8px', alignItems: 'center' }}>
            <label htmlFor={`helper-model-${key}`} style={fieldLabel}>{t(...label)}</label>
            <select
              id={`helper-model-${key}`}
              value={value}
              onChange={(e) => choose(key, e.target.value)}
              className="vscode-settings-input"
              style={{ width: '100%' }}
            >
              <option value="">{fallback}</option>
              {data.aliases.map(alias => <option key={alias} value={alias}>{ALIAS_NAMES[alias] || alias}</option>)}
              {value && !data.aliases.includes(value) && <option value={value}>{value}</option>}
            </select>
          </div>
        );
      })}
      {savedTask && (
        <span role="status" style={{ ...smallText, color: 'var(--battery-good)' }}>
          {t('settingsModal.helperSaved', { task: taskName(savedTask), defaultValue: 'Saved: {{task}}.' })}
        </span>
      )}
      {saveError && (
        <span role="alert" style={{ ...smallText, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' }}>{saveError}</span>
      )}
      {provider?.kind === 'ollama' && (
        <span style={{ ...smallText, color: 'var(--vscode-descriptionForeground)' }}>
          {t('settingsModal.helperOllamaHint', {
            fast: provider.ollama_fast_model || provider.ollama_model,
            main: provider.ollama_model,
            defaultValue: 'With Ollama, Haiku runs on {{fast}} and Sonnet, Opus and Fable on {{main}}.',
          })}
        </span>
      )}
    </div>
  );
}

const smallText = { fontSize: '11px', lineHeight: 1.4 };
const fieldLabel = { fontSize: '12px', color: 'var(--vscode-text-fg)' };
