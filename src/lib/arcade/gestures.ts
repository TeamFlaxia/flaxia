// Document-level drag/swipe handling for the Arcade viewport. Touch and mouse
// share one state machine; the Svelte page only mirrors the offset.
import { resolveSwipe, type SwipeDirection } from './swipe.ts';

export interface ArcadeDragGestureOptions {
  /** False while a modal, the tour, fullscreen or a transition owns input. */
  canStart: () => boolean;
  getOffset: () => number;
  onStart: () => void;
  onMove: (offset: number) => void;
  onEnd: (direction: SwipeDirection, velocity: number) => void;
}

export class ArcadeDragGesture {
  private readonly options: ArcadeDragGestureOptions;
  private startY = 0;
  private startX = 0;
  private startTime = 0;
  private baseOffset = 0;
  private velocity = 0;
  private active = false;

  constructor(options: ArcadeDragGestureOptions) {
    this.options = options;
  }

  attach(): void {
    document.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    document.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    document.addEventListener('touchend', this.handleTouchEnd, { passive: true });
    document.addEventListener('mousedown', this.handleMouseDown, { passive: true });
    document.addEventListener('mousemove', this.handleMouseMove, { passive: false });
    document.addEventListener('mouseup', this.handleMouseUp, { passive: true });
    document.addEventListener('mouseleave', this.handleMouseUp, { passive: true });
  }

  detach(): void {
    document.removeEventListener('touchstart', this.handleTouchStart);
    document.removeEventListener('touchmove', this.handleTouchMove);
    document.removeEventListener('touchend', this.handleTouchEnd);
    document.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('mouseleave', this.handleMouseUp);
  }

  private begin(y: number, x: number, target: EventTarget | null): void {
    if (!this.options.canStart()) return;
    // Never steal a drag from a text field or other form control.
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    this.startY = y;
    this.startX = x;
    this.startTime = Date.now();
    this.baseOffset = this.options.getOffset();
    this.velocity = 0;
    this.active = true;
    this.options.onStart();
  }

  private move(y: number): void {
    if (!this.active) return;
    const diff = y - this.startY;
    const elapsed = Date.now() - this.startTime;
    if (elapsed > 0) this.velocity = diff / elapsed;
    this.options.onMove(this.baseOffset + diff);
  }

  private end(y: number, x: number): void {
    if (!this.active) return;
    this.active = false;
    const direction = resolveSwipe({
      startX: this.startX,
      startY: this.startY,
      endX: x,
      endY: y,
      velocity: this.velocity,
    });
    this.options.onEnd(direction, this.velocity);
    this.velocity = 0;
  }

  private readonly handleTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (touch) this.begin(touch.clientY, touch.clientX, event.target);
  };

  private readonly handleTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (!touch || !this.active) return;
    event.preventDefault();
    this.move(touch.clientY);
  };

  private readonly handleTouchEnd = (event: TouchEvent): void => {
    const touch = event.changedTouches[0];
    if (touch) this.end(touch.clientY, touch.clientX);
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    this.begin(event.clientY, event.clientX, event.target);
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.active) return;
    event.preventDefault();
    this.move(event.clientY);
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    this.end(event.clientY, event.clientX);
  };
}
