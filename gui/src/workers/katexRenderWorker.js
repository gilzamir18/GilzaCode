import katex from 'katex';
import { validateRenderableMath } from '../utils/mathValidation';

self.onmessage = (event) => {
  const { id, math, displayMode } = event.data || {};
  try {
    const validation = validateRenderableMath(math, { displayMode: !!displayMode });
    if (!validation.ok) {
      self.postMessage({ id, errorKey: validation.reasonKey, errorParams: validation.reasonParams });
      return;
    }

    const html = katex.renderToString(validation.math, {
      displayMode: !!displayMode,
      throwOnError: true,
      maxExpand: 250,
      maxSize: 10,
      output: 'mathml',
      strict: 'ignore',
    });
    self.postMessage({ id, html });
  } catch (error) {
    self.postMessage({ id, errorKey: 'richTextEditor.math.renderFailed', errorParams: { message: String(error) } });
  }
};
