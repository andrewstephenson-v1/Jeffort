import re

_TOKEN = re.compile(r'\s*(?:(\d+\.?\d*|\.\d+)|(.))')


def evaluate(text):
    tokens = []
    for m in _TOKEN.finditer(text):
        if m.group(1) is not None:
            tokens.append(('n', float(m.group(1)) if '.' in m.group(1) else int(m.group(1))))
        elif m.group(2) is not None and not m.group(2).isspace():
            tokens.append(('o', m.group(2)))
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else (None, None)

    def eat():
        nonlocal pos
        pos += 1
        return tokens[pos - 1]

    def expr():
        v = term()
        while peek() in (('o', '+'), ('o', '-')):
            op = eat()[1]
            r = term()
            v = v + r if op == '+' else v - r
        return v

    def term():
        v = unary()
        while peek() in (('o', '*'), ('o', '/')):
            op = eat()[1]
            r = unary()
            v = v * r if op == '*' else v / r
        return v

    def unary():
        if peek() == ('o', '-'):
            eat()
            return -unary()
        return atom()

    def atom():
        kind, val = peek()
        if kind == 'n':
            eat()
            return val
        if (kind, val) == ('o', '('):
            eat()
            v = expr()
            if peek() != ('o', ')'):
                raise ValueError('expected )')
            eat()
            return v
        raise ValueError('unexpected token')

    if not tokens:
        raise ValueError('empty')
    v = expr()
    if pos != len(tokens):
        raise ValueError('trailing input')
    return v
