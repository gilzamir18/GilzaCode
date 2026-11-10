export const MSG_AGENT_START = 'Agent turn start checkpoint';
export const MSG_AGENT_END = 'Agent turn end checkpoint';
export const MSG_AGENT_TOOL = 'Agent tool checkpoint';

function parseAgentTurnCheckpoint(message, phase) {
  const base = phase === 'end' ? MSG_AGENT_END : MSG_AGENT_START;
  if (message === base) return { phase, label: '' };
  const prefix = `${base}: `;
  if (message?.startsWith(prefix)) {
    return { phase, label: message.slice(prefix.length).trim() };
  }
  return null;
}

export function groupAgentTurns(commits) {
  const out = [];
  const used = new Set();

  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i];
    const commitKey = commit.hash || `${commit.message}:${i}`;
    if (used.has(commitKey)) continue;

    const endMeta = parseAgentTurnCheckpoint(commit.message, 'end');
    if (!endMeta) {
      if (
        parseAgentTurnCheckpoint(commit.message, 'start')
        || commit.message?.startsWith(MSG_AGENT_TOOL)
      ) {
        continue;
      }
      out.push({ type: 'commit', commit });
      continue;
    }

    const tools = [];
    let start = null;
    let startKey = '';
    for (let j = i + 1; j < commits.length; j += 1) {
      const candidate = commits[j];
      const candidateKey = candidate.hash || `${candidate.message}:${j}`;
      if (used.has(candidateKey)) continue;

      const startMeta = parseAgentTurnCheckpoint(candidate.message, 'start');
      if (startMeta && startMeta.label === endMeta.label) {
        start = candidate;
        startKey = candidateKey;
        break;
      }

      if (candidate.message?.startsWith(MSG_AGENT_TOOL)) {
        tools.push({ commit: candidate, key: candidateKey });
      }
    }

    if (!start) {
      continue;
    }

    used.add(commitKey);
    used.add(startKey);
    tools.forEach(tool => used.add(tool.key));
    out.push({ type: 'agent_turn', start, end: commit, tools: tools.map(tool => tool.commit) });
  }

  return out;
}
