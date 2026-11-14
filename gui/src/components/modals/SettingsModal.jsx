import React from 'react';
import { X, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_PRESETS,
  UI_SCALE_STEP,
  presetForScale,
} from '../../utils/uiScale';
import { useCustomDialog } from './CustomDialogProvider';
import SpeechVoiceManager from './SpeechVoiceManager.jsx';
import ClaudeSkillsSection from './ClaudeSkillsSection.jsx';
import ClaudeModelSection from './ClaudeModelSection.jsx';
import i18n from '../../i18n/index.js';
import { setPreference } from '../../utils/preferences';
import { openExternal } from '../../utils/openExternal';

// Target languages offered by the "Translate to" setting. The values are the
// locale codes persisted by /api/settings/translation; "" follows the UI
// language and TRANSLATE_CUSTOM switches the field to free-text entry.
const TRANSLATE_LANGUAGES = [
  { value: 'pt-BR', labelKey: 'settingsModal.translateLangPtBR', label: 'Portugu\u00eas (Brasil)' },
  { value: 'en', labelKey: 'settingsModal.translateLangEn', label: 'English' },
  { value: 'es', labelKey: 'settingsModal.translateLangEs', label: 'Espa\u00f1ol' },
  { value: 'fr', labelKey: 'settingsModal.translateLangFr', label: 'Fran\u00e7ais' },
  { value: 'de', labelKey: 'settingsModal.translateLangDe', label: 'Deutsch' },
  { value: 'it', labelKey: 'settingsModal.translateLangIt', label: 'Italiano' },
  { value: 'ja', labelKey: 'settingsModal.translateLangJa', label: '\u65e5\u672c\u8a9e' },
  { value: 'zh', labelKey: 'settingsModal.translateLangZh', label: '\u4e2d\u6587' },
  { value: 'ru', labelKey: 'settingsModal.translateLangRu', label: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439' },
];

const TRANSLATE_CUSTOM = '__custom__';

// IDE global settings modal (theme, font size, tab size, word wrap, minimap, optional deps).
export default function SettingsModal({
  onClose,
  settingsTab,
  setSettingsTab,
  theme,
  setTheme,
  uiScale,
  applyUiScale,
  editorFontSize,
  setEditorFontSize,
  editorTabSize,
  setEditorTabSize,
  editorWordWrap,
  setEditorWordWrap,
  editorMinimap,
  setEditorMinimap,
  isInstallingDeps,
  installDepsStatus,
  installDepsLog,
  onInstallDeps,
  onLanguageChange,
  ephemeralParams,
  setEphemeralParams,
  panelMaxLines,
  setPanelMaxLines,
  thoughtContextTokens,
  chatThoughtPreviewTokens,
  onChatThoughtPreviewTokensChange,
  onThoughtContextTokensChange, onSpeechSettingsChange, onClaudeSessionReplaced, }) {
  const { t } = useTranslation();
  const { showAlert } = useCustomDialog();
  const [selectedLang, setSelectedLang] = React.useState('');
  const [draftSynctexEnabled, setDraftSynctexEnabled] = React.useState(false);
  const [workspaceHiddenExtensions, setWorkspaceHiddenExtensions] = React.useState([]);
  const [tectonicInstallMessage, setTectonicInstallMessage] = React.useState('');
  const [pandocInstallMessage, setPandocInstallMessage] = React.useState('');
  const [translateTargetLang, setTranslateTargetLang] = React.useState('');
  const [isCustomTranslateLang, setIsCustomTranslateLang] = React.useState(false);
  const [speech, setSpeech] = React.useState({
    enabled: false, engine: 'local', local_voice: '',
    model: '', voice: '', response_format: 'mp3', speed: 1.0,
  });
  const [runtimeInfo, setRuntimeInfo] = React.useState({ platform: '', version: '0.2.43' });

  const activeTab = (settingsTab === 'preferences' || !['general', 'dependencies', 'about'].includes(settingsTab))
    ? 'general'
    : settingsTab;

  React.useEffect(() => {
    fetch('/api/settings/language')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg?.lang !== undefined) setSelectedLang(cfg.lang); })
      .catch(() => { });

    fetch('/api/settings/latex')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.draft_synctex_enabled !== undefined) {
          setDraftSynctexEnabled(Boolean(cfg.draft_synctex_enabled));
        }
      })
      .catch(() => { });

    fetch('/api/settings/workspace')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (Array.isArray(cfg?.hidden_file_extensions)) {
          setWorkspaceHiddenExtensions(cfg.hidden_file_extensions);
        }
      })
      .catch(() => { });

    fetch('/api/settings/speech')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        const { models, engines, problem, ...rest } = cfg;
        setSpeech(prev => ({ ...prev, ...rest }));
      })
      .catch(() => { });

    fetch('/api/settings/translation')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        const saved = String(cfg.translate_target_lang || '');
        setTranslateTargetLang(saved);
        setIsCustomTranslateLang(Boolean(saved) && !TRANSLATE_LANGUAGES.some(l => l.value === saved));
      })
      .catch(() => { });

    fetch('/api/app/environment')
      .then(r => r.ok ? r.json() : null)
      .then(info => {
        if (info) setRuntimeInfo(previous => ({ ...previous, ...info }));
      })
      .catch(() => { });

  }, []);

  const saveLatexSettings = (draftSynctexValue) => {
    fetch('/api/settings/latex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_synctex_enabled: draftSynctexValue }),
    }).catch(() => { });
  };

  // Readiness is recomputed by the backend on every one of these, so each
  // announces it: the chat's microphone gates its own presence on the answer
  // and has no other moment to re-read (App.jsx: speechSettingsSignal).
  const saveSpeechSettings = (next) => {
    setSpeech(next);
    fetch('/api/settings/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => { }).finally(() => onSpeechSettingsChange?.());
  };

  const saveTranslateTargetLang = (value) => {
    fetch('/api/settings/translation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translate_target_lang: value }),
    }).catch(() => { });
  };

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal flex flex-col" style={{ width: '640px', maxHeight: 'calc(85 * var(--ui-vh))', padding: 0 }}>
        {/* Header */}
        <div className="vscode-modal-header titlebar">
          <div className="vscode-modal-header-title">
            <Settings size={16} />
            <span>{t('settingsModal.title')}</span>
          </div>
          <button className="vscode-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="vscode-modal-tabs titlebar">
          <button
            className={`vscode-modal-tab${activeTab === 'general' ? ' active' : ''}`}
            onClick={() => setSettingsTab('general')}
          >
            {t('settingsModal.tabGeneral', 'General')}
          </button>
          <button
            className={`vscode-modal-tab${activeTab === 'dependencies' ? ' active' : ''}`}
            onClick={() => setSettingsTab('dependencies')}
          >
            {t('settingsModal.tabDependencies', 'Dependencies')}
          </button>
          <button
            className={`vscode-modal-tab${activeTab === 'about' ? ' active' : ''}`}
            onClick={() => setSettingsTab('about')}
          >
            {t('settingsModal.tabAbout')}
          </button>
        </div>

        {/* Content */}
        <div className="vscode-modal-content flex-1 overflow-y-auto flex flex-col" style={{ gap: '16px' }}>
          {activeTab === 'general' && (
            <>
              {/* Language */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.language')}</label>
                <select
                  value={selectedLang}
                  onChange={(e) => {
                    const newLang = e.target.value;
                    setSelectedLang(newLang);
                    const targetLang = newLang || (navigator.language.startsWith('pt') ? 'pt-BR' : 'en');
                    i18n.changeLanguage(targetLang);
                    onLanguageChange?.(newLang);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                >
                  <option value="">{t('settingsModal.languageSystem', 'System (automatic)')}</option>
                  <option value="pt-BR">{t('settingsModal.languagePtBR', 'Português (Brasil)')}</option>
                  <option value="en">{t('settingsModal.languageEn', 'English')}</option>
                </select>
              </div>

              {/* Theme */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.colorTheme')}</label>
                <select value={theme} onChange={(e) => setTheme(e.target.value)} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="dark">{t('settingsModal.themeDark')}</option>
                  <option value="light">{t('settingsModal.themeLight')}</option>
                </select>
              </div>

              {/* Interface size (accessibility) — scales the whole interface,
                  not just text, so icons, padding and click targets grow with
                  it. The named steps cover the common case; the slider below
                  reaches further for those who need it. */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>
                  {t('settingsModal.interfaceSize', 'Interface size')}
                </label>
                <div className="flex" style={{ gap: '6px' }}>
                  {UI_SCALE_PRESETS.map((preset) => {
                    const isActive = presetForScale(uiScale)?.id === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyUiScale(preset.scale)}
                        aria-pressed={isActive}
                        className="vscode-settings-input"
                        style={{
                          flex: 1,
                          cursor: 'pointer',
                          textAlign: 'center',
                          borderColor: isActive ? 'var(--vscode-accent)' : 'var(--vscode-input-border)',
                          background: isActive ? 'var(--vscode-list-activeSelectionBg)' : 'var(--vscode-input-bg)',
                          color: isActive ? 'var(--vscode-list-activeSelectionFg)' : 'var(--vscode-input-fg)',
                        }}
                      >
                        {t(`settingsModal.interfaceSize_${preset.id}`, preset.id)}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center" style={{ gap: '8px' }}>
                  <input
                    type="range"
                    min={UI_SCALE_MIN}
                    max={UI_SCALE_MAX}
                    step={UI_SCALE_STEP}
                    value={uiScale}
                    onChange={(e) => applyUiScale(Number(e.target.value))}
                    aria-label={t('settingsModal.interfaceSize', 'Interface size')}
                    style={{ flex: 1, accentColor: 'var(--vscode-accent)' }}
                  />
                  <span style={{ minWidth: '48px', textAlign: 'right', color: 'var(--vscode-text-fg)' }}>
                    {Math.round(uiScale * 100)}%
                  </span>
                </div>
                <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.interfaceSizeHint', 'Scales the whole interface, not just text. Also available anywhere with Ctrl+Shift+Plus, Ctrl+Shift+Minus and Ctrl+Shift+0.')}
                </span>
              </div>

              {/* Font size */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.editorFontSize')}</label>
                <input
                  type="number" min="10" max="30" value={editorFontSize}
                  onChange={(e) => { const val = Number(e.target.value); setEditorFontSize(val); setPreference('editorFontSize', val); }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                />
              </div>

              {/* Tab size */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.tabSize')}</label>
                <select value={editorTabSize} onChange={(e) => { const val = Number(e.target.value); setEditorTabSize(val); setPreference('editorTabSize', val); }} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value={2}>{t('settingsModal.twoSpaces')}</option>
                  <option value={4}>{t('settingsModal.fourSpaces')}</option>
                  <option value={8}>{t('settingsModal.eightSpaces')}</option>
                </select>
              </div>

              {/* Word wrap */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.wordWrap')}</label>
                <select value={editorWordWrap} onChange={(e) => { setEditorWordWrap(e.target.value); setPreference('editorWordWrap', e.target.value); }} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="on">{t('settingsModal.wordWrapOn')}</option>
                  <option value="off">{t('settingsModal.wordWrapOff')}</option>
                </select>
              </div>

              {/* Minimap */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.minimap')}</label>
                <select value={editorMinimap} onChange={(e) => { setEditorMinimap(e.target.value); setPreference('editorMinimap', e.target.value); }} className="vscode-settings-input" style={{ width: '100%' }}>
                  <option value="on">{t('settingsModal.minimapOn')}</option>
                  <option value="off">{t('settingsModal.minimapOff')}</option>
                </select>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.minimapHint')}</span>
              </div>

              {/* Translate to (PDF viewer translation target) */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.translateTo', 'Translate to')}</label>
                <select
                  value={isCustomTranslateLang ? TRANSLATE_CUSTOM : translateTargetLang}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === TRANSLATE_CUSTOM) {
                      setIsCustomTranslateLang(true);
                      return;
                    }
                    setIsCustomTranslateLang(false);
                    setTranslateTargetLang(value);
                    saveTranslateTargetLang(value);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                >
                  <option value="">{t('settingsModal.translateToInterface', 'Same as interface language')}</option>
                  {TRANSLATE_LANGUAGES.map(lang => (
                    <option key={lang.value} value={lang.value}>{t(lang.labelKey, lang.label)}</option>
                  ))}
                  <option value={TRANSLATE_CUSTOM}>{t('settingsModal.translateToOther', 'Other (type a language)')}</option>
                </select>
                {isCustomTranslateLang && (
                  <input
                    type="text"
                    value={translateTargetLang}
                    placeholder={t('settingsModal.translateToOtherPlaceholder', 'e.g. Norwegian')}
                    onChange={(e) => setTranslateTargetLang(e.target.value)}
                    onBlur={(e) => saveTranslateTargetLang(e.target.value.trim())}
                    className="vscode-settings-input"
                    style={{ width: '100%' }}
                  />
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.translateToHint', 'Target language used by the "Translate selection" action in the PDF viewer and the Markdown preview.')}
                </span>
              </div>

              {/* Pronunciation. Next to "Translate to" on purpose: the passage
                  someone most often wants to hear is the one they just had
                  translated, and the two share a language vocabulary. */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.speech', 'Pronunciation')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-text-fg)' }}>
                  <input
                    type="checkbox"
                    checked={!!speech.enabled}
                    onChange={(e) => saveSpeechSettings({ ...speech, enabled: e.target.checked })}
                  />
                  {t('settingsModal.speechEnabled', 'Offer "Pronounce selection" in document menus')}
                </label>

                {speech.enabled && (
                  <>
                    <SpeechVoiceManager
                      selected={speech.local_voice || ''}
                      onSelect={(key) => saveSpeechSettings({ ...speech, local_voice: key })}
                      onChanged={onSpeechSettingsChange}
                    />

                    <div className="flex flex-col" style={{ gap: '4px', maxWidth: '140px' }}>
                      <label style={{ fontSize: '11px', color: 'var(--vscode-text-subtle)' }}>{t('settingsModal.speechSpeed', 'Speed')}</label>
                      <input
                        type="number"
                        min="0.25"
                        max="4"
                        step="0.05"
                        className="vscode-settings-input"
                        value={speech.speed ?? 1}
                        onChange={(e) => setSpeech({ ...speech, speed: e.target.value })}
                        onBlur={() => saveSpeechSettings({ ...speech, speed: Number(speech.speed) || 1 })}
                      />
                    </div>
                  </>
                )}

                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
                  {t('settingsModal.speechHint', 'Reads a selected excerpt aloud in the PDF viewer and the Markdown preview. A downloaded voice runs entirely on this machine and needs no account; it uses the system espeak-ng to turn text into phonemes.')}
                </span>
              </div>

              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.latexCompilation')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-text-fg)' }}>
                  <input
                    type="checkbox"
                    checked={draftSynctexEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDraftSynctexEnabled(checked);
                      saveLatexSettings(checked);
                    }}
                  />
                  <span>{t('settingsModal.draftSynctexEnabled')}</span>
                </label>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.draftSynctexHint')}</span>
              </div>

              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.workspaceFiles')}</label>
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4 }}>
                  {t('settingsModal.hiddenFileExtensionsHint', {
                    extensions: workspaceHiddenExtensions.join(', '),
                  })}
                </span>
              </div>

              {/* Panel max lines */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.panelMaxLines')}</label>
                <input
                  type="number" min="100" max="10000" step="100"
                  value={panelMaxLines}
                  onChange={(e) => {
                    const val = Math.max(100, Math.min(10000, Number(e.target.value) || 1000));
                    setPanelMaxLines(val);
                  }}
                  className="vscode-settings-input"
                  style={{ width: '100%' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--vscode-text-muted)' }}>{t('settingsModal.panelMaxLinesHint')}</span>
              </div>

              {/* Install Tectonic */}
              <div className="flex flex-col" style={{ gap: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.installTectonicTitle')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => {
                      setTectonicInstallMessage('');
                      const btn = document.getElementById('btnInstallTectonic');
                      if (btn) btn.disabled = true;
                      fetch('/api/settings/install-tectonic', { method: 'POST' })
                        .then(r => r.json())
                        .then(async res => {
                          if (res.success) {
                            setTectonicInstallMessage(t('settingsModal.installTectonicSuccess'));
                          } else {
                            await showAlert(t('settingsModal.installTectonicError') + res.error);
                          }
                          if (btn) btn.disabled = false;
                        })
                        .catch(async err => {
                          await showAlert(t('settingsModal.connectionError') + err);
                          if (btn) btn.disabled = false;
                        });
                    }}
                    id="btnInstallTectonic"
                    className="vscode-button"
                  >
                    {t('settingsModal.installTectonicBtn')}
                  </button>
                </div>
                {tectonicInstallMessage && (
                  <span role="status" style={{ fontSize: '11px', color: 'var(--battery-good)' }}>
                    {tectonicInstallMessage}
                  </span>
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.installTectonicHint')}</span>
              </div>

              {/* Install Pandoc */}
              <div className="flex flex-col" style={{ gap: '6px', borderTop: '1px solid var(--vscode-border)', paddingTop: '12px', marginTop: '6px' }}>
                <label className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.installPandocTitle')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => {
                      setPandocInstallMessage('');
                      const btn = document.getElementById('btnInstallPandoc');
                      if (btn) btn.disabled = true;
                      fetch('/api/settings/install-pandoc', { method: 'POST' })
                        .then(r => r.json())
                        .then(async res => {
                          if (res.success) {
                            setPandocInstallMessage(t('settingsModal.installPandocSuccess'));
                          } else {
                            await showAlert(t('settingsModal.installPandocError') + res.error);
                          }
                          if (btn) btn.disabled = false;
                        })
                        .catch(async err => {
                          await showAlert(t('settingsModal.connectionError') + err);
                          if (btn) btn.disabled = false;
                        });
                    }}
                    id="btnInstallPandoc"
                    className="vscode-button"
                  >
                    {t('settingsModal.installPandocBtn')}
                  </button>
                </div>
                {pandocInstallMessage && (
                  <span role="status" style={{ fontSize: '11px', color: 'var(--battery-good)' }}>
                    {pandocInstallMessage}
                  </span>
                )}
                <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{t('settingsModal.installPandocHint')}</span>
              </div>

              <ClaudeSkillsSection />

              <ClaudeModelSection onSessionReplaced={onClaudeSessionReplaced} />
            </>
          )}

          {activeTab === 'about' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--vscode-text-fg)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.version')}</span>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--vscode-text-fg)' }}>{runtimeInfo.version}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.author')}</span>
                <span style={{ fontSize: '13px', color: 'var(--vscode-text-fg)' }}>
                  Gilzamir Gomes</span>
              </div>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
                marginTop: '6px',
                padding: '16px',
                border: '1px solid var(--vscode-border)',
                borderRadius: '8px',
                backgroundColor: 'var(--vscode-sidebar-bg)'
              }}>
                <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span className="vscode-sidebar-section-title" style={{ padding: 0 }}>{t('settingsModal.donationTitle')}</span>
                  <span style={{ fontSize: '12px', lineHeight: '1.5', color: 'var(--vscode-description-fg, #aaaaaa)' }}>
                    {t('settingsModal.donationDescription')}
                  </span>
                  <button
                    className="vscode-button"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => openExternal('https://www.paypal.com/donate/?business=DKWJSCLDJG6XY&no_recurring=0&item_name=Manuten%C3%A7%C3%A3o+do+Software+Open+Source+GilzaBots&currency_code=BRL')}
                  >
                    {t('settingsModal.donationButton')}
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }}>
                  <img
                    src="/qr-code.png"
                    alt={t('settingsModal.donationQrAlt')}
                    style={{ width: '132px', height: '132px', objectFit: 'contain', padding: '6px', backgroundColor: '#ffffff', borderRadius: '6px' }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--vscode-description-fg, #aaaaaa)' }}>
                    {t('settingsModal.donationScan')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="vscode-modal-footer">
          <button onClick={onClose} className="vscode-button">{t('settingsModal.close')}</button>
        </div>
      </div>
    </div>
  );
}
