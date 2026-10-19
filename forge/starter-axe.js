// Compatibility entry: direct consumers keep synchronous legacy presentation.
// The normal avatar dependency imports the lightweight renderer module instead.
import "./forge-runtime-cache.js";
export {
  STARTER_AXE_CODE, STARTER_AXE_BYTES, SHORT_STARTER_AXE_CODE, SHORT_STARTER_AXE_BYTES,
  LEGACY_STARTER_AXE_CODE, LEGACY_STARTER_AXE_BYTES, isStarterAxeModelBytes,
  forgePresentationForRuntime, forgeAvatarGripForRuntime,
} from "../renderer/forge-avatar-presentation.js";
