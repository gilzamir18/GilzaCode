import React from 'react';
import { Check, RefreshCw, CloudUpload, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Per-file cloud sync marker in the workspace tree, the way a desktop Drive
// client marks a folder: the state of the project as a whole cannot say which
// file is still waiting to go up, or which one needs a decision.
//
// Excluded files get no badge at all. A mark on every build artifact and on
// .env would drown out the few files that actually carry information.
const BADGES = {
  synced: {
    Icon: Check,
    color: 'var(--vscode-fg-success)',
    labelKey: 'explorer.cloudSynced',
    fallback: 'Synced to the cloud',
  },
  pending: {
    Icon: CloudUpload,
    color: 'var(--vscode-text-subtle)',
    labelKey: 'explorer.cloudPending',
    fallback: 'Waiting for the next sync',
  },
  syncing: {
    Icon: RefreshCw,
    color: 'var(--vscode-accent, #007acc)',
    labelKey: 'explorer.cloudSyncing',
    fallback: 'Syncing now',
    spin: true,
  },
  conflict: {
    Icon: AlertTriangle,
    color: 'var(--vscode-fg-warning)',
    labelKey: 'explorer.cloudConflict',
    fallback: 'Changed in both places — needs a decision',
  },
};

export default function CloudFileBadge({ state }) {
  const { t } = useTranslation();
  const badge = BADGES[state];
  if (!badge) return null;

  const { Icon, color, labelKey, fallback, spin } = badge;
  const label = t(labelKey, fallback);
  return (
    <Icon
      size={11}
      color={color}
      className={spin ? 'animate-spin' : undefined}
      style={{ flexShrink: 0, marginLeft: 'auto' }}
      aria-label={label}
    >
      <title>{label}</title>
    </Icon>
  );
}
