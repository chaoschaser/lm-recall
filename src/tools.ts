//
// The recall and promote tools (Phase 3c), as LM Studio sees them. The work
// is in engine/capture.ts; this file only describes the tools to the model.
//
// LM Studio may ask the user to approve each tool call (it has a
// "confirming tool call" step); whether it does for plugin tools is checked
// in the app, not assumed here.
//

import { rawFunctionTool, type ToolsProvider, type ToolsProviderController } from "@lmstudio/sdk";
import { captureNote, promoteNote, type CaptureResult } from "./engine/capture";
import type { HomelabConfig } from "./engine/homelab";

const RECALL_DESCRIPTION =
  "Save a short note to the user's vault inbox. Only use this when the user asks to " +
  "save, remember, note or capture something. Write it from what the user said; do not add facts. " +
  "Before calling, show the user the title and text you will save.";

const PROMOTE_DESCRIPTION =
  "Turn a note in the user's vault inbox into a permanent note (a zettel). Only use this when the user " +
  "asks to promote a note. Afterwards the inbox note is moved to the vault's .trash folder.";

const string = (description: string) => ({ type: "string", description });
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

export function createToolsProvider(
  getConfig: (ctl: ToolsProviderController) => HomelabConfig,
  now: () => Date = () => new Date(),
): ToolsProvider {
  const run = async (ctl: ToolsProviderController, fn: typeof captureNote, params: Record<string, unknown>) => {
    let result: CaptureResult;
    try {
      result = await fn(getConfig(ctl), params, now());
    } catch (err) {
      // Unexpected: say so without paths or a stack trace; the details go to `lms dev`.
      console.error("[lm-recall] tool failed:", err);
      return "Something went wrong and nothing was saved. Tell the user, and show them the note text so nothing is lost.";
    }
    console.log(`[lm-recall] ${fn.name}: ok=${result.ok}${result.relPath ? ` ${result.relPath}` : ""}`);
    return result.message;
  };

  return async (ctl) => [
    rawFunctionTool({
      name: "recall",
      description: RECALL_DESCRIPTION,
      parametersJsonSchema: {
        type: "object",
        properties: {
          title: string("Short title, a few words. Becomes the filename."),
          project: string("The project this belongs to, if the chat says; otherwise leave out."),
          what_happened: string("What happened, in 1 to 3 sentences."),
          why_it_matters: string("Why it matters, in 1 to 2 sentences."),
          links: list("Names or ids of existing vault notes this relates to, e.g. ct-101. Unknown ones are left out."),
        },
        required: ["title", "what_happened", "why_it_matters"],
      },
      implementation: (params) => run(ctl, captureNote, params),
    }),
    rawFunctionTool({
      name: "promote",
      description: PROMOTE_DESCRIPTION,
      parametersJsonSchema: {
        type: "object",
        properties: {
          note: string("The inbox note to promote: its title or filename."),
          title: string("Title of the permanent note. Defaults to the inbox note's title."),
          idea: string("The idea, in your words, in a few sentences. Defaults to the inbox note's 'What happened'."),
          why_it_matters: string("Why it matters. Defaults to the inbox note's 'Why it matters'."),
          connected_to: list("Names or ids of existing vault notes this connects to. Unknown ones are left out."),
          tags: list("2 to 5 short topic tags, lower case, e.g. homelab, mediaserver, networking."),
          summary: string("One sentence saying what the note is about, for search and for the user scanning their vault."),
        },
        required: ["note"],
      },
      implementation: (params) => run(ctl, promoteNote, params),
    }),
  ];
}
