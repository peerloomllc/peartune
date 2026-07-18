import { types as T, healthUtil } from "../deps.ts";

// The dashboard binds 8741 inside the container; the internal address is
// <pkg-id>.embassy. A 2xx from the root page (the login form) means the host is
// up and serving.
export const health: T.ExpectedExports.health = {
  async "web-ui"(effects, duration) {
    return healthUtil
      .checkWebUrl("http://peartune.embassy:8741")(effects, duration)
      .catch(healthUtil.catchError(effects));
  },
};
