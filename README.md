# Jeffort

A Claude Code mod that sets Claude's effort level for each turn. [TypeSafe Jev](https://docs.typesafe.ai) scores your prompt on four narrow questions (reasoning depth, scope, stakes, ambiguity), and Jeffort maps the result onto an effort level. The model is never touched.

A band above the prompt shows the level it picked, an on/off button, and a bar of the estimated output tokens saved this session. Click **Jeffort** for a pane with stats and a theme picker.

## Install

```sh
claude plugin marketplace add andrewstephenson-v1/Jeffort
claude plugin install jeffort@jeffort --scope user
```

To try a local clone for one session instead: `claude --plugin-dir /path/to/Jeffort`.

Put your TypeSafe key in a key file. Jeffort looks, in order, at process variables, then `.env` or `jeffort.env` beside the plugin, then the same two names in `~/.config/jeffort/`. An installed copy runs from Claude Code's plugin cache, so use `~/.config/jeffort/`. Prefer `jeffort.env`: a `Read(**/.env)` permission rule in your Claude Code settings can stop plugins reading any file named exactly `.env`.

```sh
mkdir -p ~/.config/jeffort
printf 'TYPESAFE_API_KEY=your-key\nTYPESAFE_MODEL=jev-latest\n' > ~/.config/jeffort/jeffort.env
```

`TYPESAFE_MODEL` is optional and defaults to `jev-latest`. Prompts are sent to TypeSafe for scoring, with the name of the Claude model that will answer (so Jev can judge how much effort that model needs), and nothing else is.

## Usage

- `/jeffort` toggles it. `/jeffort on`, `off` and `pane` also work.
- `/jeffort reset` clears this session's and this project's totals; `/jeffort reset all` clears every project and the overall total.
- Totals are kept for this session, this project and all projects. A project is the session's project root, keyed by its full path, so two folders with the same name stay separate. A git worktree counts as its own project.
- **Appearance** tab: Default, Signal, Mono, Colour-safe, Retro, or Match terminal.
- Settings (`/config`): the lowest and highest level Jeffort may pick (`max` is off by default), and whether it sets effort for subagents too (on by default).

## When it acts

Jeffort only rewrites effort on Opus 5.5, Sonnet 5.5 and Fable 5.1, with an API key or a Claude subscription. Those are the models where Claude Code keeps the prompt cache across effort changes. Anywhere else (Bedrock, Vertex, a Claude apps gateway, older models) it does nothing. Needs Claude Code 2.1.284 or later.

It also leaves these alone, so your own `/effort` stands:

- Turns where Jev's confidence is below 0.3.
- Turns where Jev cannot be reached or errors.

A turn with no prompt of yours, such as a continuation or a subagent reporting back, is not sent to Jev. It keeps the previous turn's level, or the session's effort if there is none yet.

Measured on Opus 5.5: the first effort change in a conversation rebuilds about 22k tokens of cache, once. Later changes keep it. That one-time cost is subtracted from the savings the band shows. Jeffort spots it as a large cache write on the first request of a turn whose level changed, so it is an estimate too: a compaction on such a turn can look the same.

## Subagents

Each subagent is scored once, on the task it was given, and keeps that level for its whole run. Its turns count toward the totals. It never counts as a cache rebuild, because a subagent starts a fresh conversation. A subagent on a model not listed above (Haiku, say) is left alone.

Jeffort only changes a subagent that inherited the session's effort. It cannot read an agent's definition, so it treats an effort other than the session's as one the definition set, and leaves it. The gap: an agent whose definition sets the same level as your session looks inherited and gets scored. Forks and teammates carry on the parent's conversation, so they are left alone too.

Turn it off with the **Subagents too** setting in `/config`.

## What the savings numbers are

Estimates. They assume fixed output-token ratios per effort level, relative to high: low 0.55, medium 0.75, high 1.0, xhigh 1.7, max 2.2. Low and xhigh are rounded from the coding benchmark in `bench/` (0.58 and 1.80). Medium is interpolated and max is a guess: neither was measured. Dollar figures cover Opus 5.5 and Sonnet 5.5 only.

## Benchmarks

`bench/` holds two benchmarks, each comparing fixed effort levels against Jeffort on Opus 5.5:

- `bench/run.py`: ten short questions.
- `bench/agentic/run.py`: eight coding tasks with file and shell tools, graded by tests.

`bench/jev_picks.py` is a survey rather than a benchmark: it records what Jeffort picks for 26 prompts, coding and not.

On the coding tasks Jeffort used about half the output tokens of xhigh, and every task passed. Every task also passed at low, so those tasks cannot show a quality loss from lower effort. One sample per cell.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

## Layout

- `hooks/register.tsx`: the hooks module (scoring, band, pane)
- `hooks/policy.ts`: Jev questions, level mapping, themes, savings maths (no engine calls)
- `types/index.d.ts`: state contract
- `tests/`: `claude plugin test` suite
- `docs/ui-options.html`: the UI options explored

## License

MIT
