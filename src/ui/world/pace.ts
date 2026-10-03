// How often the office is drawn. It is drawn on demand, not at the display's rate: often enough
// to look smooth while anyone walks or the view moves, a few times a second when all is still
// (so lamps, crafts and the garden stay gently alive), and not at all while the tab is hidden or a
// modal dialog covers the office.
// Shadows are drawn again at most a few times a second, whatever the frame rate.

/** While you or anyone walks, the view turns or zooms, or a flight is under way. */
export const MOVING_FPS = 20;
/** First-person motion outside needs smaller steps than watching the office's avatars. */
export const OUTDOOR_FPS = 60;
/** While someone ambles in the garden or the view settles, without the cost of full motion. */
export const AMBLING_FPS = 10;
/** When nothing moves but the small things: breathing, lamps, tools, wheels, ducks. */
export const STILL_FPS = 5;
/** Keep full motion smooth through short pauses instead of turning choppy as soon as it stops. */
export const LINGER_MS = 4000;
/** Step through the middle rate before resting, while keeping long-idle rendering cheap. */
export const SETTLE_MS = 4000;
/** Let garden walks come to rest at their own rate without promoting them to full motion. */
export const AMBLE_LINGER_MS = 4000;
/** How often the shadows are drawn again. */
export const SHADOW_MS = 200;

/** The pace of one office's frames, on a clock in milliseconds (performance.now in the browser). */
export class Pacer {
  lastMotion = -Infinity;
  lastOutdoorMotion = -Infinity;
  outdoors = false;
  lastAmble = -Infinity;
  lastFrame = -Infinity;
  lastShadow = -Infinity;
  /** A modal dialog (such as the pipeline editor) is open over the office, which is inert beneath it. */
  covered = false;

  /** Something moved in this frame, or you just asked it to. */
  moved(now: number): void {
    this.lastMotion = Math.max(this.lastMotion, now);
  }

  /** Only the player's outdoor motion, never wildlife or office avatars, earns this rate. */
  walkedOutside(now: number): void {
    this.lastOutdoorMotion = Math.max(this.lastOutdoorMotion, now);
    this.moved(now);
  }

  /** Returning indoors immediately restores office pacing, even during the outdoor linger. */
  outside(value: boolean): void { this.outdoors = value; }

  /** A modal opened over the office or closed. Returns whether this uncovered it, so it is drawn again at once. */
  cover(value: boolean): boolean {
    const uncovered = this.covered && !value;
    this.covered = value;
    return uncovered;
  }

  /** Someone out in the garden walked in this frame: worth drawing, but no hurry. */
  ambled(now: number): void {
    this.lastAmble = Math.max(this.lastAmble, now);
  }

  moving(now: number): boolean {
    return now - this.lastMotion < LINGER_MS;
  }

  /** A frame was drawn. */
  drew(now: number): void {
    this.lastFrame = now;
  }

  /** How long until the next frame should be drawn, or null for none while the office cannot be seen. */
  nextFrameIn(now: number, visible: boolean): number | null {
    if (!visible || this.covered) return null;
    const settling = now - this.lastMotion < LINGER_MS + SETTLE_MS;
    const ambling = now - this.lastAmble < AMBLE_LINGER_MS;
    const outdoorMotion = this.outdoors && now - this.lastOutdoorMotion < LINGER_MS;
    const every = 1000 / (outdoorMotion ? OUTDOOR_FPS : this.moving(now) ? MOVING_FPS : settling || ambling ? AMBLING_FPS : STILL_FPS);
    return Math.max(0, Math.min(every, this.lastFrame + every - now));
  }

  /** Whether this frame should draw the shadows again; asking counts as drawing them when it says yes. */
  shadowsDue(now: number): boolean {
    if (now - this.lastShadow < SHADOW_MS) return false;
    this.lastShadow = now;
    return true;
  }
}
