// Serialize writes to each document while allowing independent files to save.
// Include the project in the key: two projects may both have a main.tex.
export function createFileSaveQueue() {
  const pending = new Map();
  return {
    async run(projectPath, filePath, write) {
      const key = JSON.stringify([projectPath, filePath]);
      const previous = pending.get(key) || Promise.resolve();
      const current = previous.catch(() => {}).then(write);
      pending.set(key, current);
      try {
        return await current;
      } finally {
        if (pending.get(key) === current) pending.delete(key);
      }
    },
  };
}
