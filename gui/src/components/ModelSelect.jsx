import React from 'react';
import { useTranslation } from 'react-i18next';

// Disambiguates catalog entries that share the same display name.
const modelOptionLabel = (model, models) => {
  const name = model.name || model.id;
  const matchingModels = models.filter(candidate => (candidate.name || candidate.id) === name);
  if (matchingModels.length < 2) return name;

  return `${name} #${matchingModels.findIndex(candidate => candidate.id === model.id) + 1}`;
};

/**
 * Model picker bound to the project's stored model id.
 *
 * The selected value always has a matching <option>: an empty placeholder when the
 * project has no model configured, and an explicit "not in catalog" entry when the
 * project stores an id the global model store does not know about. Without those,
 * React falls back to selecting the first option in the list, so the control would
 * display a model the project is not actually using — and re-picking that displayed
 * model fires no change event, so the selection would never be persisted.
 */
export default function ModelSelect({
  value,
  onChange,
  globalModels = [],
  onEditModels,
  onRefreshModels,
  disabled = false,
  placeholder,
  className = 'vscode-settings-input',
  style,
  // Hosts without a model-catalog UI to open (onboarding) hide the action entries.
  showActions = true,
}) {
  const { t } = useTranslation();

  const selectedId = value || '';
  const models = globalModels || [];
  const selectedModel = models.find(m => m.id === selectedId);
  const isUnknownModel = selectedId !== '' && !selectedModel;

  const groupedModels = models.reduce((acc, model) => {
    const provider = model.provider || 'custom';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {});

  const handleChange = (e) => {
    const val = e.target.value;
    if (val === 'edit_models') onEditModels?.();
    else if (val === 'refresh_models') onRefreshModels?.();
    else onChange?.(val);
  };

  const title = isUnknownModel
    ? t('modelSelect.notInCatalogTitle', { id: selectedId })
    : (selectedModel?.api_base
      ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${selectedModel.api_base}`
      : undefined);

  return (
    <select
      className={className}
      style={{ ...(style || {}), ...(isUnknownModel ? { borderColor: 'var(--vscode-fg-warning)' } : {}) }}
      value={selectedId}
      onChange={handleChange}
      disabled={disabled}
      title={title}
    >
      <option value="">{placeholder || t('chatPanel.selectModel')}</option>
      {isUnknownModel && (
        <optgroup label={t('modelSelect.notInCatalog')}>
          <option value={selectedId}>{selectedId}</option>
        </optgroup>
      )}
      {Object.entries(groupedModels).map(([provider, providerModels]) => (
        <optgroup key={provider} label={provider.toUpperCase()}>
          {providerModels.map(m => (
            <option
              key={m.id}
              value={m.id}
              title={m.api_base ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${m.api_base}` : undefined}
            >
              {modelOptionLabel(m, providerModels)}
              {m.is_default ? ` (${t('modelSelect.globalDefaultSuffix', 'global default')})` : ''}
            </option>
          ))}
        </optgroup>
      ))}
      {showActions && (
        <optgroup label={t('common.actions', 'Actions')}>
          <option value="refresh_models">{t('chatPanel.refreshModels', 'Refresh Models')}</option>
          <option value="edit_models">{t('chatPanel.editModels', 'Edit Models...')}</option>
        </optgroup>
      )}
    </select>
  );
}
