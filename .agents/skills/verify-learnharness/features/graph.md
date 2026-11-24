# Knowledge graph and notes import

## Sub-features

- The home page (`/`) shows the knowledge graph, "Start a session to begin learning." when empty, Chains, and "Extract files…".
- Extract files imports notes into the graph.

## How to get to it (user POV)

The Home link in the sidebar, or `/`.

## Driving it with e2e

Landmarks: the text "Knowledge graph", `open-chain-table`, `import-notes`, and the home textbox "What do you want to learn?".

## Proof

An imported note shows in the graph and under `data/graph/` in the instance's data folder.

## Charters

```
graph-empty|web|default|Signed in (--session learner), starting at /, open Chains and Extract files with an empty graph; report anything broken, confusing or inconsistent
```

## Gotchas

- Extract files on a real document needs a model that reads it; the fake model does not.
