export function desiredFacing(subjectX, target) {
  if (target === null || target === undefined) return 'camera';
  const targetX = typeof target === 'number' ? target : target.x;
  return targetX < subjectX ? 'left' : 'right';
}

export function selectFacingClip(capability, verb, facing, onWarning = () => {}) {
  const variants = capability?.[verb] ?? {};
  const request = normalizeFacing(facing);

  if (request.direction !== 'camera' && variants[request.direction]) {
    return variants[request.direction];
  }

  if (request.direction === 'camera' && variants.camera) {
    return variants.camera;
  }

  if (variants.camera) {
    warn(onWarning, verb, request.direction, 'camera');
    return variants.camera;
  }

  if (request.direction !== 'camera') {
    const opposite = request.direction === 'left' ? 'right' : 'left';
    if (variants[opposite]) {
      warn(onWarning, verb, request.direction, opposite);
      return variants[opposite];
    }
    warn(onWarning, verb, request.direction, null);
    return null;
  }

  const crowdDirection = request.crowd;
  if (crowdDirection && variants[crowdDirection]) {
    warn(onWarning, verb, 'camera', crowdDirection);
    return variants[crowdDirection];
  }

  // Toward the middle of the FLOOR, not of the plate: the other characters all
  // stand on the floor, so a plate midpoint would turn a character away from
  // the scene on any floor that is not centred. Falls back to the plate.
  const centerDirection = request.subjectX <= request.centerX ? 'right' : 'left';
  if (variants[centerDirection]) {
    warn(onWarning, verb, 'camera', centerDirection);
    return variants[centerDirection];
  }

  const firstSide = variants.right ? 'right' : variants.left ? 'left' : null;
  warn(onWarning, verb, 'camera', firstSide);
  return firstSide ? variants[firstSide] : null;
}

export function selectLocomotion(capability, onWarning = () => {}) {
  for (const verb of ['move', 'walk', 'fly']) {
    if (hasVariants(capability?.[verb])) return verb;
  }
  onWarning({ policy: 'missing-locomotion' });
  return null;
}

export function frameIndexAt(timeSeconds, fps, frames) {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(fps) || !Number.isInteger(frames) || frames <= 0) {
    return 0;
  }
  const index = Math.floor(timeSeconds * fps);
  return ((index % frames) + frames) % frames;
}

export function frameCell(index, grid) {
  const [columns, rows] = grid;
  const total = columns * rows;
  const wrapped = ((index % total) + total) % total;
  return [wrapped % columns, Math.floor(wrapped / columns)];
}

const PLATE_CENTER_PCT = 50;

function normalizeFacing(facing) {
  if (typeof facing === 'string') {
    return { direction: facing, crowd: null, subjectX: PLATE_CENTER_PCT, centerX: PLATE_CENTER_PCT };
  }
  const centerX = facing?.centerX;
  return {
    direction: facing?.requested ?? facing?.direction ?? 'camera',
    crowd: facing?.crowd ?? facing?.crowdDirection ?? null,
    subjectX: facing?.subjectX ?? facing?.x ?? PLATE_CENTER_PCT,
    centerX: Number.isFinite(centerX) ? centerX : PLATE_CENTER_PCT,
  };
}

function hasVariants(variants) {
  return variants && typeof variants === 'object' && Object.keys(variants).length > 0;
}

function warn(onWarning, verb, requested, selected) {
  onWarning({ policy: 'facing-fallback', verb, requested, selected });
}
