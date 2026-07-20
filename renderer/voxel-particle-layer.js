import { createProgram } from "./shader-manager.js";
import { createVoxelFracturePieces, voxelFractureDynamics } from "./voxel-fracture.js";

const PARTICLE_INSTANCE_FLOATS = 20;
const DEFAULT_FRACTURE_BATCH_PIECES = 112;

const PARTICLE_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aOrigin;
layout(location = 3) in vec3 aScale;
layout(location = 4) in vec4 aRotation;
layout(location = 5) in vec3 aSourceCenter;
layout(location = 6) in vec3 aLayers;
layout(location = 7) in vec4 aTint;

uniform mat4 uViewProjection;
uniform vec3 uWorldOrigin;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyLightColor;
uniform vec3 uGroundLightColor;
uniform vec4 uLightParams;

out vec2 vUv;
out vec3 vNormal;
out vec4 vTint;
out float vFogDepth;
flat out float vLayer;

vec3 rotateByQuaternion(vec3 value, vec4 rotation) {
  return value + 2.0 * cross(rotation.xyz, cross(rotation.xyz, value) + rotation.w * value);
}

void main() {
  vec3 local = aPosition * aScale;
  vec3 worldRelative = aOrigin - uWorldOrigin + rotateByQuaternion(local, aRotation);
  vec3 source = aSourceCenter + local;
  vec3 axis = abs(aNormal);
  if (axis.y > 0.5) {
    vUv = source.xz;
    vLayer = aNormal.y > 0.0 ? aLayers.y : aLayers.z;
  } else if (axis.x > 0.5) {
    vUv = source.zy;
    vLayer = aLayers.x;
  } else {
    vUv = source.xy;
    vLayer = aLayers.x;
  }
  gl_Position = uViewProjection * vec4(worldRelative, 1.0);
  vNormal = normalize(rotateByQuaternion(aNormal, aRotation));
  vTint = aTint;
  vFogDepth = max(0.0, gl_Position.w);
}
`;

const PARTICLE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uTextureArray;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyLightColor;
uniform vec3 uGroundLightColor;
uniform vec3 uFogColor;
uniform vec2 uFogNearFar;
uniform vec4 uLightParams;

in vec2 vUv;
in vec3 vNormal;
in vec4 vTint;
in float vFogDepth;
flat in float vLayer;

out vec4 outColor;

void main() {
  vec4 texel = vLayer >= 0.0
    ? texture(uTextureArray, vec3(fract(vUv), floor(vLayer + 0.5)))
    : vec4(1.0);
  float alpha = texel.a * vTint.a;
  if (alpha < 0.012) discard;
  vec3 normal = normalize(vNormal);
  float sun = max(dot(normal, normalize(uSunDirection)), 0.0);
  float toonSun = mix(sun, smoothstep(0.10, 0.82, sun), 0.48);
  float hemiUp = normal.y * 0.5 + 0.5;
  vec3 ambient = uSkyLightColor * uLightParams.x;
  vec3 hemi = mix(uGroundLightColor, uSkyLightColor, hemiUp) * uLightParams.z;
  vec3 direct = uSunColor * (toonSun * uLightParams.y);
  vec3 lit = texel.rgb * vTint.rgb * (ambient + hemi + direct) * uLightParams.w;
  float fog = smoothstep(uFogNearFar.x, uFogNearFar.y, vFogDepth);
  outColor = vec4(mix(lit, uFogColor, fog * 0.42), alpha * (1.0 - fog * 0.55));
}
`;

