# Rendering with bounded GPU work

The gameplay renderer can omit decorative passes at initialization:

```js
new WebGL2VoxelRenderer(canvas, {
  environmentEffects: false,
  waterEffects: false,
  maxMobileDpr: 1,
  maxDesktopDpr: 1,
  maxRenderPixels: 1280 * 720,
  textureQuality: "pixel",
  maxVoxelParticles: 80,
});
```

`environmentEffects: false` omits cloud, sky gradient, sun disc and projected
shadow resources, as well as terrain shadow draws. Clear color and directional,
ambient, local and baked terrain lighting remain active. Resource choices are
retained after WebGL context restoration.

`waterEffects: false` compiles a fluid shader without procedural waves, sparkle
cells or animated reflections. Water type, depth tint, underside, transparency,
global transparent ordering and underwater lighting remain supported. The
default engine option keeps detailed water for standalone users.

Terrain, avatars, particles, clouds and projected shadows no longer have distance
fog or horizon haze. Legacy lighting fog fields remain API-compatible data and
do not enter their compiled shaders. Forge workbench rendering is separate.

`maxRenderPixels` caps the backing buffer area while preserving the CSS canvas
rectangle. The cap also applies to an explicit DPR. The camera uses the backing
aspect ratio; screen-space raycasting continues using the CSS rectangle, so HUD
layout and pointer coordinates do not scale with the GPU buffer. The default cap
is unlimited for standalone engine users.

The game uses this configuration by default. Selected view distance, loaded world
geometry, mining and placement rules are independent of this configuration.
