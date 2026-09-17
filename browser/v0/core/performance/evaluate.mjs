import { clipSelection, selectedFrame } from "./frames.mjs";
import { projectPoint, projectionMesh } from "./projection.mjs";
import { performanceAudioAt } from "./audio.mjs";
import { validatePerformance } from "./validation.mjs";

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const mod = (v, n) => ((v % n) + n) % n;
const IDENTITY = [1, 0, 0, 1, 0, 0];
export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function point(m, p) {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}
export function ease(t, kind = "linear") {
  t = clamp(t);
  if (kind === "smoothstep") return t * t * (3 - 2 * t);
  if (kind === "sine") return (1 - Math.cos(Math.PI * t)) / 2;
  if (kind === "hold") return t >= 1 ? 1 : 0;
  return t;
}
const progress = (t, p) =>
  ease((t - p.start_ms) / (p.end_ms - p.start_ms), p.easing);
function sampleKeys(track, t) {
  let a = track.keys[0];
  if (t <= a[0]) return a[1];
  for (const b of track.keys.slice(1)) {
    if (t < b[0])
      return mix(a[1], b[1], ease((t - a[0]) / (b[0] - a[0]), track.easing));
    a = b;
  }
  return a[1];
}
function sample(track, t) {
  let value = sampleKeys(track, t);
  if (track.wave) {
    const first = track.keys[0][0],
      last = track.keys.at(-1)[0];
    if (t > first && t < last)
      value +=
        track.wave.amplitude *
        Math.sin(
          (2 * Math.PI * track.wave.cycles * (t - first)) / (last - first),
        ) **
          (track.wave.power ?? 1);
  }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => k !== "url" && k !== "instructions")
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function signature(story) {
  let hash = 2166136261;
  for (const c of JSON.stringify(canonical(story))) {
    hash ^= c.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function compilePerformance(story) {
  validatePerformance(story);
  const events = [];
  for (const [index, s] of story.scenes.entries())
    events.push({
      source: "stage",
      op: "performance_scene",
      t_ms: s.start_ms,
      scene_index: index,
      scene: canonical(s),
    });
  for (const cue of story.audio)
    events.push({
      source: "stage",
      op: "performance_audio",
      t_ms: cue.start_ms,
      cue: canonical(cue),
    });
  const duration = story.scenes.at(-1).end_ms;
  events.push({
    source: "stage",
    op: "end",
    t_ms: duration,
    scene_index: story.scenes.length - 1,
  });
  const timeline = {
    timeline_version: 1,
    performance_kind: story.performance.kind,
    performance_signature: signature(story),
    title: story.title ?? null,
    duration_ms: duration,
    events: events
      .map((e, i) => ({ ...e, sequence: i }))
      .sort((a, b) => a.t_ms - b.t_ms || a.sequence - b.sequence),
  };
  if (
    story.instructions !== undefined &&
    JSON.stringify(canonical(story.instructions)) !==
      JSON.stringify(canonical(timeline))
  )
    throw new Error("performance instructions do not match authored data");
  return story.instructions ?? timeline;
}

export function performanceStateAt(timeline, story, tMs) {
  if (!Number.isFinite(tMs)) throw new Error("performance time must be finite");
  if (!["wht", "bedtime"].includes(timeline?.performance_kind) || timeline.performance_kind !== story.performance.kind || timeline.timeline_version !== 1)
    throw new Error("performance timeline mismatch");
  const t = Math.max(0, tMs);
  let opened = null;
  for (const e of timeline.events) {
    if (e.t_ms > t) break;
    if (e.op === "performance_scene") opened = e;
  }
  if (!opened) throw new Error("performance has no opening scene");
  const scene = opened.scene,
    local = clamp(t - scene.start_ms, 0, scene.end_ms - scene.start_ms),
    [width, height] = story.performance.resolution;
  const models = new Map(scene.nodes.map((n) => [n.id, n]));
  const memo = new Map();
  function evaluate(id, time) {
    const key = id + "@" + time;
    if (memo.has(key)) return memo.get(key);
    const original = models.get(id);
    if (!original) throw new Error("performance missing node " + id);
    let n = { ...original };
    for (const tr of n.tracks ?? []) n[tr.property] = sample(tr, time);
    const selection = clipSelection(n, story.assets, time);
    n = { ...n, asset: selection.assetId };
    const asset = selection.asset;
    const frame = selectedFrame(selection, time);
    const crop = asset.crop ?? [0, 0, asset.width, asset.height];
    const source =
      asset.type === "sprite"
        ? asset.frames[frame]
        : [crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]];
    const [, , sw, sh] = source;
    const reg = asset.type === "sprite" ? asset.registration : [0, 0, sw, sh];
    const rw = reg[2] - reg[0],
      rh = reg[3] - reg[1];
    const sx = n.width !== undefined ? n.width / rw : n.height / rh,
      sy = n.height !== undefined ? n.height / rh : sx;
    let scaleX = sx * (n.scale_x ?? 1),
      scaleY = sy * (n.scale_y ?? 1);
    const glowing = n.glow && time >= n.glow.start_ms && time < n.glow.end_ms;
    const glowWave = glowing
      ? Math.sin(
          Math.PI *
            Math.min(
              (time - n.glow.start_ms) / n.glow.period_ms,
              n.glow.pulse_cycles ?? Infinity,
            ),
        ) ** 2
      : 0;
    if (glowing) {
      const pulse = 1 + (n.glow.pulse ?? 0) * glowWave;
      scaleX *= pulse;
      scaleY *= pulse;
    }
    let pos = [n.x, n.y];
    const contactPosition = (ref, at) => {
      const actor = evaluate(ref.node, at),
        contact = story.assets[actor.asset].contacts[ref.contact][actor.frame];
      const p = actor.projection
        ? projectPoint(
            actor.projection,
            contact[0] / actor.source[2],
            contact[1] / actor.source[3],
          )
        : point(actor.matrix, contact);
      return [p[0] + (ref.offset?.[0] ?? 0), p[1] + (ref.offset?.[1] ?? 0)];
    };
    const contactAt = (at) => contactPosition(n.attach, at);
    if (n.attach && time >= n.attach.start_ms && time < n.attach.end_ms)
      pos = contactAt(time);
    if (n.path && time >= n.path.start_ms) {
      const p = n.path,
        from = p.from === "attachment" ? contactAt(n.attach.end_ms) : p.from,
        to = Array.isArray(p.to) ? p.to : contactPosition(p.to, p.to.at_ms),
        u = progress(time, p);
      if (p.controls) {
        const [a, b] = p.controls;
        pos = [0, 1].map(
          (i) =>
            (1 - u) ** 3 * from[i] +
            3 * (1 - u) ** 2 * u * a[i] +
            3 * (1 - u) * u * u * b[i] +
            u ** 3 * to[i],
        );
      } else
        pos = [
          mix(from[0], to[0], u),
          mix(from[1], to[1], u) - Math.sin(Math.PI * u) * (p.arc ?? 0),
        ];
    }
    const pivot = n.pivot
      ? [n.pivot[0] * sw, n.pivot[1] * sh]
      : asset.type === "sprite"
        ? [sw / 2, reg[3]]
        : [sw / 2, sh / 2];
    const c = Math.cos(n.rotation ?? 0),
      s = Math.sin(n.rotation ?? 0);
    let matrix = [
      c * scaleX,
      s * scaleX,
      -s * scaleY,
      c * scaleY,
      pos[0] - c * scaleX * pivot[0] + s * scaleY * pivot[1],
      pos[1] - s * scaleX * pivot[0] - c * scaleY * pivot[1],
    ];
    const localMatrix = matrix;
    const parent = n.parent ? evaluate(n.parent, time) : null;
    if (parent) matrix = multiply(parent.matrix, matrix);
    let hidden = n.visible && (time < n.visible[0] || time >= n.visible[1]);
    let mask = n.mask ?? null;
    if (mask?.type === "contact") {
      const active = time >= mask.start_ms && time < mask.end_ms;
      const contact = active ? asset.contacts[mask.contact][frame] : null;
      const world = contact ? point(matrix, contact) : null;
      if (!active || (mask.min_y !== undefined && world[1] < mask.min_y))
        hidden = true;
      const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
      mask = {
        type: "polygon",
        points:
          contact && determinant
            ? mask.points.map(([x, y]) => [
                contact[0] + (matrix[3] * x - matrix[2] * y) / determinant,
                contact[1] + (-matrix[1] * x + matrix[0] * y) / determinant,
              ])
            : [
                [0, 0],
                [0, 0],
                [0, 0],
              ],
      };
    }
    const projection = projectedCorners(n, parent, localMatrix, sw, sh);
    const projectionClips = projection
      ? [...(parent?.projectionClips ?? []), projection]
      : [];
    if (projection && mask) {
      const m = mask;
      const points =
        m.type === "rect"
          ? [
              [m.rect[0], m.rect[1]],
              [m.rect[0] + m.rect[2], m.rect[1]],
              [m.rect[0] + m.rect[2], m.rect[1] + m.rect[3]],
              [m.rect[0], m.rect[1] + m.rect[3]],
            ]
          : m.points;
      projectionClips.push(
        points.map((p) => projectPoint(projection, p[0] / sw, p[1] / sh)),
      );
    }
    const result = {
      id: n.id,
      asset: n.asset,
      media: asset.media,
      url: asset.url ?? asset.media,
      frame,
      source,
      matrix,
      position: parent ? point(parent.matrix, pos) : pos,
      shape: asset.shape ?? null,
      opacity: hidden ? 0 : (n.opacity ?? 1) * (parent?.opacity ?? 1),
      depth: n.depth ?? pos[1],
      space: n.space ?? parent?.space ?? "scene",
      glow: glowing
        ? {
            color: n.glow.color,
            blur: n.glow.blur + (n.glow.blur_pulse ?? 0) * glowWave,
          }
        : null,
      mask,
      water: n.water
        ? {
            ...n.water,
            line: reg[3] - rh * n.water.line_from_feet,
            sourceHeight: rh,
          }
        : null,
      projection,
      projectionMesh: projectionMesh(projection),
      projectionClips,
      lights: (n.lights ?? []).map((l) => ({
        ...l,
        opacity:
          (0.5 +
            0.5 *
              Math.sin(2 * Math.PI * (time / l.period_ms + (l.phase ?? 0)))) **
          2,
      })),
      particles: particleState(n.particles, time, sw, sh),
      travel: n.travel ? travelState(n.travel, time, width, height) : null,
    };
    memo.set(key, result);
    return result;
  }
  const renderNodes = scene.nodes
    .map((n, i) => ({ ...evaluate(n.id, local), order: i }))
    .filter((n) => n.opacity > 0)
    .sort((a, b) => a.depth - b.depth || a.order - b.order);
  const cam = scene.camera,
    at = cam ? progress(local, cam) : 0;
  const focus = cam
    ? cam.from.map((v, i) => mix(v, cam.to[i], at))
    : [width / 2, height / 2, 1];
  let multiplier = 1;
  for (const track of cam?.tracks ?? []) {
    const value = sample(track, local);
    if (track.property === "zoom_multiplier") multiplier = value;
    else focus[["focus_x", "focus_y", "zoom"].indexOf(track.property)] = value;
  }
  const zoom = focus[2] * multiplier;
  const cx = clamp(focus[0], width / (2 * zoom), width - width / (2 * zoom)),
    cy = clamp(focus[1], height / (2 * zoom), height - height / (2 * zoom));
  const camera = {
    scale: zoom,
    x: (100 * (width / 2 - cx * zoom)) / width,
    y: (100 * (height / 2 - cy * zoom)) / height,
  };
  const caption = story.captions?.find(
    (cue) => t >= cue.start_ms && t < cue.end_ms,
  );
  const narration = story.audio.find(
    (a) =>
      a.kind === "narration" &&
      t >= a.start_ms &&
      t < (a.end_ms ?? a.start_ms + a.duration_ms),
  );
  const transition =
    scene.transition && local < scene.transition.duration_ms
      ? {
          color: scene.transition.color,
          opacity: 1 - local / scene.transition.duration_ms,
        }
      : null;
  return {
    tMs: t,
    sceneIndex: opened.scene_index,
    place: scene.setting_id ?? scene.id,
    plate: { resolution: [width, height] },
    actors: [],
    camera,
    audio: performanceAudioAt(story, t),
    subtitle: Object.hasOwn(story, "captions")
      ? caption?.text ?? ""
      : narration?.text ?? "",
    ended: t >= timeline.duration_ms,
    warnings: [],
    renderNodes,
    transition,
  };
}

function particleState(p, t, w, h) {
  if (!p || t < p.start_ms || t >= p.end_ms) return [];
  return Array.from({ length: p.count }, (_, i) => {
    const age = mod(
        (t - (p.clock_start_ms ?? p.start_ms)) / (p.period_ms ?? 1250) +
          i * (p.phase_step ?? 0.081) +
          (p.seed ?? 0) * 0.001,
        1,
      ),
      a = i * 2.399,
      r = (p.radial_start ?? 8) + age * (p.radius ?? 30);
    const x = w / 2 + Math.cos(a) * r,
      y =
        h / 2 +
        Math.sin(a) * r * (p.vertical_scale ?? 1) -
        age * (p.rise ?? 10),
      radius = mix(p.size_from ?? 2.5, p.size_to ?? 0, age);
    const polygon = p.points
      ? Array.from({ length: p.points * 2 }, (_, k) => {
          const angle =
            (k * Math.PI) / p.points -
            Math.PI / 2 +
            a +
            ((t - (p.clock_start_ms ?? p.start_ms)) / 1000) *
              (p.rotation_speed ?? 0);
          const length = radius * (k % 2 ? (p.inner ?? 0.4) : 1);
          return [x + Math.cos(angle) * length, y + Math.sin(angle) * length];
        })
      : null;
    return {
      x,
      y,
      radius,
      ...(polygon
        ? {
            points: polygon,
            stroke: p.stroke ?? null,
            stroke_width: p.stroke_width ?? 0,
          }
        : {}),
      opacity: Math.sin(age * Math.PI) * (p.opacity ?? 0.8),
      color: p.colors?.[i % p.colors.length] ?? p.color,
    };
  });
}
function travelState(p, t, w, h) {
  const duration = p.end_ms - p.start_ms,
    elapsed = clamp(t - p.start_ms, 0, duration),
    a = clamp(p.ease_in_ms ?? 0, 0, duration / 2),
    z = clamp(p.ease_out_ms ?? 0, 0, duration / 2),
    integral = (u) => u * u * u - 0.5 * u * u * u * u;
  const covered =
    a && elapsed < a
      ? a * integral(elapsed / a)
      : z && elapsed > duration - z
        ? duration - (a + z) / 2 - z * integral((duration - elapsed) / z)
        : elapsed - a / 2;
  const distance = (p.offset ?? 0) + (p.speed * covered) / 1000,
    scale = p.scale ?? 1,
    tileWidth = w * scale,
    tileHeight = h * scale;
  if (p.repeat === false) {
    const d = clamp(distance, 0, Math.max(0, tileWidth - w));
    return {
      tiles: [
        {
          x: p.direction === 1 ? w - tileWidth + d : -d,
          y: (h - tileHeight) / 2,
          width: tileWidth,
          height: tileHeight,
          flip: false,
        },
      ],
    };
  }
  const offset = (p.direction === 1 ? -1 : 1) * distance,
    base = Math.floor(offset / tileWidth),
    dx = -mod(offset, tileWidth);
  return {
    tiles: [-1, 0, 1, 2].map((i) => ({
      x: dx + i * tileWidth,
      y: (h - tileHeight) / 2,
      width: tileWidth,
      height: tileHeight,
      flip: mod(base + i, 2) === 1,
    })),
  };
}

function projectedCorners(n, parent, localMatrix, width, height) {
  const corners =
    n.projection?.corners ??
    [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ].map((p) => point(localMatrix, p));
  if (parent?.projection) {
    const [, , w, h] = parent.source,
      c = parent.projection;
    return corners.map(([x, y]) => projectPoint(c, x / w, y / h));
  }
  return n.projection
    ? corners.map((p) => point(parent?.matrix ?? IDENTITY, p))
    : null;
}
