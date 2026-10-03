#!/usr/bin/env python3
"""Effort benchmark: each prompt at fixed effort levels, plus xhigh with auto-effort loaded.

Every run is a fresh `claude -p` session on Opus 5.5 with no tools, so runs are comparable.
Results append to results.jsonl; finished (prompt, condition) pairs are skipped on re-run.
"""
import glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'results.jsonl')
MODEL = 'claude-opus-5-5'

# (id, difficulty, prompt, regex the correct answer must match)
PROMPTS = [
    ('capital', 'easy', 'What is the capital of Australia? One word.', r'canberra'),
    ('len_set', 'easy', 'In Python, what does len({1,2,2,3}) return? Just the number.', r'^\W*3\W*$'),
    ('mult', 'easy', 'What is 17*23? Just the number.', r'391'),
    ('reverse', 'easy', 'Write a Python one-liner that reverses a string s. Only the code.', r'\[::-1\]|reversed'),
    ('batball', 'medium', 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost? Just the number.', r'^\W*5(\.0+)?\W*$'),
    ('avg_bug', 'medium', 'def avg(xs): return sum(xs)/len(xs)  -- which input makes this crash? One short sentence.', r'empty|\[\]|zero|len.*0'),
    ('sevens', 'medium', 'How many times does the digit 7 appear when writing every integer from 1 to 100 inclusive? Just the number.', r'^\W*20\W*$'),
    ('boxes', 'hard', 'Three boxes are labelled apples, oranges, and mixed, and every label is wrong. You may draw one fruit from one box. Which box do you draw from? One sentence.', r'mixed'),
    ('factorial', 'hard', 'What is the smallest positive integer n such that n! is divisible by 1000? Just the number.', r'^\W*15\W*$'),
    ('knight', 'hard', 'A knight starts on a1 of a standard chessboard. What is the minimum number of moves to reach h8? Just the number.', r'^\W*6\W*$'),
]
CONDITIONS = ['low', 'medium', 'high', 'xhigh', 'auto']


def done():
    if not os.path.exists(OUT):
        return set()
    return {(r['id'], r['condition']) for r in map(json.loads, open(OUT))}


def run(pid, diff, prompt, pattern, cond):
    effort = 'xhigh' if cond == 'auto' else cond
    cmd = ['claude', '-p', prompt, '--model', MODEL, '--effort', effort, '--tools', '',
           '--output-format', 'json']
    if cond == 'auto':
        cmd += ['--plugin-dir', PLUGIN]
    proc = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                          cwd='/private/tmp/ae-bench')
    events = json.loads(proc.stdout)
    res = next(e for e in events if e.get('type') == 'result')
    u = res['usage']
    applied = effort
    if cond == 'auto':
        path = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{res['session_id']}.jsonl"))
        efforts = [json.loads(l).get('effort') for l in open(path[0])] if path else []
        applied = next((e for e in efforts if e), 'unknown')
    answer = (res.get('result') or '').strip()
    return {
        'id': pid, 'difficulty': diff, 'condition': cond, 'applied_effort': applied,
        'output_tokens': u['output_tokens'],
        'thinking_tokens': (u.get('output_tokens_details') or {}).get('thinking_tokens', 0),
        'duration_ms': res.get('duration_ms'), 'cost_usd': res.get('total_cost_usd'),
        'correct': bool(re.search(pattern, answer, re.I | re.S)), 'answer': answer[:300],
    }


if __name__ == '__main__':
    os.makedirs('/private/tmp/ae-bench', exist_ok=True)
    finished = done()
    only = sys.argv[1:]  # optional prompt ids, for a smoke test
    for pid, diff, prompt, pattern in PROMPTS:
        if only and pid not in only:
            continue
        for cond in CONDITIONS:
            if (pid, cond) in finished:
                continue
            try:
                row = run(pid, diff, prompt, pattern, cond)
            except Exception as err:  # keep going; a failed cell is reported, not hidden
                row = {'id': pid, 'condition': cond, 'error': str(err)[:200]}
            with open(OUT, 'a') as f:
                f.write(json.dumps(row) + '\n')
            print(row, flush=True)
