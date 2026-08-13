export async function runStory(story, deps) {
  const context = { story, ...deps };

  for (const [sceneIndex, scene] of (story.scenes ?? []).entries()) {
    context.scene = scene;
    context.sceneIndex = sceneIndex;
    await deps.beginScene(scene, context);

    for (const step of scene.steps ?? []) {
      await runStep(step, context);
    }

    await deps.endScene(scene, context);
  }

  return context;
}

export async function beginScene(scene, context) {
  return context.beginScene(scene, context);
}

export async function endScene(scene, context) {
  return context.endScene(scene, context);
}

async function runStep(step, context) {
  if (step.kind === 'together') {
    const tick = context.clock.now();
    logStep(step, context, null, tick);
    for (const child of step.steps ?? []) logStep(child, context, step, tick);

    if (typeof context.performTogether === 'function') {
      context.performTogether(step.steps ?? [], context);
    } else {
      for (const child of step.steps ?? []) fireCommand(child, context);
    }
    return;
  }

  logStep(step, context);

  if (step.kind === 'chunk') {
    await context.playChunk(step, context);
    return;
  }

  if (step.kind === 'cmd' && step.cmd === 'pause') {
    await context.clock.wait(step.seconds * 1000);
    return;
  }

  if (step.kind === 'cmd') fireCommand(step, context);
}

function fireCommand(step, context) {
  context.performCommand(step, context);
}

function logStep(step, context, together = null, tick = undefined) {
  const { kind, line, cmd, ...detail } = step;
  if (together) detail.together_line = together.line;

  const entry = {
    scene_index: context.sceneIndex,
    line,
    kind,
    ...(tick === undefined ? {} : { t_ms: tick }),
    ...(cmd === undefined ? {} : { cmd }),
    detail: sortedDetail(detail),
  };
  context.log.append(entry);
}

function sortedDetail(value) {
  if (Array.isArray(value)) return value.map(sortedDetail);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedDetail(value[key])]),
  );
}
