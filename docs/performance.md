# Declarative performance input

Field contract for WHT preparation. Public entry: createStoryPlayer(element,
{story, assetBase}). The host fetches exactly one complete JSON document.
No StoryLang field/parser is required. Media values are bucket-qualified keys.
Runtime metadata, frames, contacts and instructions are inside the document.
This describes the implemented contract; source review and deployment are
separate from story admission. Local implementation evidence and release status
are recorded in [WHT_IMPLEMENTATION_STATUS.md](../WHT_IMPLEMENTATION_STATUS.md).

## Envelope example

    {
      "title": "A picnic for Sam",
      "performance": {"kind":"wht","resolution":[1000,562.5],
        "required_capabilities":["transform","clip","attachment","path","glow"]},
      "assets": {
        "hero_idle": {"type":"sprite","media":"fairytale-assets/example/idle.webp",
          "width":1024,"height":512,"frames":[[0,0,512,512],[512,0,512,512]],
          "registration":[90,30,420,500],"contacts":{"hand":[[320,280],[322,278]]}},
        "apple":{"type":"image","media":"fairytale-assets/example/apple.png",
          "width":512,"height":512,"crop":[20,20,492,492]}
      },
      "scenes":[{"id":"packing","start_ms":0,"end_ms":5000,"setting_id":"kitchen",
        "camera":{"from":[500,281.25,1],"to":[600,320,1.2],"start_ms":0,"end_ms":5000,"easing":"smoothstep"},
        "nodes":[
          {"id":"hero","asset":"hero_idle","x":300,"y":510,"height":195,
           "clip":{"fps":12,"frames":[0,1],"loop":true}},
          {"id":"apple","asset":"apple","x":340,"y":430,"width":40,"depth":600,
           "attach":{"node":"hero","contact":"hand","start_ms":0,"end_ms":1000,"offset":[0,-10]},
           "path":{"start_ms":1000,"end_ms":2500,"from":"attachment","to":[775,447],"arc":90,"easing":"smoothstep"},
           "tracks":[{"property":"scale_x","keys":[[2000,1],[2500,0.2]],"easing":"smoothstep"},
                     {"property":"scale_y","keys":[[2000,1],[2500,0.2]],"easing":"smoothstep"}],
           "glow":{"start_ms":0,"end_ms":1000,"color":"#ffe18a","blur":22,"pulse":0.045,"period_ms":1350}}
        ]}],
      "audio":[{"id":"line-1","kind":"narration","media":"fabro-packs/job/audio/line.m4a",
        "start_ms":0,"duration_ms":5000,"text":"Sam, shall we pack the apple?","volume":1}]
    }

Scene-local times (nodes, tracks, clip, camera, effects) are milliseconds relative
to scene start. Scene/audio times are absolute story milliseconds. Scenes are
contiguous from zero. Node IDs are unique per scene and identify instances rather
than appearances. Coordinates/dimensions are finite scene pixels. Rotation uses
radians. Color is #RRGGBB or #RRGGBBAA. Development numeric versions stay fixed;
capability/build identity controls compatibility.

## Nodes and reusable instructions

Every node references an asset and has x/y, width and/or height. Image crop is
[x0,y0,x1,y1]; sprite frames are [x,y,width,height]. Sprite sizing uses registration
bounds; x is source-frame horizontal centre and y is registered feet. Image pivot
defaults to [0.5,0.5]. Sprite placement follows source registration.

Optional scalars: rotation=0, scale_x=1, scale_y=1, opacity=1, depth=y,
space=scene|screen. visible:[start_ms,end_ms] is half-open. parent names another
node and composes transforms.

clip:{fps,frames:[sourceFrameIndices],loop,start_ms,hold} selects exact frames;
start_ms is a finite clip clock origin and may be negative to preserve phase
across cuts; scene, segment and visibility intervals remain nonnegative.
loop=false holds the final selected frame. segments:[{start_ms,end_ms,asset,clip}]
provides explicit same-node arrival poses/angle variants without duplicates.

