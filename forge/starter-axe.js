import { restoreForgeRuntime } from "./forge-runtime-cache.js";

// Canonical long-handled starter axe. Authenticated legacy bytes stay immutable.
export const STARTER_AXE_CODE = "NCF1.8BGEtxXQTFpWNmBGAPEiFQDNgMAAMABAD7__ggACIkEBwoAAXgGQABVWBA4EAALwJIAKuXBAQEAAFwAEAAA";
export const STARTER_AXE_BYTES = Object.freeze([240,17,132,183,21,208,76,90,86,54,96,70,0,241,34,21,0,205,128,192,0,48,0,64,15,191,255,130,0,2,34,65,1,194,128,0,94,1,144,0,21,86,4,14,4,0,2,240,36,128,10,185,112,64,64,64,0,23,0,4,0,0]);
export const SHORT_STARTER_AXE_CODE = "NCF1.8BGEtxXQTFpWNmBGAPEiFQDGwMAAFABAD_f_ggACIkEBwoAAKAGQABVWBA4EAAFAJIAKuXBAQEAACYAEAAA";
export const SHORT_STARTER_AXE_BYTES = Object.freeze([240,17,132,183,21,208,76,90,86,54,96,70,0,241,34,21,0,198,192,192,0,20,0,64,15,247,255,130,0,2,34,65,1,194,128,0,40,1,144,0,21,86,4,14,4,0,1,64,36,128,10,185,112,64,64,64,0,9,128,4,0,0]);
export const LEGACY_STARTER_AXE_CODE = "NCF1.8BGEtxXQTFpWNmBGAPEiFQDGwMAAFABAD_QAYgACIkKBwQAYKAAQABVWBA4EAkFAAIAKuXBAQEAACYAEAAA";
export const LEGACY_STARTER_AXE_BYTES = Object.freeze([240,17,132,183,21,208,76,90,86,54,96,70,0,241,34,21,0,198,192,192,0,20,0,64,15,244,0,98,0,2,34,66,129,193,0,24,40,0,16,0,21,86,4,14,4,2,65,64,0,128,10,185,112,64,64,64,0,9,128,4,0,0]);

function matchesBytes(bytes, expected) {
  return (Array.isArray(bytes) || ArrayBuffer.isView(bytes)) && bytes.length === expected.length
    && expected.every((value, index) => bytes[index] === value);
}

export function isStarterAxeModelBytes(bytes) {
  return matchesBytes(bytes, STARTER_AXE_BYTES) || matchesBytes(bytes, SHORT_STARTER_AXE_BYTES) || matchesBytes(bytes, LEGACY_STARTER_AXE_BYTES);
}

// Rendering and collision share the new geometry for both previously issued
// starter axes. Restore/verify the original payload first; use this presentation
// only for drawing. Custody bytes, design hash, stats and durability stay intact.
let starterAxePresentation = null;
export function forgePresentationForRuntime(runtime) {
  if (matchesBytes(runtime?.bytes, SHORT_STARTER_AXE_BYTES) || matchesBytes(runtime?.bytes, LEGACY_STARTER_AXE_BYTES)) {
    return starterAxePresentation ??= restoreForgeRuntime(STARTER_AXE_CODE);
  }
  return runtime;
}

export function forgeAvatarGripForRuntime(runtime) {
  return forgePresentationForRuntime(runtime)?.grip ?? null;
}
