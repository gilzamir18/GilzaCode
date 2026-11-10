import { useMemo } from 'react';

// Resolves a relative reference (e.g. "./style.css", "../img/a.png", "assets/x.js")
// found inside an HTML file against the directory that file lives in, so the
// rewritten path can be fetched through /api/file/raw regardless of where the
// HTML file sits in the project tree.
function resolveRelativeUrl(baseDir, ref) {
  const trimmed = (ref || '').trim();
  if (!trimmed) return null;
  if (/^([a-z][a-z0-9+.-]*:)/i.test(trimmed)) return null; // http:, https:, data:, mailto:, etc.
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return null; // protocol-relative / in-page anchor

  const baseParts = trimmed.startsWith('/') ? [] : (baseDir ? baseDir.split('/').filter(Boolean) : []);
  const refParts = trimmed.replace(/^\//, '').split('/');
  refParts.forEach((part) => {
    if (part === '' || part === '.') return;
    if (part === '..') { baseParts.pop(); return; }
    baseParts.push(part);
  });
  return baseParts.join('/');
}

// Tag/attribute pairs whose values reference project-relative assets that
// need to be resolved through the file API to render inside the preview.
const REWRITE_ATTRS = [
  ['img', 'src'],
  ['script', 'src'],
  ['link', 'href'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['iframe', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
];

function buildPreviewDocument(rawHtml, projectPath, selectedFile) {
  const dir = selectedFile ? selectedFile.split('/').slice(0, -1).join('/') : '';
  const doc = new DOMParser().parseFromString(rawHtml || '', 'text/html');

  const toRawUrl = (relPath) =>
    `/api/file/raw?projectPath=${encodeURIComponent(projectPath || '')}&filePath=${encodeURIComponent(relPath)}`;

  REWRITE_ATTRS.forEach(([tag, attr]) => {
    doc.querySelectorAll(tag).forEach((el) => {
      const resolved = resolveRelativeUrl(dir, el.getAttribute(attr));
      if (resolved !== null) el.setAttribute(attr, toRawUrl(resolved));
    });
  });

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

// Live preview of an HTML file's source, rendered in a sandboxed iframe.
// Scripts run inside the iframe's own opaque origin (no `allow-same-origin`),
// isolating them from the app's window, cookies and local storage.
export default function HtmlPreview({ html, activeProjectPath, selectedFile, title, zoomLevel = 1 }) {
  const srcDoc = useMemo(
    () => buildPreviewDocument(html, activeProjectPath, selectedFile),
    [html, activeProjectPath, selectedFile]
  );

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'auto', background: '#fff' }}>
      <iframe
        title={title || 'HTML Preview'}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          background: '#fff',
          transform: `scale(${zoomLevel})`,
          transformOrigin: 'top left',
        }}
      />
    </div>
  );
}
