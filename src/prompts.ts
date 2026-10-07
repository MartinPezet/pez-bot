import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Built-in prompts ship in the image (/opt/runner/prompts). A target repo can override any of
 * them with `.backlog-runner/prompts/<name>.md` on its default branch.
 */

export const PROMPT_NAMES = ['propose', 'apply', 'fix', 'validate-fix', 'triage', 'prd-to-backlog'] as const
export type PromptName = (typeof PROMPT_NAMES)[number]

export function builtinPromptDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'prompts'), path.join(here, '..', 'prompts'), path.join(here, '..', 'src', 'prompts')]
  return candidates.find(d => existsSync(path.join(d, 'propose.md'))) ?? candidates[1]!
}

export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)

export type ReadOverride = (file: string) => Promise<string | null>

export async function loadPrompt(name: PromptName, readOverride: ReadOverride, dir = builtinPromptDir()): Promise<string> {
  return (await readOverride(`.backlog-runner/prompts/${name}.md`)) ?? readFile(path.join(dir, `${name}.md`), 'utf8')
}
