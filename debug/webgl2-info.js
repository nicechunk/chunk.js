import { detectWebGl2Support } from "../src/index.js";

const status = document.querySelector("#supportStatus");
const output = document.querySelector("#debugOutput");

const support = detectWebGl2Support();
if (!support.supported) {
  status.textContent = "Unavailable";
  output.textContent = JSON.stringify({ reason: support.reason, label: support.label }, null, 2);
} else {
  status.textContent = "Available";
  output.textContent = JSON.stringify(support, null, 2);
}
