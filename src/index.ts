import { type PluginContext } from "@lmstudio/sdk";
import { createPreprocessor } from "./promptPreprocessor";
import { createToolsProvider } from "./tools";
import { RUNTIME_CONFIG } from "./engine/config";
import { applySettings } from "./engine/settings";
import { configSchematics, globalConfigSchematics, readSettings } from "./settings";

export async function main(context: PluginContext) {
  // plugin settings -> vault.json -> LM_RECALL_VAULT -> defaults, read per call
  const config = (ctl: Parameters<typeof readSettings>[0]) => applySettings(RUNTIME_CONFIG, readSettings(ctl));
  context
    .withGlobalConfigSchematics(globalConfigSchematics)
    .withConfigSchematics(configSchematics)
    .withPromptPreprocessor(createPreprocessor(config))
    .withToolsProvider(createToolsProvider(config));
}
