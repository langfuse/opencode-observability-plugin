import V1Plugin from "./v1.js";
import V2Plugin from "./v2.js";

export default {
  ...V2Plugin,
  server: V1Plugin,
};
