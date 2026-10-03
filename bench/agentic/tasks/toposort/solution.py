def toposort(graph):
    """Order the nodes of a dependency graph so every node comes after its dependencies.

    `graph` maps a node to an iterable of the nodes it depends on. Nodes that appear only as
    dependencies are part of the graph too. When several nodes are ready, pick the smallest one
    (ordinary `<` comparison), so the result is deterministic. Raise ValueError whose message
    contains "cycle" if the graph has a cycle, including a node that depends on itself.
    """
    raise NotImplementedError
