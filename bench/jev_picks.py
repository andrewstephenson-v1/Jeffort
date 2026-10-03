#!/usr/bin/env python3
"""What effort does auto-effort pick for each prompt? One cheap no-tools run per prompt.

Reads the level the mod applied from the session transcript. Writes picks.jsonl.
"""
import glob, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import run as qa  # short Q&A prompts from the first benchmark

AGENTIC = os.path.join(HERE, 'agentic', 'tasks')
NON_CODING = [
    ('translate', 'low', "Translate 'good morning' into French."),
    ('formal', 'low', "Rewrite this sentence to be more formal: 'hey, can u send me the report asap?'"),
    ('romeo', 'low', 'Summarise the plot of Romeo and Juliet in three sentences.'),
    ('lisbon', 'medium', 'Plan a 3-day itinerary for Lisbon for a couple who like food and walking.'),
    ('deposit', 'high', "My landlord is keeping my 1,200 pound deposit and says it's for 'general wear'. What are my options in England?"),
    ('rent_buy', 'high', "Compare renting versus buying a home for me: I'm 34, earn 70k, have 40k saved, and might move cities in 3 years. Walk through the trade-offs."),
    ('clause', 'xhigh', 'Draft a clause for a freelance contract that caps my liability and survives termination, under English law.'),
    ('reorg', 'xhigh', 'I need to decide whether to restructure a 40-person team around products instead of functions while we are mid-launch. Help me think through the second-order effects.'),
]

prompts = [(pid, diff, text) for pid, diff, text, _ in qa.PROMPTS]
for task in sorted(os.listdir(AGENTIC)):
    prompts.append((task, 'agentic', open(os.path.join(AGENTIC, task, 'prompt.txt')).read().strip()))
prompts += [(pid, 'noncoding:' + want, text) for pid, want, text in NON_CODING]

out = os.path.join(HERE, 'picks.jsonl')
os.makedirs('/private/tmp/ae-picks', exist_ok=True)
for pid, label, text in prompts:
    proc = subprocess.run(['claude', '-p', text, '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--tools', '',
                           '--plugin-dir', PLUGIN, '--output-format', 'json'],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL, cwd='/private/tmp/ae-picks')
    sid = next(e for e in json.loads(proc.stdout) if e.get('type') == 'result')['session_id']
    path = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}.jsonl'))
    efforts = [json.loads(l).get('effort') for l in open(path[0])] if path else []
    pick = next((e for e in efforts if e), 'unknown')
    row = {'id': pid, 'label': label, 'pick': pick}
    open(out, 'a').write(json.dumps(row) + '\n')
    print(f'{pid:16s} {label:18s} -> {pick}', flush=True)