const CUBE_VERTICES = new Float32Array([
  -0.5, -0.5, -0.5, 0, 0, -1,  0.5, -0.5, -0.5, 0, 0, -1,  0.5,  0.5, -0.5, 0, 0, -1, -0.5,  0.5, -0.5, 0, 0, -1,
  -0.5, -0.5,  0.5, 0, 0,  1,  0.5, -0.5,  0.5, 0, 0,  1,  0.5,  0.5,  0.5, 0, 0,  1, -0.5,  0.5,  0.5, 0, 0,  1,
  -0.5, -0.5, -0.5, -1, 0, 0, -0.5,  0.5, -0.5, -1, 0, 0, -0.5,  0.5,  0.5, -1, 0, 0, -0.5, -0.5,  0.5, -1, 0, 0,
   0.5, -0.5, -0.5,  1, 0, 0,  0.5,  0.5, -0.5,  1, 0, 0,  0.5,  0.5,  0.5,  1, 0, 0,  0.5, -0.5,  0.5,  1, 0, 0,
  -0.5, -0.5, -0.5, 0, -1, 0, -0.5, -0.5,  0.5, 0, -1, 0,  0.5, -0.5,  0.5, 0, -1, 0,  0.5, -0.5, -0.5, 0, -1, 0,
  -0.5,  0.5, -0.5, 0,  1, 0, -0.5,  0.5,  0.5, 0,  1, 0,  0.5,  0.5,  0.5, 0,  1, 0,  0.5,  0.5, -0.5, 0,  1, 0,
]);

const CUBE_INDICES = new Uint16Array([
  0, 1, 2, 0, 2, 3,
  4, 6, 5, 4, 7, 6,
  8, 9, 10, 8, 10, 11,
  12, 14, 13, 12, 15, 14,
  16, 17, 18, 16, 18, 19,
  20, 22, 21, 20, 23, 22,
]);

export class VoxelParticleLayer {
  constructor(gl, options = {}) {
    this.gl = gl;
    this.maxParticles = Math.max(16, Math.trunc(options.maxParticles ?? 320));
    this.particles = [];
    this.freeParticles = [];
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.geometryVbo = null;
    this.instanceVbo = null;
    this.ibo = null;
    this.instanceData = new Float32Array(this.maxParticles * PARTICLE_INSTANCE_FLOATS);
    this.byteLength = 0;
  }

