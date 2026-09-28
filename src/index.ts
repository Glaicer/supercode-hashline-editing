import { Plugin } from "@opencode/plugin"
import { setupHashlinePlugin } from "./plugin.ts"

export const HASHLINE_PLUGIN_ID = "supercode.hashline.server"

export default Plugin.define({
  id: HASHLINE_PLUGIN_ID,
  async setup(ctx) {
    return setupHashlinePlugin(ctx)
  },
})
