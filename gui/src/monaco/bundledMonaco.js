// Monaco is part of the application bundle; it is never fetched at run time.
//
// `@monaco-editor/react` defaults to injecting Monaco's AMD loader from
// cdn.jsdelivr.net the first time an editor mounts. That made every text file
// depend on an internet connection the application otherwise does not need,
// and the loader keeps one module-level promise: a single failed fetch (the app
// opened right after a reboot, before the network came back) rejected it for
// the rest of the session, and every editor sat on "Loading..." even once the
// connection returned. Handing the loader the bundled instance makes its
// `init()` resolve from memory and never touch the network.
//
// Importing this module has side effects (it configures the loader and the
// worker factory), so it is loaded once, on first use, by `useBundledMonaco`.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// Monaco's core editor worker is referenced through a bare
// `new URL(..., import.meta.url)`, which Vite copies as a raw file without
// resolving its imports. Building every worker through Vite's `?worker`
// imports bundles each one with its dependencies. The labels are the language
// ids Monaco's language services pass when they start their worker.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });

export default monaco;
