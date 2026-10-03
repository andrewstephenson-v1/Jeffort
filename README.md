# Jeffort

A Claude Code mod that sets Claude's effort level for each turn. [TypeSafe Jev](https://docs.typesafe.ai) scores your prompt on four narrow questions (reasoning depth, scope, stakes, ambiguity), and Jeffort maps the result onto an effort level. The model is never touched.

A band above the prompt shows the level it picked, an on/off button, and a bar of the estimated output tokens saved this session. Click **Jeffort** for a pane with stats and a theme picker.

## Install

```sh
claude plugin marketplace add andrewstephenson-v1/Jeffort
claude plugin install jeffort@jeffort --scope user
```

The repo is private, so the machine needs git access to it (for example `gh auth login` as `andrewstephenson-v1`). To try a local clone for one session instead: `claude --plugin-dir /path/to/Jeffort`.

Put your TypeSafe key in a `.env` file. Jeffort looks, in order, at process variables, `.env` beside the plugin, then `~/.config/jeffort/.env`. An installed copy runs from Claude Code's plugin cache, so use the last one:

```sh
mkdir -p ~/.config/jeffort
printf 'TYPESAFE_API_KEY=your-key\nTYPESAFE_MODEL=jev-latest\n' > ~/.config/jeffort/.env
```

`TYPESAFE_MODEL` is optional and defaults to `jev-latest`. Prompts are sent to TypeSafe for scoring, with the name of the Claude model that will answer (so Jev can judge how much effort that model needs), and nothing else is.

## Usage

- `/jeffort` toggles it. `/jeffort on`, `off` and `pane` also work.
- `/jeffort reset` clears this session's and this project's totals; `/jeffort reset all` clears every project and the overall total.
- Totals are kept for this session, this project and all projects. A project is the session's project root, keyed by its full path, so two folders with the same name stay separate. A git worktree counts as its own project.
- **Appearance** tab: Default, Signal, Mono, Colour-safe, Retro, or Match terminal.
- Settings (`/config`): the lowest and highest level Jeffort may pick. `max` is off by default.

## When it acts

Jeffort only rewrites effort on Opus 5.5, Sonnet 5.5 and Fable 5.1, with an API key or a Claude subscription. Those are the models where Claude Code keeps the prompt cache across effort changes. Anywhere else (Bedrock, Vertex, a Claude apps gateway, older models) it does nothing. Needs Claude Code 2.1.284 or later.

Measured on Opus 5.5: the first effort change in a conversation rebuilds about 22k tokens of cache, once. Later changes keep it. That one-time cost is subtracted from the savings the band shows. Jeffort spots it as a large cache write on the first request of a turn whose level changed, so it is an estimate too: a compaction on such a turn can look the same.

## What the savings numbers are

Estimates. They assume fixed output-token ratios per effort level (low 0.55, medium 0.75, high 1.0, xhigh 1.7, from the benchmark in `bench/`). Dollar figures cover Opus 5.5 and Sonnet 5.5 only.

## Benchmarks

`bench/` holds two benchmarks, each comparing fixed effort levels against Jeffort on Opus 5.5:

- `bench/run.py`: ten short questions.
- `bench/agentic/run.py`: eight coding tasks with file and shell tools, graded by tests.
- `bench/jev_picks.py`: what Jeffort picks for 26 prompts, coding and not.

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
