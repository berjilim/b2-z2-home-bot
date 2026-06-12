import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the composite system prompt from the three prompt files in promptsDir:
 *   persona.md       — identity, tone, scope (B2-writable)
 *   system-core.md   — operational rules (Tron-managed)
 *   custom-rules.md  — home-specific behavioural overrides (B2-writable)
 *
 * Missing files are silently skipped.
 */
export function buildSystemPrompt(promptsDir) {
    return ["persona.md", "system-core.md", "custom-rules.md"]
        .map((f) => {
            try { return readFileSync(join(promptsDir, f), "utf-8").trim(); }
            catch { return null; }
        })
        .filter(Boolean)
        .join("\n\n---\n\n");
}
