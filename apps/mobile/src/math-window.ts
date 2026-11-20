// Which drawn equations in a session hold a picture view (docs/specs/mobile-session-open.md).
// Every equation's box is sized from its drawing up front, so a picture coming or going never
// moves anything. Blocks of text and math on or near the screen mount their pictures, and so
// do those near the start and the end of the transcript (where a status-bar tap and "Scroll to
// end" land), and further ahead while a fling carries the screen toward them. Blocks far from
// all three free theirs, so memory stays bounded however long the session is. Each
// react-native-svg view draws into its own bitmap on Android.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { HostInstance } from "react-native";

/** Blocks within this many screens of the visible part, the start or the end mount their pictures. */
const MOUNT_MARGIN = 2;
/** Blocks further than this many screens from all three free theirs... */
const FREE_MARGIN = 3;
/** ...once they have been that far for this long, so a scroll position and block positions
 * that arrive a frame apart never free what is on screen. */
const FREE_AFTER_MS = 250;
/** While the screen moves, blocks the scroll reaches within this long mount too. */
const LOOKAHEAD_MS = 600;
/** ...but never more than this many screens ahead, so a hard fling can't mount everything. */
const MAX_AHEAD = 2;
/** Scroll events further apart than this mean the screen had stopped. */
const MOVING_GAP_MS = 200;
/** At most this many pictures off screen mount in one frame, so no commit is long. */
const PICTURES_PER_FRAME = 48;

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
  /** Batches being measured out of sight, whose blocks are never on screen. */
  private readonly measuring = new Set<string>();
  private readonly blocks = new Set<Block>();
  private frame: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  /** How fast the screen moves through the content, in points per millisecond. */
  private velocity = 0;
  private movedAt = 0;
  private lastMoved = 0;
  private still: ReturnType<typeof setTimeout> | undefined;
  /** While held nothing mounts or frees: the scroll position isn't the one that will show. */
  private held = false;
  livePictures = 0;
  /** Once the session shows, blocks on the transcript's first screen mount at once too, so a
   * status-bar tap never lands on empty boxes. */
  private startImmediate = false;

  setStartImmediate(value: boolean) {
    this.startImmediate = value;
  }

  setHold(held: boolean) {
    if (held === this.held) return;
    this.held = held;
    if (!held) this.schedule();
  }

  setView(offset: number, viewport: number, content = this.content) {
    if (offset === this.offset && viewport === this.viewport && content === this.content) return;
    [this.offset, this.viewport, this.content] = [offset, viewport, content];
    this.schedule();
  }

  /** A scroll (not a layout's jump, as when content is placed above) has the screen at
   * `offset`, moving at `velocity` points per millisecond when the platform measured it (Android
   * does, on its UI thread, so a busy JS thread doesn't skew it): how fast it moves says how
   * far ahead to mount. */
  moved(offset: number, velocity?: number) {
    const now = performance.now();
    const elapsed = now - this.movedAt;
    const speed = velocity !== undefined && Number.isFinite(velocity) ? velocity
      : elapsed >= 4 && elapsed < MOVING_GAP_MS ? (offset - this.lastMoved) / elapsed : 0;
    this.velocity = this.velocity * 0.5 + speed * 0.5;
    [this.movedAt, this.lastMoved] = [now, offset];
    this.schedule();
    // No further scroll event comes once the screen stops, so look again then: the velocity
    // expires, and what was mounted ahead starts its way to being freed.
    if (this.still !== undefined) clearTimeout(this.still);
    this.still = setTimeout(() => {
      this.still = undefined;
      this.schedule();
    }, MOVING_GAP_MS + 10);
  }

  /** Whether a batch is being measured out of sight. */
  setMeasuring(id: string, measuring: boolean) {
    if (measuring) this.measuring.add(id);
    else this.measuring.delete(id);
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
    this.notify();
  }

  /** A block learned where it sits in its batch. */
  measured() {
    this.schedule();
    this.notify();
  }

  /** Whether every block in a batch knows where it sits in it. */
  measuredAll(id: string): boolean {
    for (const block of this.blocks) if (block.batch === id && !block.measured) return false;
    return true;
  }

  /** Mounts every picture of a batch now, whatever the budget: a batch placed above is drawn
   * whole before anything can scroll into it. */
  mountBatch(id: string) {
    for (const block of this.blocks) {
      if (block.batch !== id || block.wanted) continue;
      block.wanted = true;
      block.farSince = undefined;
      block.setLive(true);
    }
  }

  /** Asks a batch's blocks that don't know where they sit to measure again. */
  measureBatch(id: string) {
    for (const block of [...this.blocks]) if (block.batch === id && !block.measured) block.measure();
  }

  private notify() {
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

  /** Blocks that may be on screen without their pictures: on screen and not drawn yet, or
   * not placed yet (their batch's layout or their own hasn't arrived) unless their batch is
   * being measured out of sight. */
  pendingOnScreen(): number {
    let pending = 0;
    const [top, bottom] = [this.offset, this.offset + this.viewport];
    for (const block of this.blocks) {
      if (block.committed || this.measuring.has(block.batch)) continue;
      const place = this.place(block);
      if (!place || (place.bottom > top && place.top < bottom)) pending++;
    }
    return pending;
  }

  /** How far a block is from the screen, and from whichever is nearest of the screen, the
   * start and the end. */
  private distances({ top, bottom }: { top: number; bottom: number }, ahead: number) {
    const from = (start: number, end: number) => bottom < start ? start - bottom : top > end ? top - end : 0;
    const view = from(this.offset, this.offset + this.viewport);
    // A block the screen is moving toward counts as nearer by how far the scroll carries it.
    const coming = (this.velocity < 0 && bottom <= this.offset) || (this.velocity > 0 && top >= this.offset + this.viewport);
    const near = coming ? Math.max(0, view - ahead) : view;
    const start = from(0, this.viewport);
    return { view, near, start, keep: Math.min(near, start, from(Math.max(0, this.content - this.viewport), this.content)) };
  }

  /** Mounts what is near, nearest first, and frees what has been far for a while. */
  update() {
    if (!this.viewport || this.held) return;
    const now = performance.now();
    // A scroll that has stopped carries nothing further.
    if (now - this.movedAt > MOVING_GAP_MS) this.velocity = 0;
    const ahead = Math.min(Math.abs(this.velocity) * LOOKAHEAD_MS, MAX_AHEAD * this.viewport);
    const near: { block: Block; distance: number }[] = [];
    let recheck = false;
    for (const block of this.blocks) {
      const place = this.place(block);
      if (!place) continue;
      const { view, start, keep } = this.distances(place, ahead);
      if (keep <= FREE_MARGIN * this.viewport) block.farSince = undefined;
      if (block.wanted && keep > FREE_MARGIN * this.viewport) {
        block.farSince ??= now;
        if (now - block.farSince >= FREE_AFTER_MS) {
          block.wanted = false;
          block.farSince = undefined;
          block.setLive(false);
        } else recheck = true;
      } else if (!block.wanted && keep <= MOUNT_MARGIN * this.viewport) {
        // Nearest to the screen first, whatever carried it within reach.
        near.push({ block, distance: (this.startImmediate && start === 0) || view === 0 ? 0 : view });
      }
    }
    near.sort((one, two) => one.distance - two.distance);
    let budget = PICTURES_PER_FRAME;
    for (const { block, distance } of near) {
      // What is on screen (or on the first screen) mounts at once; the rest a few at a time.
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
          window.measured();
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
