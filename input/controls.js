import { clamp } from "../core/math.js";

export class FlyCameraControls {
  constructor(canvas, cameraState, { speed = 10, lookSpeed = 0.004 } = {}) {
    this.canvas = canvas;
    this.cameraState = cameraState;
    this.speed = speed;
    this.lookSpeed = lookSpeed;
    this.keys = new Set();
    this.pointerId = null;
    this.lastX = 0;
    this.lastY = 0;
    this.joystick = { active: false, x: 0, y: 0 };
    this._onKeyDown = (event) => this.keys.add(event.code);
    this._onKeyUp = (event) => this.keys.delete(event.code);
    this._onPointerDown = (event) => this.pointerDown(event);
    this._onPointerMove = (event) => this.pointerMove(event);
    this._onPointerUp = (event) => this.pointerUp(event);
    addEventListener("keydown", this._onKeyDown);
    addEventListener("keyup", this._onKeyUp);
    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointermove", this._onPointerMove);
    canvas.addEventListener("pointerup", this._onPointerUp);
    canvas.addEventListener("pointercancel", this._onPointerUp);
  }

  setJoystick(x, y, active = true) {
    this.joystick.active = active;
    this.joystick.x = Number(x) || 0;
    this.joystick.y = Number(y) || 0;
  }

