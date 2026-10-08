/**
 * host.ts — the one door between Loom and the shell.
 *
 * Actions used (doc 52): `git.declareRepo` / `git.repos` / `git.forgetRepo` /
 * `git.log` (git:read), `dialog.selectFolder` / `dialog.readDir` /
 * `dialog.readFile` / `dialog.openInOS` (dialog:open), and
 * `agent.exportConversation` (agent:export), `model.infer` (model:infer, the
 * summary of one app, on a press).
 */
import { CONNECTORS, readSession } from '@mnemosyne_os/agent-transcripts';

/**
 * How many typed messages the transcript reader keeps per conversation (the
 * last ones). Its own constant is not exported; the value is restated here and
 * only used to SAY that a conversation was cut.
 */
const MAX_HUMAN_TURNS = 40;
import { MnemoCartridgeSDK } from '../sdk/mnemo-sdk';
import type { Invoke } from './scan';

/** Must match "name" in mnemo-plugin.json: the host keys repository
 *  declarations AND the premium gate (PREMIUM_CARTRIDGE_IDS) on it. */
export const PLUGIN_ID = '@mnemosyne-plugins/loom';

export const sdk = new MnemoCartridgeSDK(PLUGIN_ID);

export const invoke: Invoke = (action, payload, timeoutMs) => sdk.invoke(action, payload, timeoutMs);

/** True inside the Mnemosyne shell. Standalone (dev), nothing can be read. */
export function hasHost(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/** A declared repository as the host lists it (never its path). */
export interface RepoRef { id: string; name: string; addedAt: string; missing: boolean }

/** User-paced: the host opens its folder dialog, so no timeout. */
export function declareRepo(): Promise<RepoRef> {
  return sdk.invoke<RepoRef>('git.declareRepo', undefined, 0);
}

/** The repositories this cartridge was given (ids and names, never paths). */
export async function listRepos(): Promise<RepoRef[]> {
  const res = await sdk.invoke<{ repos: RepoRef[] }>('git.repos');
  return res.repos;
}

/** Remove one declared repository from this cartridge's list. */
export function forgetRepo(repoId: string): Promise<unknown> {
  return sdk.invoke('git.forgetRepo', { repoId });
}

/**
 * What a refused action said, kept WHOLE. The screen turns a known CODE into
 * its sentence and shows anything else as it came. Folding unknown messages
 * into one word lost the host's own reason ("path outside user home
 * directory") and the person read "Something failed: generic".
 */
export function errorCodeOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim() || 'generic';
}

/** Write the conversation as a readable document beside its transcript, then open it. */
export async function openConversation(transcript: string, title: string): Promise<void> {
  const res = await sdk.invoke<{ success: boolean; file?: string; error?: string }>(
    'agent.exportConversation', { transcript, title });
  if (!res?.success || !res.file) throw new Error(res?.error || 'EXPORT_REFUSED');
  const opened = await sdk.openInOS(res.file);
  if (!opened?.success) throw new Error(opened?.error || 'OPEN_REFUSED');
}

/**
 * What the person typed in one conversation, read again from its transcript on
 * a press (Loom keeps no text between readings). Null when the host refused.
 */
export async function readHumanTurns(transcript: string): Promise<{ turns: Array<{ at: number | null; text: string }>; capped: boolean } | null> {
  const res = await sdk.invoke<{ success: boolean; content?: string; error?: string }>('dialog.readFile', { filePath: transcript });
  if (!res?.success || typeof res.content !== 'string') return null;
  const name = transcript.replace(/\\/g, '/').split('/').pop() ?? transcript;
  const st = readSession(CONNECTORS['claude-code'], name, transcript, res.content, res.content.length);
  if (!st) return { turns: [], capped: false };
  return {
    turns: st.humanTurns
      .map((t) => {
        const at = t.at ? Date.parse(t.at) : NaN;
        // A pasted image arrives as a stub line; it is not words the person typed.
        const text = t.text.replace(/\[Image: source: [^\]]*\]/g, '').trim();
        return { at: Number.isFinite(at) ? at : null, text };
      })
      .filter((t) => t.text),
    // The reader keeps the LAST MAX_HUMAN_TURNS messages of a long session.
    capped: st.humanTurns.length >= MAX_HUMAN_TURNS,
  };
}

/** One inference on the person's active model, with no memory mixed in. */
export async function inferText(prompt: string, systemPrompt: string): Promise<string> {
  const res = await sdk.inferModel({ prompt, systemPrompt, disableRAG: true, temperature: 0.3 });
  const text = res.text ?? res.response ?? res.content ?? res.answer ?? '';
  if (!text.trim()) throw new Error(res.error || 'EMPTY_ANSWER');
  return text.trim();
}
