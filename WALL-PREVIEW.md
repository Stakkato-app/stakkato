# The wall: a preview, not a pull request (yet)

This branch (`claude/wall-preview`) is a **preview** of a new way to show jams. Posting works as on the live site: takes, comments and replies go into the real database. It is never meant to be merged as it is. Once the design is agreed, it becomes two pull requests from `main` (see the end).

**Preview:** https://claude-wall-preview.stakkato.pages.dev/?wall (everything new only shows with `?wall` in the URL; without it you get today's site).

**Two directions to compare:**
- https://claude-wall-preview.stakkato.pages.dev/?wall builds everything up from the bottom. In the wall, the original track is the bottom tile. In the project view, the original track is the bottom track, what was played on it sits above, and "Your take" sits on top, under the ruler.
- https://claude-wall-preview.stakkato.pages.dev/?wall&flip runs everything top-down. The original track is the top tile and the top track, and every take hangs under what it was played on, like today's project view.

In the bottom-up version, the tracks are as tall as the stack. "Your take" stays under the ruler, and the original track moves with the number of takes. When you switch stacks from the wall, the page scrolls along by as much as the tracks grew or shrank, so the wall stays where you clicked. The top-down version keeps the height of the biggest stack. Jurgen's pick: bottom-up. Still to confirm with Yarne.

## What it shows

- **Homepage as a grid of jam cards** (after Yarne's "A1 · Grid, play on hover"). A switch picks what a card plays: *Original track* or *Latest stack*. There's also play on hover.
- **"Play along" opens the jam in a panel** over the blurred page (close it with the X). Inside is **the wall**:
  - Every take is a tile, sitting on the tile it was played on, from the original track at the bottom upward. Each part has "Builds up from here ↑" under its bottom tile.
  - New parts are their own section next to it, with a time head above each part ("0:00 —— Part 1 · the original track —— 0:11", "0:11 —— Part 2 · picks up where it ends —— 0:22").
  - On a tile: ▶ plays the stack up to it, S solos it (click the waveform while soloing to seek), + plays on top of it, 💬 comments on it.
  - Hovering a + (desktop) shows a see-through "Your take on …" right on that take; what was already played on it moves to the left half, the way the column splits once you play. S while the master plays takes over from that moment, and S again hands back to the master.
- **The master track** under the wall plays the selected stack: click to seek, with a playhead. It has "Open this stack in project view". On a new part, "▶ Play the whole song from the start" plays the first part's stack and then the part.
- **"Talk about this song"** shows the comments, each with what it is about; a comment chip jumps to its take.
- **Project view with `?wall`:**
  - The wall sits under the tracks instead of the thread; picking a tile switches the tracks to that stack.
  - "How it works" is folded and describes stacks.
- **Phones:**
  - One part per page, with swipe and dots.
  - The master track stays in view at the bottom of the panel.
  - On the homepage, the first screen is only the pitch card, with the three steps in a few words.
  - In the project:
    - the tracks come first;
    - a one-line "Stack: up to …" above them;
    - "+ Add your instrument" first on the grey track;
    - the + for a new part sits beside the tracks.

- **Wanted** (next to "Talk about this song"): a musician asks for one instrument on their own take, with an optional word about it ("Jurgen wants drums on his bass"). The jam's creator can ask on the original track, and every replier on their own takes. Clicking an ask plays the stack it goes on, shows the word about it, and offers "Play drums on this". That opens the grey track in project view on that stack, with the instrument picked. The one who asked can mark it as answered. In the preview, asks are kept in your browser only, and each jam shows up to two examples (marked "example") on the tops of its stacks. For real it needs a small table (take, asker, instrument, note, answered by). The homepage stays as it is for now.

## Decisions made while building it (Jurgen)

- Links to the project say **"Open this stack in project view"** (on a stack or a take) and **"Open in project view"** (on a jam).
- Tiles are neutral, with the take's waveform in its instrument colour. A selected stack is outlined; there are no filled tiles.
- The comments bar only shows once the jam is open, with its button on the right.
- On phones: no "Became songs" tab. Tiles keep their waveforms and hide + and 💬.

## What is preview-only on purpose (leave it out of the pull requests)

- **Posting:** the wall's + opens the live site's reply pop-up (record or upload) on that take. Comments post with `addThreadComment`. In the project view, + opens the grey track on that stack. (Until 22 October the preview was read-only.)
- **Data fixes by title in `src/home.js`:**
  - "Kilian's krentenbolleke" and the Jurgocals track are restacked in band order;
  - the new part before the original track in "drum regeton" is left out.

  These belong in the database instead: `supabase/wall-preview/3b_apply_data_fixes.sql`.
- **The project view embeds the homepage's wall in an iframe** (`/?wall&embed=<session id>`, `wallFrame()` in `src/app.js`, talking through `postMessage`). The real version builds the wall into the page.
- **CSS written as strings in JavaScript** (`home.js`, and the `WALLP` block in `app.js`). It belongs in the stylesheets.

## The database (Yarne)

The live site still says "database needs update" when someone stacks on a new part, because two migrations aren't applied yet. Paste these in the Supabase SQL editor of project Stakkato. Use the editor, not the MCP tools: they contain `DROP` statements.

1. `supabase/wall-preview/1_check.sql`: read-only. It lists what's there and names any missing migration.
2. The two migrations, each on its own:
   - `supabase/migrations/20261018230000_carry_into_parts.sql`
   - `supabase/migrations/20261019230000_parts_as_replies.sql`

   Then run step 1 again: every row should say `ok`.
3. Optional, the three jam fixes:
   1. Run `3a_preview_data_fixes.sql` first. It is read-only and lists what would change.
   2. Then run `3b_apply_data_fixes.sql`.

   Every changed row is backed up in `public.wall_fix_backup`, and the undo statement is at the end of the file. Nothing is really deleted: the drum regeton part gets status `deleted`.

The scripts were tried on a local Postgres with a stand-in for the tables, not on the live data.

## The plan: two pull requests, once the design is agreed

1. **Homepage:**
   - the grid, the panel with the wall, the master track and the comments, with writes on (+, 💬 and posting use the existing reply and comment flows);
   - no `?wall` flag; CSS in the stylesheets;
   - the wall as a shared module, so the project can use it too.
2. **Project view:**
   - the wall built in under the tracks, replacing the iframe;
   - the phone layout (tracks first, "Stack" line, "Add your instrument", + beside the tracks) and the new "How it works".

Both need steps 1 and 2 above applied first. Update CLAUDE.md (layout, vocabulary, testing checklist) in the same pull requests.