  update(dt) {
    let moveX = 0;
    let moveZ = 0;
    let moveY = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) moveZ += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) moveZ -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) moveX -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) moveX += 1;
    if (this.keys.has("Space")) moveY += 1;
    if (this.keys.has("ControlLeft") || this.keys.has("ControlRight")) moveY -= 1;
    if (this.joystick.active) {
      moveX += this.joystick.x;
      moveZ += -this.joystick.y;
    }
    const len = Math.hypot(moveX, moveZ);
    if (len > 0.001 || Math.abs(moveY) > 0.001) {
      if (len > 0.001) {
        moveX /= len;
        moveZ /= len;
      }
      const yaw = this.cameraState.yaw;
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const speed = this.speed * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 5.0 : 1.0);
      this.moveFloating(
        (forwardX * moveZ + rightX * moveX) * speed * dt,
        moveY * speed * dt,
        (forwardZ * moveZ + rightZ * moveX) * speed * dt,
      );
    }
  }

  moveFloating(dx, dy, dz) {
    this.cameraState.localOffsetX += dx;
    this.cameraState.localOffsetY += dy;
    this.cameraState.localOffsetZ += dz;
    normalizeCameraIntegers(this.cameraState);
  }

  pointerDown(event) {
    if (this.pointerId !== null) return;
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  pointerMove(event) {
    if (event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.cameraState.yaw -= dx * this.lookSpeed;
    this.cameraState.pitch = clamp(this.cameraState.pitch + dy * this.lookSpeed * 0.65, -1.25, 1.25);
  }

  pointerUp(event) {
    if (event.pointerId === this.pointerId) this.pointerId = null;
  }

  dispose() {
    removeEventListener("keydown", this._onKeyDown);
    removeEventListener("keyup", this._onKeyUp);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("pointermove", this._onPointerMove);
    this.canvas.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.removeEventListener("pointercancel", this._onPointerUp);
  }
}

export function normalizeCameraIntegers(cameraState) {
  while (cameraState.localOffsetX >= 1) { cameraState.worldX += 1; cameraState.localOffsetX -= 1; }
  while (cameraState.localOffsetX < 0) { cameraState.worldX -= 1; cameraState.localOffsetX += 1; }
  while (cameraState.localOffsetY >= 1) { cameraState.worldY += 1; cameraState.localOffsetY -= 1; }
  while (cameraState.localOffsetY < 0) { cameraState.worldY -= 1; cameraState.localOffsetY += 1; }
  while (cameraState.localOffsetZ >= 1) { cameraState.worldZ += 1; cameraState.localOffsetZ -= 1; }
  while (cameraState.localOffsetZ < 0) { cameraState.worldZ -= 1; cameraState.localOffsetZ += 1; }
}

export class ThirdPersonPlayerControls {
  constructor(canvas, cameraState, playerState, {
    speed = 7.2,
    lookSpeed = 0.004,
    pitchSpeed = 0.003,
    sprintMultiplier = 5,
    pitchMin = -0.92,
    pitchMax = 0.42,
    firstPersonPitchMin = pitchMin,
    firstPersonPitchMax = pitchMax,
  } = {}) {
    this.canvas = canvas;
    this.cameraState = cameraState;
    this.playerState = playerState;
    this.speed = speed;
    this.lookSpeed = lookSpeed;
    this.pitchSpeed = pitchSpeed;
    this.sprintMultiplier = sprintMultiplier;
    this.pitchMin = pitchMin;
    this.pitchMax = pitchMax;
    this.firstPersonPitchMin = firstPersonPitchMin;
    this.firstPersonPitchMax = firstPersonPitchMax;
    this.firstPersonEnabled = false;
    this.keys = new Set();
    this.pointerId = null;
    this.lastX = 0;
    this.lastY = 0;
    this.joystick = { active: false, x: 0, y: 0 };
    this.move = { x: 0, z: 0, dx: 0, dz: 0, yaw: playerState.avatarYaw ?? playerState.yaw ?? 0, moving: false, actualMoving: false };
    this._onKeyDown = (event) => {
      if (event.code === "Space") {
        this.jumpQueued = true;
        event.preventDefault();
      }
      this.keys.add(event.code);
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    this._onPointerDown = (event) => this.pointerDown(event);
    this._onPointerMove = (event) => this.pointerMove(event);
    this._onPointerUp = (event) => this.pointerUp(event);
    this._onMouseMove = (event) => this.mouseMove(event);
    this.jumpQueued = false;
    addEventListener("keydown", this._onKeyDown);
    addEventListener("keyup", this._onKeyUp);
    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointermove", this._onPointerMove);
    canvas.addEventListener("pointerup", this._onPointerUp);
    canvas.addEventListener("pointercancel", this._onPointerUp);
    globalThis.document?.addEventListener?.("mousemove", this._onMouseMove);
  }

  setJoystick(x, y, active = true) {
    this.joystick.active = active;
    this.joystick.x = Number(x) || 0;
    this.joystick.y = Number(y) || 0;
  }

  setFirstPersonEnabled(enabled, { requestPointerLock = enabled } = {}) {
    this.firstPersonEnabled = Boolean(enabled);
    this.pointerId = null;
    if (!this.firstPersonEnabled) {
      const pitch = Number.isFinite(this.playerState.cameraPitch)
        ? this.playerState.cameraPitch
        : (Number.isFinite(this.cameraState.pitch) ? this.cameraState.pitch : 0);
      this.playerState.cameraPitch = clamp(pitch, this.pitchMin, this.pitchMax);
      this.cameraState.pitch = this.playerState.cameraPitch;
      if (globalThis.document?.pointerLockElement === this.canvas) {
        try {
          globalThis.document.exitPointerLock?.();
        } catch {
          // Pointer lock release is best-effort across browsers.
        }
      }
    } else if (requestPointerLock) {
      this.requestPointerLock();
    }
    return this.firstPersonEnabled;
  }

  requestPointerLock() {
    if (!this.firstPersonEnabled || globalThis.document?.pointerLockElement === this.canvas) return false;
    try {
      const result = this.canvas.requestPointerLock?.();
      if (result && typeof result.catch === "function") result.catch(() => {});
      return Boolean(this.canvas.requestPointerLock);
    } catch {
      return false;
    }
  }

  update(dt) {
    let inputX = 0;
    let inputZ = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) inputZ -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) inputZ += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) inputX -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) inputX += 1;
    if (this.joystick.active) {
      inputX += this.joystick.x;
      inputZ += this.joystick.y;
    }
    const len = Math.hypot(inputX, inputZ);
    this.move.moving = len > 0.001;
    this.move.actualMoving = false;
    if (!this.move.moving) {
      this.move.x = 0;
      this.move.z = 0;
      this.move.dx = 0;
      this.move.dz = 0;
      return;
    }
    inputX /= len;
    inputZ /= len;
    const yaw = Number.isFinite(this.playerState.controlYaw) ? this.playerState.controlYaw : this.playerState.yaw;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = forwardZ;
    const rightZ = -forwardX;
    const moveX = forwardX * inputZ + rightX * inputX;
    const moveZ = forwardZ * inputZ + rightZ * inputX;
    const speed = this.speed * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? this.sprintMultiplier : 1);
    this.move.x = moveX;
    this.move.z = moveZ;
    this.move.dx = moveX * speed * dt;
    this.move.dz = moveZ * speed * dt;
    this.move.yaw = Math.atan2(-moveX, -moveZ);
  }

  consumeJump() {
    const queued = this.jumpQueued || this.keys.has("Space");
    this.jumpQueued = false;
    return queued;
  }

  pointerDown(event) {
    if (this.pointerId !== null) return;
    if (this.firstPersonEnabled) this.requestPointerLock();
    this.pointerId = event.pointerId;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  pointerMove(event) {
    if (this.firstPersonEnabled && globalThis.document?.pointerLockElement === this.canvas) return;
    if (event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.updateLook(dx, dy);
  }

  mouseMove(event) {
    if (!this.firstPersonEnabled || globalThis.document?.pointerLockElement !== this.canvas) return;
    const dx = Number(event.movementX) || 0;
    const dy = Number(event.movementY) || 0;
    if (!dx && !dy) return;
    this.updateLook(dx, dy);
  }

  updateLook(dx, dy) {
    const yaw = Number.isFinite(this.playerState.controlYaw) ? this.playerState.controlYaw : this.playerState.yaw;
    this.playerState.controlYaw = yaw - dx * this.lookSpeed;
    const pitch = Number.isFinite(this.playerState.cameraPitch) ? this.playerState.cameraPitch : this.cameraState.pitch;
    const pitchMin = this.firstPersonEnabled ? this.firstPersonPitchMin : this.pitchMin;
    const pitchMax = this.firstPersonEnabled ? this.firstPersonPitchMax : this.pitchMax;
    this.playerState.cameraPitch = clamp(pitch - dy * this.pitchSpeed, pitchMin, pitchMax);
    this.cameraState.pitch = this.playerState.cameraPitch;
  }

  pointerUp(event) {
    if (event.pointerId === this.pointerId) this.pointerId = null;
  }

  dispose() {
    removeEventListener("keydown", this._onKeyDown);
    removeEventListener("keyup", this._onKeyUp);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("pointermove", this._onPointerMove);
    this.canvas.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.removeEventListener("pointercancel", this._onPointerUp);
    globalThis.document?.removeEventListener?.("mousemove", this._onMouseMove);
  }
}