  init() {
    if (this.program) return this;
    const gl = this.gl;
    this.program = createProgram(gl, PARTICLE_VERTEX_SHADER, PARTICLE_FRAGMENT_SHADER);
    this.uniforms = collectUniforms(gl, this.program);
    this.vao = gl.createVertexArray();
    this.geometryVbo = gl.createBuffer();
    this.instanceVbo = gl.createBuffer();
    this.ibo = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.geometryVbo);
    gl.bufferData(gl.ARRAY_BUFFER, CUBE_VERTICES, gl.STATIC_DRAW);
    const vertexStride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, vertexStride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, vertexStride, 12);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    const instanceStride = PARTICLE_INSTANCE_FLOATS * 4;
    instanceAttribute(gl, 2, 3, instanceStride, 0);
    instanceAttribute(gl, 3, 3, instanceStride, 12);
    instanceAttribute(gl, 4, 4, instanceStride, 24);
    instanceAttribute(gl, 5, 3, instanceStride, 40);
    instanceAttribute(gl, 6, 3, instanceStride, 52);
    instanceAttribute(gl, 7, 4, instanceStride, 64);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CUBE_INDICES, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.byteLength = CUBE_VERTICES.byteLength + CUBE_INDICES.byteLength + this.instanceData.byteLength;
    return this;
  }

  emitBreak(options = {}) {
    const count = clampInt(options.count ?? 7, 1, 28);
    const color = normalizeRgb(options.color, [134, 98, 62]);
    const origin = particleOrigin(options);
    const normal = normalizeVector(options.normalX, options.normalY, options.normalZ, 0, 1, 0);
    const seed = hashSeed(origin.x, origin.y, origin.z, count);
    for (let index = 0; index < count; index += 1) {
      const r0 = rand(seed + index * 17);
      const r1 = rand(seed + index * 31);
      const r2 = rand(seed + index * 47);
      const sideways = randomUnit2(seed + index * 71);
      const speed = 1.8 + r0 * 3.2;
      this.addParticle({
        x: origin.x + (r1 - 0.5) * 0.28,
        y: origin.y + (r2 - 0.5) * 0.28,
        z: origin.z + (r0 - 0.5) * 0.28,
        vx: normal.x * speed + sideways.x * (r1 - 0.5) * 2.2,
        vy: Math.max(0.4, normal.y * speed) + 1.1 + r2 * 2.4,
        vz: normal.z * speed + sideways.z * (r2 - 0.5) * 2.2,
        size: 0.055 + r2 * 0.072,
        r: color[0] * (0.82 + r0 * 0.28),
        g: color[1] * (0.82 + r1 * 0.24),
        b: color[2] * (0.82 + r2 * 0.22),
        a: 0.95,
        life: 0.34 + r1 * 0.36,
        fadeDuration: 0.22,
        gravity: 11.5,
        drag: 3.4,
      });
    }
    return count;
  }

  emitFracture(options = {}) {
    const blocks = fractureBlocks(options);
    if (!blocks.length) return 0;
    const batchLimit = clampInt(
      options.maxPieces ?? Math.min(DEFAULT_FRACTURE_BATCH_PIECES, this.maxParticles),
      1,
      this.maxParticles,
    );
    let emitted = 0;
    for (let blockIndex = 0; blockIndex < blocks.length && emitted < batchLimit; blockIndex += 1) {
      const block = blocks[blockIndex];
      const blocksRemaining = blocks.length - blockIndex;
      const pieceLimit = blocks.length === 1
        ? Math.min(28, batchLimit - emitted)
        : Math.min(28, Math.max(1, Math.floor((batchLimit - emitted) / blocksRemaining)));
      const pieces = createVoxelFracturePieces({ ...block, pieceLimit });
      const center = weightedPieceCenter(pieces);
      const dynamics = voxelFractureDynamics(block.blockId);
      const seed = hashSeed(block.worldX, block.worldY, block.worldZ, block.blockId);
      for (let index = 0; index < pieces.length && emitted < batchLimit; index += 1) {
        const piece = pieces[index];
        const r0 = rand(seed + index * 37);
        const r1 = rand(seed + index * 61);
        const r2 = rand(seed + index * 89);
        let dx = piece.centerX - center.x;
        let dz = piece.centerZ - center.z;
        const horizontalLength = Math.hypot(dx, dz);
        if (horizontalLength < 0.035) {
          const direction = randomUnit2(seed + index * 109);
          dx = direction.x;
          dz = direction.z;
        } else {
          dx /= horizontalLength;
          dz /= horizontalLength;
        }
        const burstSpeed = dynamics.burstSpeed * (0.58 + r0 * 0.72);
        const verticalBias = clamp(piece.centerY - center.y, -0.65, 0.85);
        const life = dynamics.lifeMin + r1 * dynamics.lifeJitter;
        this.addParticle({
          x: block.worldX + piece.centerX,
          y: block.worldY + piece.centerY,
          z: block.worldZ + piece.centerZ,
          vx: dx * burstSpeed + (r1 - 0.5) * 0.62,
          vy: dynamics.liftSpeed * (0.72 + r2 * 0.58) + verticalBias * 1.1,
          vz: dz * burstSpeed + (r2 - 0.5) * 0.62,
          scaleX: piece.sizeX,
          scaleY: piece.sizeY,
          scaleZ: piece.sizeZ,
          sourceX: piece.sourceX,
          sourceY: piece.sourceY,
          sourceZ: piece.sourceZ,
          layerSide: piece.sideLayer,
          layerTop: piece.topLayer,
          layerBottom: piece.bottomLayer,
          r: piece.tintR,
          g: piece.tintG,
          b: piece.tintB,
          a: piece.alpha,
          life,
          fadeDuration: 0.48,
          gravity: dynamics.gravity,
          drag: dynamics.drag,
          rotationX: 0,
          rotationY: 0,
          rotationZ: 0,
          angularX: (r0 - 0.5) * dynamics.angularSpeed * 2,
          angularY: (r1 - 0.5) * dynamics.angularSpeed * 2,
          angularZ: (r2 - 0.5) * dynamics.angularSpeed * 2,
          collision: true,
          restitution: dynamics.restitution,
          groundFriction: dynamics.groundFriction,
          bouncesRemaining: dynamics.bounceMin + Math.floor(r0 * dynamics.bounceJitter),
          minimumBounceVelocity: 0.48 + r2 * 0.16,
          settleHold: 0.16 + r1 * 0.16,
          bounceSeed: seed + index * 131,
        });
        emitted += 1;
      }
    }
    return emitted;
  }

  emitSplash(options = {}) {
    const count = clampInt(options.count ?? 5, 1, 18);
    const origin = particleOrigin(options);
    const seed = hashSeed(origin.x, origin.y, origin.z, count + 97);
    for (let index = 0; index < count; index += 1) {
      const r0 = rand(seed + index * 13);
      const r1 = rand(seed + index * 29);
      const dir = randomUnit2(seed + index * 43);
      const spread = 0.65 + r0 * 1.25;
      this.addParticle({
        x: origin.x + (r0 - 0.5) * 0.32,
        y: origin.y + 0.06 + r1 * 0.08,
        z: origin.z + (r1 - 0.5) * 0.32,
        vx: dir.x * spread,
        vy: 1.15 + r1 * 2.1,
        vz: dir.z * spread,
        size: 0.035 + r0 * 0.050,
        r: 0.72 + r1 * 0.18,
        g: 0.88 + r0 * 0.10,
        b: 1.0,
        a: 0.72,
        life: 0.28 + r0 * 0.30,
        fadeDuration: 0.20,
        gravity: 8.4,
        drag: 4.6,
      });
    }
    return count;
  }

  addParticle(source) {
    let particle;
    if (this.particles.length >= this.maxParticles) {
      particle = this.particles[0];
      this.particles[0] = this.particles.pop();
    } else {
      particle = this.freeParticles.pop() ?? {};
    }
    initializeParticle(particle, source);
    updateParticleQuaternion(particle);
    this.particles.push(particle);
    return particle;
  }

  update(dt, collision = null) {
    const step = Math.max(0, Math.min(0.04, Number(dt) || 0));
    if (!step || !this.particles.length) return this.particles.length;
    const groundHeightAt = typeof collision === "function" ? collision : collision?.groundHeightAt;
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      particle.life -= step;
      if (particle.life <= 0 || !Number.isFinite(particle.x + particle.y + particle.z)) {
        this.removeParticleAt(index);
        continue;
      }

      const previousY = particle.y;
      if (particle.resting) {
        const floorDrag = Math.exp(-8.0 * step);
        particle.vx *= floorDrag;
        particle.vz *= floorDrag;
        particle.x += particle.vx * step;
        particle.z += particle.vz * step;
      } else {
        particle.vy -= particle.gravity * step;
        const drag = Math.exp(-particle.drag * step);
        particle.vx *= drag;
        particle.vy *= Math.exp(-particle.drag * 0.22 * step);
        particle.vz *= drag;
        particle.x += particle.vx * step;
        particle.y += particle.vy * step;
        particle.z += particle.vz * step;
      }

      particle.rotationX += particle.angularX * step;
      particle.rotationY += particle.angularY * step;
      particle.rotationZ += particle.angularZ * step;
      updateParticleQuaternion(particle);
      if (!particle.resting && particle.collision && particle.vy <= 0 && typeof groundHeightAt === "function") {
        resolveGroundCollision(particle, previousY, groundHeightAt);
      }
    }
    return this.particles.length;
  }

  render({ viewProjection, origin, lighting, textureArray = null }) {
    if (!this.particles.length) return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength };
    if (!this.program) this.init();
    const gl = this.gl;
    const count = this.writeInstanceData();
    if (!count) return { drawCalls: 0, triangles: 0, bufferMemory: this.byteLength };

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, viewProjection);
    gl.uniform3f(this.uniforms.uWorldOrigin, origin.worldX, origin.worldY, origin.worldZ);
    const sun = lighting?.sunDirection ?? [-0.72, 0.34, 0.62];
    const sunColor = lighting?.sunColor ?? [1.0, 0.88, 0.62];
    const sky = lighting?.skyLightColor ?? [0.62, 0.78, 1.0];
    const ground = lighting?.groundLightColor ?? [0.34, 0.42, 0.28];
    const lightParams = [
      Number.isFinite(lighting?.ambientStrength) ? lighting.ambientStrength : 0.48,
      Number.isFinite(lighting?.sunStrength) ? lighting.sunStrength : 0.78,
      Number.isFinite(lighting?.hemiStrength) ? lighting.hemiStrength : 0.36,
      Number.isFinite(lighting?.exposure) ? lighting.exposure : 1.0,
    ];
    const fog = lighting?.fogColor ?? [0.9, 0.97, 1.0];
    const fogNearFar = lighting?.fogNearFar ?? [96, 340];
    gl.uniform3f(this.uniforms.uSunDirection, sun[0], sun[1], sun[2]);
    gl.uniform3f(this.uniforms.uSunColor, sunColor[0], sunColor[1], sunColor[2]);
    gl.uniform3f(this.uniforms.uSkyLightColor, sky[0], sky[1], sky[2]);
    gl.uniform3f(this.uniforms.uGroundLightColor, ground[0], ground[1], ground[2]);
    gl.uniform4f(this.uniforms.uLightParams, lightParams[0], lightParams[1], lightParams[2], lightParams[3]);
    gl.uniform3f(this.uniforms.uFogColor, fog[0], fog[1], fog[2]);
    gl.uniform2f(this.uniforms.uFogNearFar, fogNearFar[0], fogNearFar[1]);
    textureArray?.bind?.(0);
    gl.uniform1i(this.uniforms.uTextureArray, 0);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, count * PARTICLE_INSTANCE_FLOATS));
    gl.drawElementsInstanced(gl.TRIANGLES, CUBE_INDICES.length, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    return { drawCalls: 1, triangles: count * CUBE_INDICES.length / 3, bufferMemory: this.byteLength };
  }

  writeInstanceData() {
    const count = Math.min(this.maxParticles, this.particles.length);
    for (let index = 0; index < count; index += 1) {
      const particle = this.particles[index];
      const fade = particleFade(particle);
      const shrink = 0.74 + fade * 0.26;
      const offset = index * PARTICLE_INSTANCE_FLOATS;
      this.instanceData[offset] = particle.x;
      this.instanceData[offset + 1] = particle.y;
      this.instanceData[offset + 2] = particle.z;
      this.instanceData[offset + 3] = Math.max(0.004, particle.scaleX * shrink);
      this.instanceData[offset + 4] = Math.max(0.004, particle.scaleY * shrink);
      this.instanceData[offset + 5] = Math.max(0.004, particle.scaleZ * shrink);
      this.instanceData[offset + 6] = particle.qx;
      this.instanceData[offset + 7] = particle.qy;
      this.instanceData[offset + 8] = particle.qz;
      this.instanceData[offset + 9] = particle.qw;
      this.instanceData[offset + 10] = particle.sourceX;
      this.instanceData[offset + 11] = particle.sourceY;
      this.instanceData[offset + 12] = particle.sourceZ;
      this.instanceData[offset + 13] = particle.layerSide;
      this.instanceData[offset + 14] = particle.layerTop;
      this.instanceData[offset + 15] = particle.layerBottom;
      this.instanceData[offset + 16] = Math.max(0, particle.r);
      this.instanceData[offset + 17] = Math.max(0, particle.g);
      this.instanceData[offset + 18] = Math.max(0, particle.b);
      this.instanceData[offset + 19] = clamp01(particle.a * fade);
    }
    return count;
  }

  removeParticleAt(index) {
    const removed = this.particles[index];
    const last = this.particles.pop();
    if (index < this.particles.length) this.particles[index] = last;
    if (removed && this.freeParticles.length < this.maxParticles) this.freeParticles.push(removed);
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.geometryVbo) gl.deleteBuffer(this.geometryVbo);
    if (this.instanceVbo) gl.deleteBuffer(this.instanceVbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.program = null;
    this.uniforms = null;
    this.vao = null;
    this.geometryVbo = null;
    this.instanceVbo = null;
    this.ibo = null;
    this.particles.length = 0;
    this.freeParticles.length = 0;
  }
}

