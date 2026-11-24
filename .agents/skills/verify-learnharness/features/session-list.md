# Session list

## Sub-features

- The sidebar lists sessions by last activity, with search, a Teaching / Practice / All filter, and folders.
- Right-click a session row for its menu: rename, move, delete (`ctx-delete`, then a confirm).
- Deleting removes the row, closes the open transcript, and removes `data/chats/<id>.json`.

## How to get to it (user POV)

The sidebar on any signed-in page.

## Driving it with e2e

Arrange sessions through the composer (teaching-session.md) and drive the row with `getByTestId("session-row")` filtered by its goal text; the menu opens on right-click.

## Proof

After a delete: no row, `GET /api/chats/<id>` answers 404, and no file in the data folder. After a turn on an older session, it moves to the top.

## Charters

```
sessions-order|web|skeptic|Signed in (--session learner), create three sessions with zz-e2e goals, then send a message in the oldest; report a list order, count or label that disagrees with what you did
sessions-delete|web|default|Signed in (--session learner), delete the session you are viewing, then one in a folder; report a transcript still shown, a stale row, or a back button that reopens a deleted session
```

## Gotchas

- Rows render before they are interactive: wait for the row, then right-click.
