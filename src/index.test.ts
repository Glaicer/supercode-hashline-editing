import { test } from "node:test"
import assert from "node:assert/strict"

import definition, { HASHLINE_PLUGIN_ID } from "./index.ts"
import * as pluginModule from "./plugin.ts"

test("entrypoint is a V2 plugin definition around the setup seam", () => {
  assert.equal(typeof definition.id, "string")
  assert.equal(definition.id, HASHLINE_PLUGIN_ID)
  assert.equal(typeof definition.setup, "function")

  assert.equal(typeof pluginModule.setupHashlinePlugin, "function")
  assert.equal(pluginModule.setupHashlinePlugin.name, "setupHashlinePlugin")
})