function initializeParticle(target, source) {
  const size = Math.max(0.004, Number(source.size) || 0.06);
  const life = Math.max(0.001, Number(source.life) || 0.4);
  target.x = Number(source.x) || 0;
  target.y = Number(source.y) || 0;
  target.z = Number(source.z) || 0;
  target.vx = Number(source.vx) || 0;
  target.vy = Number(source.vy) || 0;
  target.vz = Number(source.vz) || 0;
  target.scaleX = Math.max(0.004, Number(source.scaleX) || size);
  target.scaleY = Math.max(0.004, Number(source.scaleY) || size);
  target.scaleZ = Math.max(0.004, Number(source.scaleZ) || size);
  target.sourceX = Number(source.sourceX) || 0;
  target.sourceY = Number(source.sourceY) || 0;
  target.sourceZ = Number(source.sourceZ) || 0;
  target.layerSide = finiteOr(source.layerSide, -1);
  target.layerTop = finiteOr(source.layerTop, target.layerSide);
  target.layerBottom = finiteOr(source.layerBottom, target.layerSide);
  target.r = finiteOr(source.r, 1);
  target.g = finiteOr(source.g, 1);
  target.b = finiteOr(source.b, 1);
  target.a = clamp01(finiteOr(source.a, 1));
  target.life = life;
  target.totalLife = life;
  target.fadeDuration = Math.max(0.01, Math.min(life, Number(source.fadeDuration) || 0.18));
  target.gravity = Math.max(0, Number(source.gravity) || 0);
  target.drag = Math.max(0, Number(source.drag) || 0);
  target.rotationX = Number(source.rotationX) || 0;
  target.rotationY = Number(source.rotationY) || 0;
  target.rotationZ = Number(source.rotationZ) || 0;
  target.angularX = Number(source.angularX) || 0;
  target.angularY = Number(source.angularY) || 0;
  target.angularZ = Number(source.angularZ) || 0;
  target.collision = Boolean(source.collision);
  target.restitution = clamp(Number(source.restitution) || 0, 0, 0.9);
  target.groundFriction = clamp(Number(source.groundFriction) || 0.6, 0, 1);
  target.bouncesRemaining = Math.max(0, Math.trunc(Number(source.bouncesRemaining) || 0));
  target.bounceCount = 0;
  target.minimumBounceVelocity = Math.max(0.1, Number(source.minimumBounceVelocity) || 0.48);
  target.settleHold = Math.max(0, Number(source.settleHold) || 0.18);
  target.bounceSeed = Math.trunc(Number(source.bounceSeed) || 0);
  target.resting = false;
  target.qx = 0;
  target.qy = 0;
  target.qz = 0;
  target.qw = 1;
}

