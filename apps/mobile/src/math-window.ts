// Which drawn equations in a session hold a picture view (docs/specs/mobile-session-open.md).
// Every equation's box is sized from its drawing up front, so a picture coming or going never
// moves anything. Blocks of text and math on or near the screen mount their pictures, and so
// do those near the start and the end of the transcript (where a status-bar tap and "Scroll to
// end" land). Blocks far from all three free theirs, so memory stays bounded however long the
// session is. Each react-native-svg view draws into its own bitmap on Android.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { HostInstance } from "react-native";

/** Blocks within this many screens of the visible part, the start or the end mount their pictures. */
const MOUNT_MARGIN = 1;
/** Blocks further than this many screens from all three free theirs... */
const FREE_MARGIN = 2;
/** ...once they have been that far for this long, so a scroll position and block positions
 * that arrive a frame apart never free what is on screen. */
const FREE_AFTER_MS = 500;
/** At most this many pictures off screen mount in one frame, so no commit is long. */
const PICTURES_PER_FRAME = 24;

interface Block {
  batch: string;
  y: number;
  height: number;
  measured: boolean;
  pictures: number;
  wanted: boolean;
  committed: boolean;
  farSince: number | undefined;
  setLive: (live: boolean) => void;
  measure: () => void;
}

export class MathWindow {
  private offset = 0;
  private viewport = 0;
  private content = 0;
  private readonly batches = new Map<string, { y: number; height: number }>();
  private readonly blocks = new Set<Block>();
  private frame: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  livePictures = 0;

  setView(offset: number, viewport: number, content = this.content) {
    if (offset === this.offset && viewport === this.viewport && content === this.content) return;
    [this.offset, this.viewport, this.content] = [offset, viewport, content];
    this.schedule();
  }

  /** Where a batch of messages sits in the transcript, or undefined while it isn't placed. */
  setBatch(id: string, place: { y: number; height: number } | undefined) {
    const before = this.batches.get(id);
    if (place) this.batches.set(id, place);
    else this.batches.delete(id);
    // A batch whose height changed may have moved the blocks inside it.
    if (place && before && before.height !== place.height) for (const block of this.blocks) if (block.batch === id) block.measure();
    this.schedule();
  }

  add(block: Block) {
    this.blocks.add(block);
    this.schedule();
  }

  remove(block: Block) {
    this.blocks.delete(block);
    if (block.committed) this.livePictures -= block.pictures;
    this.schedule();
  }

  committed(block: Block, live: boolean) {
    if (block.committed === live) return;
    block.committed = live;
    this.livePictures += live ? block.pictures : -block.pictures;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  schedule() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = undefined;
      this.update();
    });
  }

  private place(block: Block): { top: number; bottom: number } | undefined {
    const batch = this.batches.get(block.batch);
    if (!batch || !block.measured) return;
    return { top: batch.y + block.y, bottom: batch.y + block.y + block.height };
  }

  /** Blocks on screen whose pictures aren't in yet, or whose place isn't known yet. */
  pendingOnScreen(): number {
    let pending = 0;
    const [top, bottom] = [this.offset, this.offset + this.viewport];
    for (const block of this.blocks) {
      if (block.committed) continue;
      const place = this.place(block);
      const batch = this.batches.get(block.batch);
      if (place ? place.bottom > top && place.top < bottom : !!batch && batch.y + batch.height > top && batch.y < bottom) pending++;
    }
    return pending;
  }

  /** How far a block is from the screen, and from whichever is nearest of the screen, the
   * start and the end. */
  private distances({ top, bottom }: { top: number; bottom: number }) {
    const from = (start: number, end: number) => bottom < start ? start - bottom : top > end ? top - end : 0;
    const view = from(this.offset, this.offset + this.viewport);
    return { view, keep: Math.min(view, from(0, this.viewport), from(Math.max(0, this.content - this.viewport), this.content)) };
  }

  /** Mounts what is near, nearest first, and frees what has been far for a while. */
  update() {
    if (!this.viewport) return;
    const now = performance.now();
    const near: { block: Block; distance: number }[] = [];
    let recheck = false;
    for (const block of this.blocks) {
      const place = this.place(block);
      if (!place) continue;
      const { view, keep } = this.distances(place);
      if (keep <= FREE_MARGIN * this.viewport) block.farSince = undefined;
      if (block.wanted && keep > FREE_MARGIN * this.viewport) {
        block.farSince ??= now;
        if (now - block.farSince >= FREE_AFTER_MS) {
          block.wanted = false;
          block.farSince = undefined;
          block.setLive(false);
        } else recheck = true;
      } else if (!block.wanted && keep <= MOUNT_MARGIN * this.viewport) {
        near.push({ block, distance: view });
      }
    }
    near.sort((one, two) => one.distance - two.distance);
    let budget = PICTURES_PER_FRAME;
    for (const { block, distance } of near) {
      // What is on screen mounts at once; the rest a few at a time.
      if (distance > 0 && budget <= 0) {
        this.schedule();
        break;
      }
      if (distance > 0) budget -= block.pictures;
      block.wanted = true;
      block.setLive(true);
    }
    if (recheck && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, FREE_AFTER_MS);
    }
  }
}

export const MathWindowContext = createContext<MathWindow | null>(null);

/** A batch of messages: the view its blocks place themselves in, and whether blocks show
 * their pictures from their first frame. Blocks that mount with their batch while the session
 * opens or fills in start without, and wait for the window; blocks that mount later (a new
 * message, an opened row) and every block of a small session start with them. */
export interface BatchScope {
  id: string;
  ref: RefObject<HostInstance | null>;
  eager: RefObject<boolean>;
}
export const BatchContext = createContext<BatchScope | null>(null);

/** Whether a block holding `pictures` drawn equations shows them now. Outside a session's
 * transcript (the question dock, the plan) pictures always show. `ref` and `onLayout` go on
 * the block's own view. */
export function useLivePictures(pictures: number) {
  const window = useContext(MathWindowContext);
  const batch = useContext(BatchContext);
  const lazy = !!window && !!batch && pictures > 0;
  const [live, setLive] = useState(() => !lazy || !!batch?.eager.current);
  const ref = useRef<HostInstance | null>(null);
  const block = useRef<Block | null>(null);
  const startedLive = useRef(live);

  useEffect(() => {
    if (!lazy || !window || !batch) return;
    const entry: Block = {
      batch: batch.id, y: 0, height: 0, measured: false, pictures, wanted: startedLive.current, committed: false, farSince: undefined, setLive,
      measure: () => {
        const node = ref.current;
        const parent = batch.ref.current;
        if (!node || !parent) return;
        node.measureLayout(parent, (_x, y, _width, height) => {
          entry.y = y;
          entry.height = height;
          entry.measured = true;
          window.schedule();
        }, () => {});
      },
    };
    block.current = entry;
    window.add(entry);
    entry.measure();
    return () => {
      window.remove(entry);
      block.current = null;
    };
  }, [lazy, window, batch, pictures]);

  useLayoutEffect(() => {
    if (block.current && window) window.committed(block.current, live);
  }, [live, window]);

  // The first commit runs before the block is registered, so record a live start once it is.
  useEffect(() => {
    if (block.current && window && live) window.committed(block.current, true);
  }, [window, live]);

  const onLayout = lazy ? () => block.current?.measure() : undefined;
  return { live: !lazy || live, ref, onLayout };
}
