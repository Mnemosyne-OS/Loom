<div align="center">

<img src="https://raw.githubusercontent.com/Mnemosyne-OS/Mnemosyne-Neural-OS/main/assets/banner-mnemosyne-os.png" width="100%" alt="Mnemosyne OS — Your memory. Your machine. Your rules." />

🌐 [**mnemosyne-os.io**](https://mnemosyne-os.io) — the product&ensp;·&ensp;[**mnemosyne-os.com**](https://mnemosyne-os.com) — for organizations&ensp;·&ensp;📖 [**docs.mnemosyne-os.io**](https://docs.mnemosyne-os.io) — the documentation

</div>

# Loom

The history of a code project on one timeline, with the agent conversations
that built it. A [Mnemosyne OS](https://github.com/Mnemosyne-OS/Mnemosyne-Neural-OS)
cartridge.

> [!WARNING]
> **Loom is in beta, and it needs a version of Mnemosyne OS newer than 1.7.0.**
>
> Version 0.1.0 means what it says. Loom uses a host door (`git:read`) that
> ships after Mnemosyne OS 1.7.0. On 1.7.0, choosing a repository fails.
>
> It was built and run on the author's machine only: Windows, one repository
> of 7,300 commits, 734 Claude Code conversations. macOS, Linux and other
> folder layouts have not been tried yet. If a line looks wrong or a link points
> to the wrong conversation, please open an issue.

---

## What it shows

You choose a git repository and the folder where Claude Code keeps its
conversations. Loom draws the project on a timeline you can drag and zoom.

- **One line per app.** In a monorepo, Loom finds the folders that hold the
  apps (`apps/`, `packages/`, `libs/`…) from the file paths of the commits. Each
  app gets its own line. A very large app is split into sub-lines that follow
  its own folders. You can also switch to one line per commit scope.
- **One point per commit**, coloured by type: feature, fix, docs, other.
- **The conversations that made each commit.** Click a point to see them in two
  lists:
  - *Made in this conversation*: the conversation printed the commit, or ran
    `git commit` with exactly this message.
  - *Probably made in*: the conversation wrote one of the commit's files at that
    time. Loom marks this as a coincidence, drawn dashed.
- **Active time.** Loom counts the time each conversation was active: events
  less than 15 minutes apart. Parallel conversations count once. Each app shows
  its total.
- **An app's card.** Click an app's name: commits, active time, types, commits
  per week, the conversations that worked on it, the files changed most.
- **Milestones.** A diamond on the commit that first brought a numbered design
  document (`docs/…/042_name.md`, or an ADR), and your agents' memory notes on
  their own line.
- **A summary of one app, on request.** See [What leaves your machine](#what-leaves-your-machine).

Loom speaks the seven languages of Mnemosyne OS: English, French, Spanish,
German, Portuguese, Russian and Chinese.

## Measured on the author's repository

| | |
|---|---|
| Commits | 7,300 |
| Conversations read | 734 (3.1 GB of transcripts) |
| Commits made in a known conversation | 55 % |
| Commits probably made in one | 19 % |
| Commits with no conversation found | 26 % |
| Probable links that were right, checked against known ones | 98.6 % |
| First reading | 69 s |
| Next readings (cache) | 0.4 s |

The figures cover the period since the first conversation still on disk.
Claude Code deletes old transcripts, so older commits have no conversation.

## Requirements

- **Mnemosyne OS newer than 1.7.0** ([latest release](https://github.com/Mnemosyne-OS/Mnemosyne-Neural-OS/releases/latest)).
- **An active Engramm license.** Loom is a premium cartridge. The app refuses
  to install or launch it without a license, and its card says so.
- **git** installed on the computer.
- **Claude Code conversations** for the links. With another agent, or none,
  Loom draws the commits only.

## Installing it

1. In Mnemosyne OS, open **MnemoHub**.
2. Choose **Add an external cartridge**, then **A repository**.
3. Paste `https://github.com/Mnemosyne-OS/Loom` and press **Read it**.
4. Check the name, the version and the permissions, then press **Install**.

Updates come from this repository: the manifest declares `updateStrategy: git`.

## Permissions

| Permission | What Loom does with it |
|---|---|
| `git:read` | Reads the history of the repository you pick in the app's own folder dialog: dates, author names, commit messages and file names. Loom names it by an id and never sees its path. |
| `dialog:open` | Reads the conversation folders you add, and opens a conversation or a memory note on your press. |
| `agent:export` | Writes one conversation as a readable document next to its transcript, on your press, so it can be opened. |
| `model:infer` | Writes the summary of one app, on your press. |

## What leaves your machine

Loom reads your repository history and your transcripts on your computer. It
keeps a cache of what it read (dates, file names, short commit ids) in its own
storage.

One action sends text out: **Summary** in an app's card. Loom first shows what
it would send: how many characters, about how many tokens, how many commits and
conversations. Then you press **Send**. The text goes to the model you chose in
Mnemosyne OS, local or cloud. It contains the app's commit messages and the
messages **you** typed in its conversations. The agents' replies stay out. The
cost appears in the cost journal of Mnemosyne OS.

## Building it

The published repository carries a built `dist/`. To build from source inside
the Mnemosyne OS workspace:

```bash
pnpm install
pnpm --filter @mnemosyne-plugins/loom build
pnpm --filter @mnemosyne-plugins/loom test
```

In a development workspace, `entrypoints.renderer` points at
`http://localhost:5235/index.html` so the cartridge can be linked with hot
reload. The published manifest points at `index.html`.

## License

MIT. See [LICENSE](LICENSE).

## Where Mnemosyne OS lives

This cartridge runs inside **Mnemosyne OS**, the sovereign, local-first memory operating system published by XPACEGEMS LLC. Its official addresses:

- Product site: <https://mnemosyne-os.io>
- Organizations: <https://mnemosyne-os.com>
- Documentation: <https://docs.mnemosyne-os.io>
- Host source: <https://github.com/Mnemosyne-OS/Mnemosyne-Neural-OS>
- Packages: the npm scope `@mnemosyne_os`

---

<sub>**[Mnemosyne OS](https://mnemosyne-os.io)** — the sovereign, local-first memory OS this cartridge runs in.
Get it at [mnemosyne-os.io/download](https://mnemosyne-os.io/download), install cartridges from the built-in MnemoHub store, or [build your own](https://mnemosyne-os.io/dev).</sub>
