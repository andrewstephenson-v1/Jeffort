#!/usr/bin/env python3
import collections, json, os

rows = [json.loads(l) for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results.jsonl'))]
errs = [r for r in rows if 'error' in r]
rows = [r for r in rows if 'error' not in r]
conds = [c for c in ('low', 'high', 'xhigh', 'auto') if any(r['condition'] == c for r in rows)]
tasks = sorted({r['task'] for r in rows})
print('errors:', len(errs), [e['task'] + '/' + e['condition'] for e in errs])
print(f"{'task':16s}" + ''.join(f'{c:>26s}' for c in conds))
agg = collections.defaultdict(lambda: collections.Counter())
for t in tasks:
    line = f'{t:16s}'
    for c in conds:
        r = next((r for r in rows if r['task'] == t and r['condition'] == c), None)
        if not r:
            line += f"{'-':>26s}"
            continue
        tag = f"{r['output_tokens']}t ${r['est_usd']:.2f} {r['steps']}st {'ok' if r['passed'] else 'FAIL'}"
        if c == 'auto':
            tag += '/' + ','.join(r['efforts'])
        line += f'{tag:>26s}'
        a = agg[c]
        a['out'] += r['output_tokens']; a['usd'] += r['est_usd']; a['steps'] += r['steps']
        a['outusd'] += r['output_tokens'] * 20 / 1e6; a['pass'] += r['passed']; a['n'] += 1; a['ms'] += r['duration_ms'] or 0
    print(line)
print()
for c in conds:
    a = agg[c]
    print(f"{c:6s} n={a['n']} pass={a['pass']} out_tokens={a['out']} output_usd=${a['outusd']:.3f} total_est_usd=${a['usd']:.2f} (incl. cache builds) steps={a['steps']} time={a['ms']/1000:.0f}s")
