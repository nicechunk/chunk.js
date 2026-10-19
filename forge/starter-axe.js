// Canonical starter axe presentation. Legacy custody bytes stay immutable.
export const STARTER_AXE_CODE = "NCF1.8BGEtxXQTFpWNmBGAPEiFQDGwMAAFABAD_f_ggACIkEBwoAAKAGQABVWBA4EAAFAJIAKuXBAQEAACYAEAAA";
export const STARTER_AXE_BYTES = Object.freeze([240,17,132,183,21,208,76,90,86,54,96,70,0,241,34,21,0,198,192,192,0,20,0,64,15,247,255,130,0,2,34,65,1,194,128,0,40,1,144,0,21,86,4,14,4,0,1,64,36,128,10,185,112,64,64,64,0,9,128,4,0,0]);
export const LEGACY_STARTER_AXE_CODE = "NCF1.8BGEtxXQTFpWNmBGAPEiFQDGwMAAFABAD_QAYgACIkKBwQAYKAAQABVWBA4EAkFAAIAKuXBAQEAACYAEAAA";
export const LEGACY_STARTER_AXE_BYTES = Object.freeze([240,17,132,183,21,208,76,90,86,54,96,70,0,241,34,21,0,198,192,192,0,20,0,64,15,244,0,98,0,2,34,66,129,193,0,24,40,0,16,0,21,86,4,14,4,2,65,64,0,128,10,185,112,64,64,64,0,9,128,4,0,0]);

function matchesBytes(bytes, expected) {
  return (Array.isArray(bytes) || ArrayBuffer.isView(bytes)) && bytes.length === expected.length
    && expected.every((value, index) => bytes[index] === value);
}

export function isStarterAxeModelBytes(bytes) {
  return matchesBytes(bytes, STARTER_AXE_BYTES) || matchesBytes(bytes, LEGACY_STARTER_AXE_BYTES);
}

// Already-crafted v1 axes keep their authenticated NCF1, hash and durability.
// This changes their avatar mount only. The new model uses its encoded north
// (-Z) handle grip; the equivalent v1 face is -X before the model-space turn.
export function forgeAvatarGripForRuntime(runtime) {
  if (matchesBytes(runtime?.bytes, LEGACY_STARTER_AXE_BYTES)) {
    return {offsetQ: [-1, 7, 0], axis: 0, sign: -1, rotation: 0};
  }
  return runtime?.grip ?? null;
}
