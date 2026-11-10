import React from 'react';
import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Marks a file an agent turn changed (or, with `inside`, a folder holding one)
// in the workspace tree and the editor tabs. Deliberately not the ` *` of an
// unsaved buffer: the agent writes to disk, so its files have nothing to save.
// The robot is the same symbol the Git sidebar uses for the agent's history.
export default function AgentChangeBadge({ inside = false, style }) {
  const { t } = useTranslation();
  const label = inside
    ? t('explorer.agentChangedInside', 'Contains files changed by the agent')
    : t('explorer.agentChanged', 'Changed by the agent (cleared when you open the file)');
  return (
    <Bot
      size={inside ? 10 : 12}
      color="var(--vscode-accent, #4d9cf8)"
      style={{ flexShrink: 0, marginLeft: '4px', opacity: inside ? 0.7 : 1, ...style }}
      aria-label={label}
    >
      <title>{label}</title>
    </Bot>
  );
}