function resolveGroundCollision(particle, previousY, groundHeightAt) {
  const halfHeight = rotatedHalfHeight(particle);
  const previousBottom = previousY - halfHeight;
  const nextBottom = particle.y - halfHeight;
  const groundY = groundHeightAt(
    particle.x,
    particle.z,
    previousBottom + 0.035,
    nextBottom - 0.035,
  );
  if (!Number.isFinite(groundY)) return false;
  if (groundY > previousBottom + 0.10 || groundY < nextBottom - 0.16) return false;

  particle.y = groundY + halfHeight + 0.002;
  const impactVelocity = Math.max(0, -particle.vy);
  if (particle.bouncesRemaining > 0) {
    particle.bounceCount += 1;
    particle.bouncesRemaining -= 1;
    particle.vy = Math.max(particle.minimumBounceVelocity, impactVelocity * particle.restitution);
    particle.vx *= particle.groundFriction;
    particle.vz *= particle.groundFriction;
    const nudge = randomUnit2(particle.bounceSeed + particle.bounceCount * 149);
    particle.vx += nudge.x * 0.055;
    particle.vz += nudge.z * 0.055;
    particle.angularX *= 0.76;
    particle.angularY *= 0.82;
    particle.angularZ *= 0.76;
  } else {
    particle.vy = 0;
    particle.vx *= 0.34;
    particle.vz *= 0.34;
    particle.angularX *= 0.22;
    particle.angularY *= 0.30;
    particle.angularZ *= 0.22;
    particle.resting = true;
    particle.life = Math.min(particle.life, particle.fadeDuration + particle.settleHold);
  }
  return true;
}

