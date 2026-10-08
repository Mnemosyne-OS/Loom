/**
 * The summary of one app's work (doc 140 §6, lot 2).
 *
 * What goes in: the commit messages of the line, and what the PERSON typed in
 * the conversations tied to it. Never the agent's replies or tool output: the
 * chat once copied its own past answers back as memory (doc 129), and the
 * person's words are what says what was wanted.
 *
 * The prompt has a character budget. It is filled with the NEWEST material
 * first (a summary of recent work is the useful one), then restored to time
 * order, and the screen says what was left out: a trimmed input presented as
 * complete would be a summary of something that never happened.
 *
 * 🚨 The model writes words, never numbers: the counts and durations are
 * shown by the app next to the text, from its own arithmetic (doc 75 rule).
 */
import type { Commit } from './types';

/** Characters allowed into one prompt (≈ 6 000 tokens). */
export const DIGEST_BUDGET = 24_000;
/** A single typed message is cut past this, so one pasted log cannot eat the budget. */
const MAX_TURN_CHARS = 600;

const LANGUAGE_NAME: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', pt: 'European Portuguese', ru: 'Russian', zh: 'Simplified Chinese',
};

export interface DigestConversation {
  title: string | null;
  start: number;
  /** What the person typed, in order. */
  turns: Array<{ at: number | null; text: string }>;
}

export interface DigestInput {
  lane: string;
  commits: readonly Commit[];
  conversations: readonly DigestConversation[];
  lang: string;
  budget?: number;
}

export interface DigestPrompt {
  systemPrompt: string;
  prompt: string;
  commitsUsed: number;
  commitsTotal: number;
  conversationsUsed: number;
  conversationsTotal: number;
  /** The span the sent material covers, oldest to newest. Null when nothing was sent. */
  from: number | null;
  to: number | null;
  chars: number;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function buildDigestPrompt(input: DigestInput): DigestPrompt {
  const budget = input.budget ?? DIGEST_BUDGET;
  const language = LANGUAGE_NAME[input.lang.slice(0, 2)] ?? 'English';

  // Half the budget for commit messages, the rest for the person's words; what
  // one side leaves unused goes to the other.
  const commitsNewest = [...input.commits].sort((a, b) => b.at - a.at);
  const commitLines: Array<{ at: number; line: string }> = [];
  let used = 0;
  const commitBudget = Math.floor(budget / 2);
  for (const c of commitsNewest) {
    const line = `${day(c.at)} ${c.subject}`;
    if (used + line.length + 1 > commitBudget) break;
    used += line.length + 1;
    commitLines.push({ at: c.at, line });
  }

  const convNewest = [...input.conversations].sort((a, b) => b.start - a.start);
  const convBlocks: Array<{ start: number; text: string }> = [];
  for (const conv of convNewest) {
    const turns = conv.turns
      .map((t) => t.text.trim())
      .filter(Boolean)
      .map((t) => (t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)}…` : t));
    if (!turns.length) continue;
    const text = `## ${day(conv.start)} — ${conv.title?.trim() || 'untitled'}\n${turns.map((t) => `- ${t}`).join('\n')}`;
    if (used + text.length + 2 > budget) {
      if (convBlocks.length) break;
      continue;
    }
    used += text.length + 2;
    convBlocks.push({ start: conv.start, text });
  }

  commitLines.sort((a, b) => a.at - b.at);
  convBlocks.sort((a, b) => a.start - b.start);
  const times = [...commitLines.map((c) => c.at), ...convBlocks.map((c) => c.start)];

  const systemPrompt = [
    `You are Mnemosyne. You write in ${language}.`,
    '',
    `You are given the commit messages of one part of a software project ("${input.lane}"),`,
    'and the messages the PERSON typed in the agent conversations that worked on it.',
    'You never saw the agent\'s replies, the code or any result.',
    '',
    'Write what was built, what was fixed and what was decided there, in time order,',
    'in 5 to 10 plain sentences.',
    '',
    'Rules you do not break:',
    '- No numbers, no counts, no durations: the app shows them next to your text.',
    '- Never invent an outcome. If the messages do not say whether something worked,',
    '  say that it is not visible in what you read.',
    '- Never claim to have seen code, files or results.',
    '- No preamble, no heading, no bullet list.',
  ].join('\n');

  const prompt = [
    `# Commit messages (${commitLines.length} of ${input.commits.length}, oldest first)`,
    ...commitLines.map((c) => c.line),
    '',
    `# What the person typed (${convBlocks.length} of ${input.conversations.length} conversations, oldest first)`,
    ...convBlocks.map((c) => c.text),
  ].join('\n');

  return {
    systemPrompt,
    prompt,
    commitsUsed: commitLines.length,
    commitsTotal: input.commits.length,
    conversationsUsed: convBlocks.length,
    conversationsTotal: input.conversations.length,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    chars: systemPrompt.length + prompt.length,
  };
}

/** About four characters a token for English and French prose. Said as "about". */
export function approxTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** A summary kept for one line, read back with its date. */
export interface StoredDigest {
  text: string;
  /** When it was written. */
  at: number;
  from: number | null;
  to: number | null;
  commitsUsed: number;
  commitsTotal: number;
  conversationsUsed: number;
  conversationsTotal: number;
  /** The newest commit of the line when it was written: a newer one makes it out of date. */
  lastSha: string | null;
}
