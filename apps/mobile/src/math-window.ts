// Which drawn equations hold a picture view (docs/specs/mobile-session-open.md, owner
// decision after the first spike). Every equation's box is sized from its drawing up front,
// so a picture coming or going never moves anything. Only blocks of text and math on or
// near the screen mount their pictures, and blocks that scroll far away free them, so
// memory stays bounded however long the session is.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { HostInstance, LayoutChangeEvent } from "react-native";

/** Blocks within this many screens of the visible part mount their pictures. */
const MOUNT_MARGIN = 1;
/** Blocks further than this many screens away free theirs. */
const FREE_MARGIN = 2;
/** At most this many pictures off screen mount in one frame, so no commit is long. */
const PICTURES_PER_FRAME = 24;

interface Block {
  message: string;
  y: number;
  height: number;
  measured: boolean;
  pictures: number;
  /** What the window asked for and what has been committed with pictures. */
  wanted: boolean;
  committed: boolean;
  setLive: (live: boolean) => void;
  measure: () => void;
}

export class MathWindow {
  private offset = 0;
  private viewport = 0;
  private readonly messages = new Map<string, { y: number; height: number }>();
  private readonly blocks = new Set<Block>();
  private frame: number | undefined;
  private readonly listeners = new Set<() => void>();
  /** Pictures mounted now and the most at once, for the spike's log. */
  livePictures = 0;
  livePicturesMax = 0;

  setView(offset: number, viewport: number) {
    if (offset === this.offset && viewport === this.viewport) return;
    this.offset = offset;
    this.viewport = viewport;
    this.schedule();
  }

  setMessage(id: string, y: number, height: number) {
    const before = this.messages.get(id);
    this.messages.set(id, { y, height });
    // A message whose height changed may have moved its blocks inside it.
    if (before && before.height !== height) for (const block of this.blocks) if (block.message === id) block.measure();
    this.schedule();
  }

  removeMessage(id: string) {
    this.messages.delete(id);
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
    this.livePicturesMax = Math.max(this.livePicturesMax, this.livePictures);
    this.notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  schedule() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = undefined;
      this.update();
    });
  }

  private place(block: Block): { top: number; bottom: number } | undefined {
    const message = this.messages.get(block.message);
    if (!message || !block.measured) return;
    return { top: message.y + block.y, bottom: message.y + block.y + block.height };
  }

  /** Blocks on screen whose pictures aren't drawn yet, or whose place isn't known. */
  pendingOnScreen(): number {
    let pending = 0;
    const [top, bottom] = [this.offset, this.offset + this.viewport];
    for (const block of this.blocks) {
      const place = this.place(block);
      const message = this.messages.get(block.message);
      const onScreen = place ? place.bottom > top && place.top < bottom : !message || (message.y + message.height > top && message.y < bottom);
      if (onScreen && !block.committed) pending++;
    }
    return pending;
  }

  /** Mounts what is on or near the screen, nearest first, and frees what is far away. */
  update() {
    if (!this.viewport) return;
    const top = this.offset;
    const bottom = this.offset + this.viewport;
    const near: { block: Block; distance: number }[] = [];
    for (const block of this.blocks) {
      const place = this.place(block);
      if (!place) continue;
      const distance = place.bottom < top ? top - place.bottom : place.top > bottom ? place.top - bottom : 0;
      if (block.wanted && distance > FREE_MARGIN * this.viewport) {
        block.wanted = false;
        block.setLive(false);
      } else if (!block.wanted && distance <= MOUNT_MARGIN * this.viewport) {
        near.push({ block, distance });
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
    this.notify();
  }
}

export const MathWindowContext = createContext<MathWindow | null>(null);
export const MessageScope = createContext<{ id: string; ref: RefObject<HostInstance | null> } | null>(null);

/** Whether a block holding `pictures` drawn equations shows them now. Outside a session's
 * transcript (the question dock, the plan) pictures always show. `ref` and `onLayout` go on
 * the block's own view. */
export function useLivePictures(pictures: number) {
  const window = useContext(MathWindowContext);
  const scope = useContext(MessageScope);
  const lazy = !!window && !!scope && pictures > 0;
  const [live, setLive] = useState(!lazy);
  const ref = useRef<HostInstance | null>(null);
  const block = useRef<Block | null>(null);

  useEffect(() => {
    if (!lazy || !window || !scope) return;
    const entry: Block = {
      message: scope.id, y: 0, height: 0, measured: false, pictures, wanted: false, committed: false, setLive,
      measure: () => {
        const node = ref.current;
        const parent = scope.ref.current;
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
  }, [lazy, window, scope, pictures]);

  useLayoutEffect(() => {
    if (block.current && window) window.committed(block.current, live);
  }, [live, window]);

  const onLayout = lazy ? (_event: LayoutChangeEvent) => block.current?.measure() : undefined;
  return { live: !lazy || live, ref, onLayout };
}