tracks:[{property,keys:[[localMs,value],...],easing}] supports x,y,width,height,
rotation,scale_x,scale_y,opacity,depth. Keys strictly increase; endpoints hold.
Easing: linear,smoothstep,sine,hold. No two tracks may write the same property.

path:{start_ms,end_ms,from:[x,y]|attachment,to:[x,y],arc,easing} evaluates a
straight/arched route; controls:[[x,y],[x,y]] selects cubic Bezier. For
from=attachment the evaluator freezes the attachment world contact at release.
attach:{node,contact,start_ms,end_ms,offset:[x,y]} follows per-frame source
asset.contacts. Attachment interval is [start,end); exact end belongs to release.
Missing sampled contacts fail; no generic offsets or nearest-frame guessing.
Independent prop size remains fixed unless an explicit track changes it.

glow:{start_ms,end_ms,color,blur,pulse,period_ms} is alpha glow and scale pulse,
without a ring. mask:{type:rect,rect:[x,y,w,h]} or
mask:{type:polygon,points:[[x,y],...]} clips in local source pixels.
water:{line_from_feet,fade,color,opacity} specifies registered water mask/tint.
projection:{corners:[[x,y],[x,y],[x,y],[x,y]]} maps source to parent-local
top-left/top-right/bottom-right/bottom-left. Layers/masks express bag occlusion.

lights:[{x,y,radius,color,phase,period_ms}] anchors repeating lens pulses in source
pixels. particles:{count,color|colors:[palette],seed,start_ms,end_ms,radius} is a deterministic
sparkle recipe, never executable code. Optional phase and seed values must be
finite numbers; strings and null are rejected.

Backgrounds are image nodes with lower depth. Optional
travel:{start_ms,end_ms,speed,offset,direction,scale,repeat,ease_in_ms,ease_out_ms}
pans one coherent painting: nonrepeat uses bounded overscan; repeat uses mirrored
tiles. Optional offset and ease durations must be finite numbers. Ease durations
are clamped to zero through half the travel interval. Same-setting angle changes are contiguous scenes sharing setting_id.
transition:{kind:fade,duration_ms,color} is an explicit incoming scene fade.

## Audio

Audio array entries: {id,kind,media,start_ms,end_ms?,duration_ms,volume,loop,text?,gain_keys?}.
end_ms is the active playback boundary, separate from measured media duration_ms.
gain_keys:[[absoluteMs,volume],...] changes authored gain without reopening a track.
Kinds: narration,music,ambience,sfx. Narration/SFX default volume=1;
music/ambience require an authored volume. WHT never speech-ducks. Continuous
tracks seek to elapsed time (modulo media duration for loops). SFX fire only on
forward crossings, never historical catch-up. Replay resets delivery; pause,
seek and destroy stop one-shots. Equal-time cues preserve authored order.
duration_ms is measured media duration. Text/word cue metadata is data.

## All70 coverage gate

Inventory every rendering branch/field used by 69 generic sources plus picnic.
Map each feature and material combination to commands, assets/fit data and
shared/browser/native evidence before bulk conversion. Water, projection,
vehicle lights, travel, alternate angles, held/frame-range clips and arrival
states need fixtures beyond the three product pilots. Unknown fields/operations,
nonfinite values, unresolved references, dependency cycles and unsupported
required capabilities fail before playback. Admission requires evidence.

## Geometric assets and projected groups

An asset may be {type:"shape",width,height,shape:{...}} with no media key.
shape.kind is rect, roundrect, ellipse or arc. Optional bounds:[x,y,w,h]
defaults to the asset extent. fill/stroke are colors; stroke_width defaults to 1.
roundrect uses radius. arc uses radians start_angle/end_angle. Optional shadow
is {color,blur,offset:[x,y]}; reserve asset padding/bounds to avoid clipping it.
Declare capability shapes. This represents actor/prop ground shadows, rounded
cards, cream screen backing and water ripples without hidden paint defaults.