function updateParticleQuaternion(particle) {
  const hx = particle.rotationX * 0.5;
  const hy = particle.rotationY * 0.5;
  const hz = particle.rotationZ * 0.5;
  const sx = Math.sin(hx);
  const cx = Math.cos(hx);
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sz = Math.sin(hz);
  const cz = Math.cos(hz);
  particle.qx = sx * cy * cz - cx * sy * sz;
  particle.qy = cx * sy * cz + sx * cy * sz;
  particle.qz = cx * cy * sz - sx * sy * cz;
  particle.qw = cx * cy * cz + sx * sy * sz;
}

function rotatedHalfHeight(particle) {
  const qx = particle.qx;
  const qy = particle.qy;
  const qz = particle.qz;
  const qw = particle.qw;
  const rowX = 2 * (qx * qy + qw * qz);
  const rowY = 1 - 2 * (qx * qx + qz * qz);
  const rowZ = 2 * (qy * qz - qw * qx);
  return Math.abs(rowX) * particle.scaleX * 0.5
    + Math.abs(rowY) * particle.scaleY * 0.5
    + Math.abs(rowZ) * particle.scaleZ * 0.5;
}

function particleFade(particle) {
  if (particle.life >= particle.fadeDuration) return 1;
  const value = clamp01(particle.life / particle.fadeDuration);
  return value * value * (3 - 2 * value);
}

