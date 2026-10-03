import heapq


def toposort(graph):
    deps = {n: set(d) for n, d in graph.items()}
    for d in list(deps.values()):
        for x in d:
            deps.setdefault(x, set())
    dependents = {n: [] for n in deps}
    for n, d in deps.items():
        for x in d:
            dependents[x].append(n)
    waiting = {n: len(d) for n, d in deps.items()}
    ready = [n for n, c in waiting.items() if c == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        n = heapq.heappop(ready)
        order.append(n)
        for m in dependents[n]:
            waiting[m] -= 1
            if waiting[m] == 0:
                heapq.heappush(ready, m)
    if len(order) != len(deps):
        raise ValueError('graph has a cycle')
    return order
