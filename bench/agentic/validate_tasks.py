#!/usr/bin/env python3
"""Check every task: tests fail on the shipped solution.py and pass with the reference one."""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ok = True
for task in sorted(os.listdir(os.path.join(HERE, 'tasks'))):
    for label, src in (('shipped', None), ('reference', os.path.join(HERE, 'reference', task + '.py'))):
        with tempfile.TemporaryDirectory() as d:
            shutil.copytree(os.path.join(HERE, 'tasks', task), d, dirs_exist_ok=True)
            if src:
                shutil.copy(src, os.path.join(d, 'solution.py'))
            r = subprocess.run([sys.executable, '-m', 'unittest', '-q'], cwd=d, capture_output=True, text=True)
        passed = r.returncode == 0
        expected = label == 'reference'
        flag = 'ok' if passed == expected else 'PROBLEM'
        ok &= passed == expected
        print(f'{task:15s} {label:9s} tests {"pass" if passed else "fail"}  {flag}')
        if flag == 'PROBLEM':
            print(r.stderr[-600:])
sys.exit(0 if ok else 1)
