#!/usr/bin/env python3
"""Agentic coding benchmark: fix or implement code until the tests pass, at fixed effort or auto.

Each (task, condition) is one fresh `claude -p` session on Opus 5.5 with file and shell tools, run
in a throwaway copy of the task. After the run the original tests are restored and executed, so
editing the tests cannot count as a pass. Usage is summed per API response from the session
transcript. Results append to results.jsonl; finished pairs are skipped, so a run can resume.

  python3 run.py                     every task, every condition
  python3 run.py paginate lru        only these tasks
  CONDITIONS=xhigh,auto python3 run.py
"""
import glob, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(os.path.dirname(HERE))
TASKS = os.path.join(HERE, 'tasks')
OUT = os.path.join(HERE, 'results.jsonl')
WORK = '/private/tmp/ae-agentic'
MODEL = 'claude-opus-5-5'
CONDITIONS = os.environ.get('CONDITIONS', 'xhigh,high,low,auto').split(',')
# Each task has its own prompt.txt, written the way a user would ask, because auto-effort only
# sees the prompt text. This suffix is common to all of them.
SUFFIX = (' Do not modify test_solution.py, check with `python3 -m unittest -q`, and work only '
          'inside the current directory.')
# USD per million tokens, Opus 5.5: input, output, cache read, one-hour cache write
PRICE = {'input': 4, 'output': 20, 'read': 0.2, 'write': 8}


def done():
    if not os.path.exists(OUT):
        return set()
    return {(r['task'], r['condition']) for r in map(json.loads, open(OUT)) if 'error' not in r}


def transcript_usage(session_id):
    path = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{session_id}.jsonl'))
    total = dict(input=0, output=0, read=0, write=0, steps=0)
    efforts = []
    if not path:
        return total, efforts
    seen = set()
    for line in open(path[0]):
        try:
            x = json.loads(line)
        except ValueError:
            continue
        m = x.get('message') or {}
        if x.get('type') != 'assistant' or not m.get('usage') or m.get('id') in seen:
            continue
        seen.add(m.get('id'))
        u = m['usage']
        total['input'] += u.get('input_tokens', 0)
        total['output'] += u.get('output_tokens', 0)
        total['read'] += u.get('cache_read_input_tokens', 0)
        total['write'] += u.get('cache_creation_input_tokens', 0)
        total['steps'] += 1
        if x.get('effort'):
            efforts.append(x['effort'])
    return total, efforts


def run(task, cond):
    effort = 'xhigh' if cond == 'auto' else cond
    d = os.path.join(WORK, f'{task}-{cond}')
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(os.path.join(TASKS, task), d)
    prompt = open(os.path.join(TASKS, task, 'prompt.txt')).read().strip() + SUFFIX
    cmd = ['claude', '-p', prompt, '--model', MODEL, '--effort', effort, '--output-format', 'json',
           '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep']
    if cond == 'auto':
        cmd += ['--plugin-dir', PLUGIN]
    proc = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL, cwd=d, timeout=1500)
    res = next(e for e in json.loads(proc.stdout) if e.get('type') == 'result')
    shutil.copy(os.path.join(TASKS, task, 'test_solution.py'), os.path.join(d, 'test_solution.py'))
    graded = subprocess.run([sys.executable, '-m', 'unittest', '-q'], cwd=d, capture_output=True, text=True)
    t, efforts = transcript_usage(res['session_id'])
    est = sum(t[k] * PRICE[k] for k in ('input', 'output', 'read', 'write')) / 1e6
    return {
        'task': task, 'condition': cond, 'passed': graded.returncode == 0,
        'efforts': sorted(set(efforts)), 'steps': t['steps'], 'output_tokens': t['output'],
        'thinking_tokens': (res['usage'].get('output_tokens_details') or {}).get('thinking_tokens'),
        'cache_read': t['read'], 'cache_write': t['write'], 'input_tokens': t['input'],
        'est_usd': round(est, 4), 'duration_ms': res.get('duration_ms'),
        'num_turns': res.get('num_turns'), 'result_output_tokens': res['usage'].get('output_tokens'),
    }


if __name__ == '__main__':
    os.makedirs(WORK, exist_ok=True)
    only = sys.argv[1:]
    finished = done()
    for task in sorted(os.listdir(TASKS)):
        if only and task not in only:
            continue
        for cond in CONDITIONS:
            if (task, cond) in finished:
                continue
            try:
                row = run(task, cond)
            except Exception as err:
                row = {'task': task, 'condition': cond, 'error': str(err)[:300]}
            with open(OUT, 'a') as f:
                f.write(json.dumps(row) + '\n')
            print(row, flush=True)
