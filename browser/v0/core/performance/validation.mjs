import { sampledFrames, clipSelection, selectedFrame } from "./frames.mjs";
import { projectPoint } from "./projection.mjs";
export const PERFORMANCE_CAPABILITIES = Object.freeze([
  "transform",
  "clip",
  "attachment",
  "path",
  "glow",
  "mask",
  "water",
  "projection",
  "lights",
  "particles",
  "travel",
  "camera",
  "layers",
  "audio",
  "segments",
  "transition",
  "shapes",
  "captions",
]);
const SCALARS = new Set([
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "scale_x",
  "scale_y",
  "opacity",
  "depth",
]);
const EASINGS = new Set(["linear", "smoothstep", "sine", "hold"]);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (where, message) => {
  throw new Error("performance " + where + ": " + message);
};
function record(o, where, keys) {
  if (!o || typeof o !== "object" || Array.isArray(o))
    fail(where, "expected object");
  if (keys)
    for (const k of Object.keys(o))
      if (!keys.split(" ").includes(k)) fail(where, "unknown field " + k);
}
function finite(x, where, min = -Infinity, max = Infinity) {
  if (!Number.isFinite(x) || x < min || x > max)
    fail(where, "invalid finite number");
}
function vector(x, n, where) {
  if (!Array.isArray(x) || x.length !== n)
    fail(where, "expected " + n + " numbers");
  x.forEach((v) => finite(v, where));
}
function interval(o, where) {
  finite(o.start_ms, where + ".start_ms", 0);
  finite(o.end_ms, where + ".end_ms", o.start_ms + Number.EPSILON);
  if (o.end_ms <= o.start_ms) fail(where, "empty interval");
}
function easing(o, where) {
  if (o.easing !== undefined && !EASINGS.has(o.easing))
    fail(where, "unknown easing");
}
function color(v, where) {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v))
    fail(where, "invalid color");
}
function media(v, where) {
  if (
    typeof v !== "string" ||
    !v.includes("/") ||
    !v
      .split("/")
      .every(
        (x) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x) && x !== "." && x !== "..",
      )
  )
    fail(where, "expected bucket-qualified media key");
}
function finiteTree(v, where) {
  if (["function", "symbol", "undefined", "bigint"].includes(typeof v))
    fail(where, "expected JSON data");
  if (typeof v === "number") finite(v, where);
  else if (Array.isArray(v)) v.forEach((x) => finiteTree(x, where));
  else if (v && typeof v === "object")
    Object.values(v).forEach((x) => finiteTree(x, where));
}
function clip(c, asset, where) {
  if (!c) return;
  record(c, where, "fps frames loop start_ms hold");
  if (c.fps !== undefined) finite(c.fps, where + ".fps", 0.001, 120);
  if (c.start_ms !== undefined) finite(c.start_ms, where + ".start_ms");
  if (c.loop !== undefined && typeof c.loop !== "boolean")
    fail(where, "loop must be boolean");
  if (c.frames !== undefined) {
    if (!Array.isArray(c.frames) || !c.frames.length)
      fail(where, "empty frame selection");
    for (const f of c.frames)
      if (!Number.isInteger(f) || f < 0 || f >= (asset.frames?.length ?? 1))
        fail(where, "frame outside asset");
  }
  if (
    c.hold !== undefined &&
    (!Number.isInteger(c.hold) ||
      c.hold < 0 ||
      c.hold >= (asset.frames?.length ?? 1))
  )
    fail(where, "invalid hold frame");
}

