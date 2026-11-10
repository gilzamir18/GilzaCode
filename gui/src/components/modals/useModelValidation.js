import { useState, useEffect } from 'react';

export function useModelValidation(modelName, apiBase = '') {
  const [hardware, setHardware] = useState(null);
  const [modelStatus, setModelStatus] = useState('unknown'); // 'unknown', 'green', 'yellow', 'red'
  
  useEffect(() => {
    fetch('/api/hardware')
      .then(r => r.json())
      .then(data => setHardware(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!hardware || !modelName) {
      setModelStatus('unknown');
      return;
    }

    const validate = async () => {
      // If it's a known hosted provider, return green
      if (modelName.startsWith('gemini/') || modelName.startsWith('openai/') || modelName.startsWith('anthropic/')) {
        setModelStatus('green');
        return;
      }

      let sizeGb = 0;
      let found = false;

      try {
        const params = new URLSearchParams({ model: modelName });
        if (apiBase) params.set('api_base', apiBase);
        const res = await fetch(`/api/models/info?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          if (data.found) {
            sizeGb = data.size_gb;
            found = true;
          }
        }
      } catch (e) {
        // ignore
      }

      if (!found) {
        // Fallback to regex estimation
        const match = modelName.match(/(\d+(?:\.\d+)?)[bB]/);
        if (match) {
          const paramsB = parseFloat(match[1]);
          // Rough estimation for Q4_K_M: ~0.65 GB per 1B params + 1GB context
          sizeGb = (paramsB * 0.65) + 1;
        } else {
          setModelStatus('unknown');
          return;
        }
      }

      const vram = parseFloat(hardware.vram_gb) || 0;
      const ram = parseFloat(hardware.ram_gb) || 0;

      if (sizeGb < vram * 0.9) {
        setModelStatus('green');
      } else if (sizeGb < (vram + ram) * 0.8) {
        setModelStatus('yellow');
      } else {
        setModelStatus('red');
      }
    };

    const timer = setTimeout(validate, 500); // debounce
    return () => clearTimeout(timer);
  }, [modelName, apiBase, hardware]);

  return { hardware, modelStatus };
}
