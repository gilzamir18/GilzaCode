// Maps a file extension to the Monaco Editor language identifier.

const EXT_MAP = {
  py: 'python',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'html',
  css: 'css',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  tex: 'latex',
};

export const getLanguage = (filename) => {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop().toLowerCase();
  return EXT_MAP[ext] || 'plaintext';
};
