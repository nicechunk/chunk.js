import assert from "node:assert/strict";
import test from "node:test";

import { createProgram } from "../renderer/shader-manager.js";

test("shader program creation releases the vertex shader when fragment compilation fails", () => {
  const { gl, state } = fakeGl({ failFragment: true });
  assert.throws(() => createProgram(gl, "vertex", "fragment"), /fragment compile failed/);
  assert.deepEqual(state.deletedShaders.map((shader) => shader.type).sort(), [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER]);
  assert.equal(state.createdPrograms.length, 0);
});

test("shader allocation is released when setup throws before compilation status", () => {
  const { gl, state } = fakeGl({ throwDuringFragmentSetup: true });
  assert.throws(() => createProgram(gl, "vertex", "fragment"), /fragment setup failed/);
  assert.deepEqual(state.deletedShaders.map((shader) => shader.type).sort(), [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER]);
  assert.equal(state.createdPrograms.length, 0);
});

test("shader program creation releases shaders and program when linking fails", () => {
  const { gl, state } = fakeGl({ failLink: true });
  assert.throws(() => createProgram(gl, "vertex", "fragment"), /program link failed/);
  assert.equal(state.deletedShaders.length, 2);
  assert.deepEqual(state.deletedPrograms, state.createdPrograms);
});

test("a linked shader program keeps only the program object", () => {
  const { gl, state } = fakeGl();
  const program = createProgram(gl, "vertex", "fragment");
  assert.equal(program, state.createdPrograms[0]);
  assert.equal(state.deletedShaders.length, 2);
  assert.equal(state.deletedPrograms.length, 0);
});

function fakeGl({ failFragment = false, failLink = false, throwDuringFragmentSetup = false } = {}) {
  const state = {
    createdShaders: [],
    deletedShaders: [],
    createdPrograms: [],
    deletedPrograms: [],
  };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    createShader(type) {
      const shader = { type };
      state.createdShaders.push(shader);
      return shader;
    },
    shaderSource(shader) {
      if (throwDuringFragmentSetup && shader.type === this.FRAGMENT_SHADER) {
        throw new Error("fragment setup failed");
      }
    },
    compileShader() {},
    getShaderParameter(shader) {
      return !(failFragment && shader.type === this.FRAGMENT_SHADER);
    },
    getShaderInfoLog(shader) {
      return shader.type === this.FRAGMENT_SHADER ? "fragment compile failed" : "vertex compile failed";
    },
    deleteShader(shader) {
      state.deletedShaders.push(shader);
    },
    createProgram() {
      const program = {};
      state.createdPrograms.push(program);
      return program;
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() {
      return !failLink;
    },
    getProgramInfoLog() {
      return "program link failed";
    },
    deleteProgram(program) {
      state.deletedPrograms.push(program);
    },
  };
  return { gl, state };
}