export function validatePerformance(story) {
  record(story, "story");
  finiteTree(story, "story");
  record(story.performance, "header", "kind resolution required_capabilities");
  if (!["wht", "bedtime"].includes(story.performance.kind)) fail("kind", "unsupported input");
  vector(story.performance.resolution, 2, "resolution");
  story.performance.resolution.forEach((v) => finite(v, "resolution", 1, 8192));
  if (!Array.isArray(story.performance.required_capabilities))
    fail("required_capabilities", "expected list");
  for (const c of story.performance.required_capabilities)
    if (!PERFORMANCE_CAPABILITIES.includes(c))
      fail("capability", "unsupported " + c);
  record(story.assets, "assets");
  for (const [id, a] of Object.entries(story.assets)) {
    record(
      a,
      "asset " + id,
      "type media url width height frames registration contacts crop provenance shape",
    );
    if (!["image", "sprite", "shape"].includes(a.type))
      fail(id, "unsupported asset type");
    if (a.type !== "shape") media(a.media, id);
    finite(a.width, id + ".width", 1, 65536);
    finite(a.height, id + ".height", 1, 65536);
    if (a.type === "shape") {
      const q = a.shape;
      record(
        q,
        id + ".shape",
        "kind fill stroke stroke_width radius start_angle end_angle bounds shadow",
      );
      if (!["rect", "roundrect", "ellipse", "arc"].includes(q.kind))
        fail(id, "unknown shape");
      if (!q.fill && !q.stroke) fail(id, "shape needs fill or stroke");
      if (q.fill) color(q.fill, id);
      if (q.stroke) color(q.stroke, id);
      if (q.stroke_width !== undefined) finite(q.stroke_width, id, 0, 1024);
      if (q.radius !== undefined) finite(q.radius, id, 0);
      if (q.bounds) vector(q.bounds, 4, id);
      if (q.kind === "arc") {
        finite(q.start_angle, id);
        finite(q.end_angle, id);
      }
      if (q.shadow) {
        record(q.shadow, id, "color blur offset");
        color(q.shadow.color, id);
        finite(q.shadow.blur, id, 0, 128);
        vector(q.shadow.offset, 2, id);
      }
    }
    if (a.type === "sprite") {
      if (!Array.isArray(a.frames) || !a.frames.length)
        fail(id, "missing frames");
      a.frames.forEach((r) => {
        vector(r, 4, id);
        if (
          r[0] < 0 ||
          r[1] < 0 ||
          r[2] <= 0 ||
          r[3] <= 0 ||
          r[0] + r[2] > a.width ||
          r[1] + r[3] > a.height
        )
          fail(id, "frame outside image");
      });
      vector(a.registration, 4, id + ".registration");
      if (
        a.registration[2] <= a.registration[0] ||
        a.registration[3] <= a.registration[1]
      )
        fail(id, "empty registration");
    }
    if (a.crop) {
      vector(a.crop, 4, id + ".crop");
      if (
        a.crop[0] < 0 ||
        a.crop[1] < 0 ||
        a.crop[2] > a.width ||
        a.crop[3] > a.height ||
        a.crop[2] <= a.crop[0] ||
        a.crop[3] <= a.crop[1]
      )
        fail(id, "invalid crop");
    }
    if (a.contacts) {
      record(a.contacts, id + ".contacts");
      for (const points of Object.values(a.contacts)) {
        if (!Array.isArray(points) || points.length !== a.frames?.length)
          fail(id, "contacts must cover frames");
        for (const p of points) if (p !== null) vector(p, 2, id + ".contact");
      }
    }
  }
  if (!Array.isArray(story.scenes) || !story.scenes.length)
    fail("scenes", "nonempty scenes required");
  let end = 0;
  const sceneIds = new Set();
  for (const scene of story.scenes) {
    record(
      scene,
      "scene",
      "id setting_id start_ms end_ms nodes camera transition metadata",
    );
    interval(scene, scene.id);
    if (typeof scene.id !== "string" || sceneIds.has(scene.id))
      fail("scene", "duplicate/missing id");
    sceneIds.add(scene.id);
    if (scene.start_ms !== end) fail(scene.id, "scenes must be contiguous");
    end = scene.end_ms;
    if (!Array.isArray(scene.nodes)) fail(scene.id, "nodes must be array");
    const nodes = new Map();
    for (const n of scene.nodes) {
      if (typeof n.id !== "string" || nodes.has(n.id))
        fail(scene.id, "duplicate/missing node id");
      nodes.set(n.id, n);
    }
    for (const n of scene.nodes) {
      const where = scene.id + "/" + n.id;
      record(
        n,
        where,
        "id asset x y width height pivot rotation scale_x scale_y opacity depth space visible parent clip segments tracks path attach glow mask water projection lights particles travel metadata",
      );
      if (!own(story.assets, n.asset)) fail(where, "unknown asset " + n.asset);
      finite(n.x, where + ".x");
      finite(n.y, where + ".y");
      if (n.width === undefined && n.height === undefined)
        fail(where, "width or height required");
      for (const p of SCALARS)
        if (n[p] !== undefined)
          finite(
            n[p],
            where + "." + p,
            ["width", "height"].includes(p) ? 0.001 : -Infinity,
          );
      if (n.opacity !== undefined) finite(n.opacity, where + ".opacity", 0, 1);
      if (n.pivot) vector(n.pivot, 2, where + ".pivot");
      if (n.space !== undefined && !["scene", "screen"].includes(n.space))
        fail(where, "unknown space");
      if (n.visible) {
        vector(n.visible, 2, where);
        if (n.visible[1] <= n.visible[0]) fail(where, "empty visibility");
      }
      clip(n.clip, story.assets[n.asset], where + ".clip");
      if (n.segments !== undefined && !Array.isArray(n.segments))
        fail(where, "segments must be array");
      if (n.tracks !== undefined && !Array.isArray(n.tracks))
        fail(where, "tracks must be array");
      if (n.lights !== undefined && !Array.isArray(n.lights))
        fail(where, "lights must be array");
      let previous = 0;
      for (const seg of n.segments ?? []) {
        record(seg, where + ".segment", "start_ms end_ms asset clip");
        interval(seg, where);
        if (seg.start_ms < previous) fail(where, "overlapping segments");
        previous = seg.end_ms;
        if (!own(story.assets, seg.asset)) fail(where, "missing segment asset");
        clip(seg.clip, story.assets[seg.asset], where);
      }
      const writes = new Set();
      for (const tr of n.tracks ?? []) {
        record(tr, where + ".track", "property keys easing wave");
        if (!SCALARS.has(tr.property) || writes.has(tr.property))
          fail(where, "unknown/conflicting track");
        writes.add(tr.property);
        if (tr.wave) {
          record(tr.wave, where + ".wave", "amplitude cycles power");
          finite(tr.wave.amplitude, where);
          finite(tr.wave.cycles, where, 0, 128);
          if (tr.wave.power !== undefined && ![1, 2].includes(tr.wave.power))
            fail(where, "unsupported wave power");
          if (tr.keys?.length < 2) fail(where, "wave needs interval");
        }
        easing(tr, where);
        if (!Array.isArray(tr.keys) || !tr.keys.length)
          fail(where, "empty track");
        let last = -1;
        for (const k of tr.keys) {
          vector(k, 2, where);
          if (k[0] <= last) fail(where, "track keys not increasing");
          last = k[0];
        }
      }
      if (n.path) {
        const p = n.path;
        record(
          p,
          where + ".path",
          "start_ms end_ms from to arc controls easing",
        );
        interval(p, where);
        easing(p, where);
        if (p.from === "attachment") {
          if (!n.attach || p.start_ms !== n.attach.end_ms)
            fail(where, "release path must begin at attachment end");
        } else vector(p.from, 2, where);
        if (Array.isArray(p.to)) vector(p.to, 2, where);
        else {
          record(p.to, where + ".path.to", "node contact at_ms offset");
          if (!nodes.has(p.to.node))
            fail(where, "missing destination contact node");
          if (n.parent)
            fail(where, "world contact destination cannot have a parent");
          finite(p.to.at_ms, where, 0, scene.end_ms - scene.start_ms);
          if (p.to.offset) vector(p.to.offset, 2, where);
          const selection = clipSelection(
              nodes.get(p.to.node),
              story.assets,
              p.to.at_ms,
            ),
            frame = selectedFrame(selection, p.to.at_ms);
          if (!selection.asset.contacts?.[p.to.contact]?.[frame])
            fail(
              where,
              "missing destination contact " + p.to.contact + " frame " + frame,
            );
        }
        if (p.arc !== undefined) finite(p.arc, where);
        if (p.arc !== undefined && p.controls)
          fail(where, "arc and controls conflict");
        if (p.controls) {
          if (p.controls.length !== 2) fail(where, "cubic needs two controls");
          p.controls.forEach((c) => vector(c, 2, where));
        }
        if (writes.has("x") || writes.has("y"))
          fail(where, "path conflicts with x/y track");
      }
      if (n.parent && !nodes.has(n.parent)) fail(where, "unknown parent");
      if (n.attach) {
        const a = n.attach;
        record(a, where + ".attach", "node contact start_ms end_ms offset");
        interval(a, where);
        if (n.parent) fail(where, "parent and attach conflict");
        if (!nodes.has(a.node)) fail(where, "missing attachment node");
        if (a.offset) vector(a.offset, 2, where);
        const parent = nodes.get(a.node);
        for (const [id, frames] of sampledFrames(
          parent,
          story.assets,
          a.start_ms,
          a.end_ms,
          n.path?.from === "attachment",
        )) {
          const points = story.assets[id]?.contacts?.[a.contact];
          for (const frame of frames) {
            if (!points?.[frame])
              fail(
                where,
                "missing sampled contact " +
                  a.contact +
                  " in " +
                  id +
                  " frame " +
                  frame,
              );
          }
        }
      }
      if (n.glow) {
        record(
          n.glow,
          where + ".glow",
          "start_ms end_ms color blur blur_pulse pulse period_ms pulse_cycles",
        );
        interval(n.glow, where);
        color(n.glow.color, where);
        finite(n.glow.blur, where, 0, 128);
        finite(n.glow.period_ms, where, 1);
        for (const k of ["blur_pulse", "pulse", "pulse_cycles"])
          if (n.glow[k] !== undefined) finite(n.glow[k], where, 0, 128);
      }
      if (n.mask) {
        record(
          n.mask,
          where + ".mask",
          "type rect points contact start_ms end_ms min_y",
        );
        if (n.mask.type === "rect") vector(n.mask.rect, 4, where);
        else if (
          ["polygon", "contact"].includes(n.mask.type) &&
          n.mask.points?.length >= 3
        )
          n.mask.points.forEach((p) => vector(p, 2, where));
        else fail(where, "unknown/empty mask");
        if (n.mask.type === "contact") {
          interval(n.mask, where);
          if (n.mask.min_y !== undefined) finite(n.mask.min_y, where);
          if (n.projection || n.parent)
            fail(where, "contact mask projection/parent unsupported");
          for (const [assetId, frames] of sampledFrames(
            n,
            story.assets,
            n.mask.start_ms,
            n.mask.end_ms,
          ))
            for (const frame of frames)
              if (!story.assets[assetId].contacts?.[n.mask.contact]?.[frame])
                fail(where, "missing mask contact frame " + frame);
        }
      }
      if (n.water) {
        record(n.water, where + ".water", "line_from_feet fade color opacity");
        finite(n.water.line_from_feet, where, 0, 1);
        if (n.water.color) color(n.water.color, where);
        if (n.water.fade !== undefined) finite(n.water.fade, where, 0);
        if (n.water.opacity !== undefined) finite(n.water.opacity, where, 0, 1);
      }
      if (n.projection) {
        record(n.projection, where + ".projection", "corners");
        if (n.projection.corners?.length !== 4)
          fail(where, "projection needs four corners");
        n.projection.corners.forEach((p) => vector(p, 2, where));
        projectPoint(n.projection.corners, 0.5, 0.5);
      }
      for (const l of n.lights ?? []) {
        record(l, where + ".light", "x y radius color phase period_ms");
        finite(l.x, where);
        finite(l.y, where);
        finite(l.radius, where, 0.001);
        finite(l.period_ms, where, 1);
        if (l.phase !== undefined) finite(l.phase, where + ".light.phase");
        color(l.color, where);
        if (l.color.length !== 7) fail(where, "light color must be opaque RGB");
      }
      if (n.particles) {
        record(
          n.particles,
          where + ".particles",
          "count color colors seed start_ms end_ms radius period_ms phase_step radial_start vertical_scale rise size_from size_to opacity points inner rotation_speed stroke stroke_width clock_start_ms",
        );
        interval(n.particles, where);
        for (const key of [
          "radius",
          "radial_start",
          "size_from",
          "size_to",
          "stroke_width",
        ])
          if (n.particles[key] !== undefined)
            finite(n.particles[key], where, 0);
        for (const key of [
          "seed",
          "phase_step",
          "vertical_scale",
          "rise",
          "rotation_speed",
          "clock_start_ms",
        ])
          if (n.particles[key] !== undefined) finite(n.particles[key], where);
        if (n.particles.period_ms !== undefined)
          finite(n.particles.period_ms, where, 1);
        for (const key of ["opacity", "inner"])
          if (n.particles[key] !== undefined)
            finite(n.particles[key], where, 0, 1);
        if (
          n.particles.points !== undefined &&
          (!Number.isInteger(n.particles.points) ||
            n.particles.points < 3 ||
            n.particles.points > 16)
        )
          fail(where, "invalid particle points");
        if (n.particles.stroke) color(n.particles.stroke, where);
        finite(n.particles.count, where, 1, 128);
        if (!Number.isInteger(n.particles.count))
          fail(where, "particle count must be integer");
        if (n.particles.colors) {
          if (!Array.isArray(n.particles.colors) || !n.particles.colors.length)
            fail(where, "empty particle palette");
          n.particles.colors.forEach((c) => color(c, where));
        } else color(n.particles.color, where);
      }
      if (n.travel) {
        record(
          n.travel,
          where + ".travel",
          "start_ms end_ms speed offset direction scale repeat ease_in_ms ease_out_ms",
        );
        interval(n.travel, where);
        finite(n.travel.speed, where);
        for (const key of ["offset", "ease_in_ms", "ease_out_ms"])
          if (n.travel[key] !== undefined)
            finite(n.travel[key], where + ".travel." + key);
        if (n.travel.scale !== undefined) finite(n.travel.scale, where, 0.001);
        if (
          n.travel.direction !== undefined &&
          ![1, -1].includes(n.travel.direction)
        )
          fail(where, "travel direction must be 1 or -1");
        if (
          n.travel.repeat !== undefined &&
          typeof n.travel.repeat !== "boolean"
        )
          fail(where, "repeat must be boolean");
      }
    }
    const visit = (id, active) => {
      if (active.has(id)) fail(scene.id, "dependency cycle");
      const n = nodes.get(id);
      const next = new Set(active);
      next.add(id);
      for (const dep of [
        n.parent,
        n.attach?.node,
        !Array.isArray(n.path?.to) ? n.path?.to?.node : null,
      ].filter(Boolean))
        visit(dep, next);
    };
    for (const id of nodes.keys()) visit(id, new Set());
    const projected = (id) => {
      const n = nodes.get(id);
      return Boolean(n.projection || (n.parent && projected(n.parent)));
    };
    for (const n of nodes.values()) {
      if (
        projected(n.id) &&
        [n.glow, n.water, n.travel, n.particles, n.lights?.length].some(Boolean)
      )
        fail(
          scene.id + "/" + n.id,
          "projected effect combination is unsupported",
        );
      if (
        n.travel &&
        [n.mask, n.glow, n.water, n.particles, n.lights?.length, n.parent].some(
          Boolean,
        )
      )
        fail(scene.id + "/" + n.id, "travel effect combination is unsupported");
    }
    if (scene.camera) {
      record(
        scene.camera,
        scene.id + ".camera",
        "from to start_ms end_ms easing tracks",
      );
      interval(scene.camera, scene.id);
      vector(scene.camera.from, 3, scene.id);
      vector(scene.camera.to, 3, scene.id);
      if (scene.camera.from[2] <= 0 || scene.camera.to[2] <= 0)
        fail(scene.id, "invalid camera scale");
      easing(scene.camera, scene.id);
      const writes = new Set();
      for (const tr of scene.camera.tracks ?? []) {
        record(tr, scene.id + ".camera.track", "property keys easing");
        if (
          !["focus_x", "focus_y", "zoom", "zoom_multiplier"].includes(
            tr.property,
          ) ||
          writes.has(tr.property)
        )
          fail(scene.id, "invalid camera track");
        writes.add(tr.property);
        easing(tr, scene.id);
        if (!Array.isArray(tr.keys) || !tr.keys.length)
          fail(scene.id, "empty camera track");
        let last = -1;
        for (const k of tr.keys) {
          vector(k, 2, scene.id);
          if (k[0] <= last || (tr.property.startsWith("zoom") && k[1] <= 0))
            fail(scene.id, "invalid camera keys");
          last = k[0];
        }
      }
    }
    if (scene.transition) {
      record(
        scene.transition,
        scene.id + ".transition",
        "kind duration_ms color",
      );
      if (scene.transition.kind !== "fade")
        fail(scene.id, "unsupported transition");
      finite(scene.transition.duration_ms, scene.id, 1);
      color(scene.transition.color, scene.id);
    }
  }
  if (story.performance.kind === "wht" && end > 300000) fail("duration", "WHT exceeds five minutes");
  if (own(story, "captions")) {
    if (!story.performance.required_capabilities.includes("captions"))
      fail("captions", "requires captions capability");
    if (!Array.isArray(story.captions)) fail("captions", "expected cue array");
    let previous = 0;
    for (const [index, cue] of story.captions.entries()) {
      const where = "captions[" + index + "]";
      record(cue, where, "start_ms end_ms text");
      interval(cue, where);
      finite(cue.end_ms, where + ".end_ms", 0, end);
      if (cue.start_ms < previous) fail(where, "unordered/overlapping captions");
      if (typeof cue.text !== "string" || !cue.text.trim())
        fail(where, "nonempty text required");
      previous = cue.end_ms;
    }
  }
  if (!Array.isArray(story.audio)) fail("audio", "expected cue array");
  const ids = new Set();
  for (const a of story.audio) {
    record(
      a,
      "audio",
      "id kind media url start_ms duration_ms end_ms volume loop text words gain_keys metadata",
    );
    if (typeof a.id !== "string" || ids.has(a.id))
      fail("audio", "missing/duplicate id");
    ids.add(a.id);
    if (!["narration", "music", "ambience", "sfx"].includes(a.kind))
      fail(a.id, "unknown audio kind");
    media(a.media, a.id);
    finite(a.start_ms, a.id, 0, end);
    finite(a.duration_ms, a.id, 0.001);
    if (a.end_ms !== undefined) finite(a.end_ms, a.id, a.start_ms + 0.001, end);
    if (a.volume !== undefined) finite(a.volume, a.id, 0, 1);
    let gainAt = -1;
    for (const gain of a.gain_keys ?? []) {
      vector(gain, 2, a.id);
      if (gain[0] <= gainAt) fail(a.id, "gain keys not increasing");
      gainAt = gain[0];
      finite(gain[1], a.id, 0, 1);
    }
    if (["music", "ambience"].includes(a.kind) && a.volume === undefined)
      fail(a.id, "continuous audio needs volume");
  }
  return story;
}