Children of a projected node inherit its projective screen mapping. Parent-local
child corners map through the parent's source dimensions and projected quad;
remote portrait, clipped self-view and backdrop remain separate declarative
nodes. Projection is a drawing map; normal local transforms still apply first.
Arc paths use positive height upward; sources whose actor arcs use positive
downward must negate those values during conversion.

Preparation stores the compiler output in instructions. The same compiler
verifies that supplied instructions exactly match authored data and refuses
stale or modified instructions. Numeric development contract versions stay fixed.

Local uncommitted builds use `scripts/build-local.mjs OUTPUT.js`; the output must
end in `.js` so its paired receipt has a distinct `.json` path. The receipt
records base commit, source_sha256, artifact sha256 and byte count. They never
reuse the protected global's production identity or replace production locks.

Current combination limits are explicit compiler refusals: projected nodes or
their descendants cannot carry glow, water, travel, particles or lens lights;
travel nodes cannot carry masks, glow, water, particles, lens lights or parents.
These must be expanded with shared/browser/native evidence if the all70 mapping
uses such a combination; unsupported combinations never silently lose effects.

Lens light colors are opaque RGB. Their phase is measured in cycles and their
intensity is squared sine; the renderer draws the source radial halo and white
elliptical core. Glow blur is in scene pixels independent of node/camera scaling.

For a reusable transfer endpoint, path.to may be {node,contact,at_ms,offset?}
instead of [x,y]. The evaluator freezes that receiver's exact future frame and
world contact at scene-local at_ms (offset is world pixels), including movement,
flip and parent transforms. No host pose/hand math is needed. Such a world-contact
path cannot itself have a parent. Contact-target dependency cycles are refused.
Attachment validation checks only reachable frames in [start,end), plus the exact
release frame for path.from=attachment; future/unused poses need no calibration.


### Additional source-derived controls

Scalar tracks may carry `wave:{amplitude,cycles,power?}`. Between the first and
last key, the evaluator adds amplitude × sin(2π × cycles × interval progress)
raised to power 1 (default) or 2. Outside that interval, only the held key value
applies. This expresses a single turning arc or bounded emphasis without samples.

Camera accepts `tracks` with the same ordered key/easing form and properties
`focus_x`, `focus_y`, `zoom`, `zoom_multiplier`. The multiplier applies after the
zoom track; the final focus still clamps at the resulting zoom. This supports
multi-stage focus moves and an independent continuous zoom drift.

`mask:{type:"contact",contact,points,start_ms,end_ms,min_y?}` anchors scene-pixel
polygon offsets to the current calibrated contact of the same node. The shared
evaluator emits its local-source polygon, accounting for frame, facing, rotation
and scale. The node is hidden outside the half-open mask interval, or when the
contact's scene y is below min_y. Every reachable contact must exist. Parent and
projected contact-mask combinations explicitly refuse until tested.

Glow optionally accepts `blur_pulse` and `pulse_cycles`: blur gains the pulse
amplitude and phase clamps after the specified number of half-sine periods.
These controls keep the base glow after a finite emphasis motion has finished.

Particles retain their existing defaults. Optional data controls are `period_ms`,
`clock_start_ms` (may be negative), `phase_step`, `radial_start`, `vertical_scale`,
`rise`, `size_from`, `size_to`, `opacity`, `points` (3–16 star tips), `inner`,
`rotation_speed` (radians/second), `stroke` and `stroke_width`. The shared evaluator
emits the exact polygon vertices; both adapters only fill/stroke them. A separate
clock origin preserves particle phase when a particle group becomes visible.

Fixed authored text may be an external raster image with font provenance and an
explicit normalized pivot. This keeps typography deterministic across browser and
native; personalized narration and captions remain text/audio entries.
