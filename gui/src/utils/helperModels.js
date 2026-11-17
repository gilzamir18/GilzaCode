// The model a helper task runs on when it has no setting of its own: its
// default, or what the task it follows runs on (helper_models.py, model_for).
// `models` is {task: alias or ""}; `tasks` is {task: {default} | {follows}}.
export function effectiveModel(task, models, tasks) {
  let current = task;
  for (let guard = 0; guard < 8 && current; guard += 1) {
    if (models[current]) return models[current];
    const spec = tasks[current] || {};
    if (spec.default) return spec.default;
    current = spec.follows;
  }
  return '';
}