function fractureBlocks(options) {
  const source = Array.isArray(options.blocks) && options.blocks.length ? options.blocks : [options];
  const output = [];
  const seen = new Set();
  for (const block of source) {
    const worldX = Math.trunc(Number(block?.worldX ?? block?.x));
    const worldY = Math.trunc(Number(block?.worldY ?? block?.y));
    const worldZ = Math.trunc(Number(block?.worldZ ?? block?.z));
    const blockId = Math.trunc(Number(block?.blockId));
    if (![worldX, worldY, worldZ, blockId].every(Number.isFinite) || blockId <= 0) continue;
    const key = `${worldX},${worldY},${worldZ}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ worldX, worldY, worldZ, blockId });
  }
  return output;
}

function weightedPieceCenter(pieces) {
  let x = 0;
  let y = 0;
  let z = 0;
  let weight = 0;
  for (const piece of pieces) {
    const volume = Math.max(0.00001, piece.sizeX * piece.sizeY * piece.sizeZ);
    x += piece.centerX * volume;
    y += piece.centerY * volume;
    z += piece.centerZ * volume;
    weight += volume;
  }
  return weight > 0 ? { x: x / weight, y: y / weight, z: z / weight } : { x: 0.5, y: 0.5, z: 0.5 };
}

function particleOrigin(options) {
  return {
    x: Number.isFinite(options.pointX) ? options.pointX : Math.trunc(options.worldX || 0) + 0.5,
    y: Number.isFinite(options.pointY) ? options.pointY : Math.trunc(options.worldY || 0) + 0.5,
    z: Number.isFinite(options.pointZ) ? options.pointZ : Math.trunc(options.worldZ || 0) + 0.5,
  };
}

function normalizeRgb(value, fallback) {
  const source = Array.isArray(value) && value.length >= 3 ? value : fallback;
  return source.slice(0, 3).map((channel) => {
    const number = Number(channel);
    return number > 1 ? clamp01(number / 255) : clamp01(number);
  });
}

function normalizeVector(x, y, z, fallbackX, fallbackY, fallbackZ) {
  const vx = Number.isFinite(x) ? x : fallbackX;
  const vy = Number.isFinite(y) ? y : fallbackY;
  const vz = Number.isFinite(z) ? z : fallbackZ;
  const length = Math.hypot(vx, vy, vz) || 1;
  return { x: vx / length, y: vy / length, z: vz / length };
}

function randomUnit2(seed) {
  const angle = rand(seed) * Math.PI * 2;
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

function hashSeed(x, y, z, salt) {
  let hash = 2166136261;
  hash = Math.imul(hash ^ Math.trunc(x * 73856093), 16777619);
  hash = Math.imul(hash ^ Math.trunc(y * 19349663), 16777619);
  hash = Math.imul(hash ^ Math.trunc(z * 83492791), 16777619);
  hash = Math.imul(hash ^ Math.trunc(salt * 2654435761), 16777619);
  return hash >>> 0;
}

function rand(seed) {
  let value = (seed >>> 0) + 0x6d2b79f5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function collectUniforms(gl, program) {
  const names = [
    "uViewProjection",
    "uWorldOrigin",
    "uTextureArray",
    "uSunDirection",
    "uSunColor",
    "uSkyLightColor",
    "uGroundLightColor",
    "uLightParams",
    "uFogColor",
    "uFogNearFar",
  ];
  const uniforms = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}

function instanceAttribute(gl, location, size, stride, offset) {
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(location, 1);
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || min)));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
