import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Curve,
  type DataTexture,
  DynamicDrawUsage,
  Points,
  PointsMaterial,
  type Scene,
  Vector3,
} from 'three';

import { endpointId, type MapLink, type MapNode, type PulseKind } from './map-model';
import {
  calmMs,
  type Disturbance,
  disturbanceKind,
  disturbanceMs,
  flickerAt,
  flickerPeak,
  flickerSize,
  GHOST_LAG_S,
  type GlitchShape,
  glitchShape,
  JITTER_REACH,
  moteScale,
  SPLIT_REACH,
  TRAIL_POINTS,
  TRAIL_STEP_S,
  trailBrightness,
  trailSize,
} from './map-mote-signal';
import {
  burstPlan,
  convoyGap,
  convoySize,
  freshness,
  idleForward,
  idleRate,
  laneSpeed,
  moteBrightness,
  type TrafficState,
} from './map-traffic';

/** At most this many motes on the lines at once; a new one waits for a free place. */
const CAPACITY = 2_400;
/**
 * The points one mote may draw: itself, its trail, and the two halves of a
 * split glitch (a ghost uses one of those places, never both at once).
 */
const POINTS_PER_MOTE = 1 + TRAIL_POINTS + 2;
const POINT_CAPACITY = CAPACITY * POINTS_PER_MOTE;
/** A mote's size in world units, a little larger than the library's particles, but soft. */
const MOTE_SIZE = 3.6;
/** A similarity line bows, so it is a little longer than the straight distance. */
const CURVED_LENGTH = 1.06;
/** How bright a mote is on a line in each state. */
const STATE_BRIGHTNESS: Record<TrafficState, number> = { normal: 0.85, dim: 0.22, lit: 1.25 };

/** What the layer asks the engine about a line; the engine decides what is shown and lit. */
export interface TrafficSource {
  links(): readonly MapLink[];
  visible(link: MapLink): boolean;
  state(link: MapLink): TrafficState;
  colour(link: MapLink): Color;
}

interface Mote {
  link: MapLink;
  forward: boolean;
  /** How far along the line it is, from 0 to 1 in its own direction. */
  t: number;
  speed: number;
  /** Its own size around 1, fixed for its whole journey. */
  scale: number;
  /** The disturbance it is in now, or null while it glides. */
  disturbance: Disturbance | null;
  shape: GlitchShape;
  /** When the current disturbance began and ends, or when the next one begins. */
  from: number;
  until: number;
  peak: number;
  ripple: number;
  /** A random direction drawn when a disturbance starts; a split stands across the line from it. */
  across: Vector3;
}

interface Waiting {
  link: MapLink;
  forward: boolean;
  due: number;
}

function placed(end: string | MapNode): MapNode | null {
  return typeof end === 'string' || end.x === undefined ? null : end;
}

/** The bezier the library keeps on a curved line; it puts it there itself, untyped. */
function curveOf(link: MapLink): Curve<Vector3> | null {
  const curve: unknown = Reflect.get(link, '__curve');
  return curve instanceof Curve ? (curve as Curve<Vector3>) : null;
}

/**
 * The motes on the map's lines, drawn as one point cloud (issue #189). Planned
 * by `map-traffic.ts`; this class only moves them and paints them.
 */
export class TrafficLayer {
  private readonly positions = new Float32Array(POINT_CAPACITY * 3);
  private readonly colours = new Float32Array(POINT_CAPACITY * 3);
  private readonly scales = new Float32Array(POINT_CAPACITY);
  private drawn = 0;
  private readonly geometry = new BufferGeometry();
  private readonly material: PointsMaterial;
  private readonly points: Points;
  private motes: Mote[] = [];
  private waiting: Waiting[] = [];
  private liveliness = new Map<string, number>();
  private last = performance.now();
  private readonly at = new Vector3();
  private readonly behind = new Vector3();
  private readonly side = new Vector3();
  private readonly tint = new Color();

  constructor(
    private readonly scene: Scene,
    texture: DataTexture,
    private readonly source: TrafficSource,
  ) {
    const position = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    const colour = new BufferAttribute(this.colours, 3).setUsage(DynamicDrawUsage);
    const scale = new BufferAttribute(this.scales, 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', position);
    this.geometry.setAttribute('color', colour);
    this.geometry.setAttribute('moteScale', scale);
    this.geometry.setDrawRange(0, 0);
    this.material = new PointsMaterial({
      size: MOTE_SIZE,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    // One size per point rather than one per material: the motes differ a
    // little from each other, a flicker swells one, a trail tapers. Three's
    // point shader multiplies `size` by the perspective afterwards, so the
    // factor goes in before that and everything else stays the library's.
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute float moteScale;\n${shader.vertexShader.replace(
        'gl_PointSize = size;',
        'gl_PointSize = size * moteScale;',
      )}`;
    };
    this.material.customProgramCacheKey = () => 'exocortex-map-mote';
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  /** How lively each line is, from the livelier of its two pages; read once per graph. */
  setGraph(nodes: readonly MapNode[], links: readonly MapLink[], now = Date.now()): void {
    const fresh = new Map(nodes.map((node) => [node.id, freshness(node, now)]));
    this.liveliness = new Map(
      links.map((link) => [
        link.key,
        Math.max(fresh.get(endpointId(link.source)) ?? 0, fresh.get(endpointId(link.target)) ?? 0),
      ]),
    );
    const known = new Set(links);
    this.motes = this.motes.filter((mote) => known.has(mote.link));
    this.waiting = this.waiting.filter((entry) => known.has(entry.link));
  }

  /** One mote along a line, now or later. */
  send(link: MapLink, forward: boolean, due = performance.now()): void {
    this.waiting.push({ link, forward, due });
  }

  /** A point was used: its lines send, one after another, in or out by the kind of access. */
  burst(nodeId: string, kind: PulseKind, now = performance.now()): void {
    const shown = this.source.links().filter((link) => this.source.visible(link));
    for (const departure of burstPlan(nodeId, kind, shown, Math.random)) {
      this.send(departure.link, departure.forward, now + departure.delay);
    }
  }

  clear(): void {
    this.motes = [];
    this.waiting = [];
    this.drawn = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /** Once per frame. `moving` is false while the room is calm or motion is reduced. */
  frame(now: number, moving: boolean): void {
    const seconds = Math.min(0.05, Math.max(0, now - this.last) / 1_000);
    this.last = now;
    if (!moving) {
      if (this.motes.length > 0 || this.waiting.length > 0) this.clear();
      return;
    }
    this.idle(now, seconds);
    this.depart(now);
    this.advance(seconds);
    this.paint(now);
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }

  /** The quiet traffic: every line sends now and then, at its own rate, sometimes a convoy. */
  private idle(now: number, seconds: number): void {
    for (const link of this.source.links()) {
      const rate = idleRate(link, this.liveliness.get(link.key) ?? 0, this.source.state(link));
      if (rate <= 0 || Math.random() >= rate * seconds) continue;
      if (!this.source.visible(link)) continue;
      const forward = idleForward(link, Math.random);
      const size = convoySize(Math.random);
      let due = now;
      for (let index = 0; index < size; index += 1) {
        this.send(link, forward, due);
        due += convoyGap(Math.random);
      }
    }
  }

  private depart(now: number): void {
    if (this.waiting.length === 0) return;
    const later: Waiting[] = [];
    for (const entry of this.waiting) {
      if (entry.due > now) later.push(entry);
      else if (this.motes.length < CAPACITY && this.source.visible(entry.link)) {
        this.motes.push({
          link: entry.link,
          forward: entry.forward,
          t: 0,
          speed: laneSpeed(entry.link, Math.random),
          scale: moteScale(Math.random),
          disturbance: null,
          shape: 'ghost',
          from: now,
          // The first disturbance waits a calm of its own, so a convoy does not leave flickering.
          until: now + calmMs(Math.random),
          peak: 1,
          ripple: 0,
          across: new Vector3(0, 1, 0),
        });
      }
    }
    this.waiting = later;
  }

  private advance(seconds: number): void {
    this.motes = this.motes.filter((mote) => {
      const length = this.lengthOf(mote.link);
      if (length === null || length <= 0) return false;
      mote.t += (mote.speed * seconds) / length;
      return mote.t < 1;
    });
  }

  private lengthOf(link: MapLink): number | null {
    const source = placed(link.source);
    const target = placed(link.target);
    if (source === null || target === null) return null;
    const straight = Math.hypot(
      (target.x ?? 0) - (source.x ?? 0),
      (target.y ?? 0) - (source.y ?? 0),
      (target.z ?? 0) - (source.z ?? 0),
    );
    return curveOf(link) === null ? straight : straight * CURVED_LENGTH;
  }

  private paint(now: number): void {
    let count = 0;
    for (const mote of this.motes) {
      if (count + POINTS_PER_MOTE > POINT_CAPACITY) break;
      count = this.paintMote(mote, now, count);
    }
    // Nothing on the lines and nothing drawn last frame: no upload at all.
    if (count === 0 && this.drawn === 0) return;
    this.drawn = count;
    this.geometry.setDrawRange(0, count);
    for (const [name, width] of [
      ['position', 3],
      ['color', 3],
      ['moteScale', 1],
    ] as const) {
      const attribute = this.geometry.getAttribute(name);
      if (!(attribute instanceof BufferAttribute)) continue;
      // Only the points drawn this frame go to the GPU, not the whole capacity.
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, count) * width);
      attribute.needsUpdate = true;
    }
  }

  /** One mote with its trail and, while it glitches, its copies; returns the next free point. */
  private paintMote(mote: Mote, now: number, first: number): number {
    if (!this.place(mote, mote.t, this.at)) return first;
    this.disturb(mote, now);
    const colour = this.source.colour(mote.link);
    const state = STATE_BRIGHTNESS[this.source.state(mote.link)];
    const length = Math.max(1e-6, this.lengthOf(mote.link) ?? 1);
    const base = moteBrightness(mote.t) * state;
    const glitch = mote.disturbance === 'glitch' ? mote.shape : null;
    let light = glitch === 'split' ? base * 0.7 : base;
    let size = mote.scale;

    if (mote.disturbance === 'flicker') {
      const progress = (now - mote.from) / Math.max(1, mote.until - mote.from);
      const factor = flickerAt(progress, mote.peak, mote.ripple);
      light *= factor;
      size *= flickerSize(factor);
    } else if (mote.disturbance === 'jitter') {
      // Re-rolled every frame while it lasts: a tremor, not a detour.
      this.at.x += (Math.random() * 2 - 1) * JITTER_REACH;
      this.at.y += (Math.random() * 2 - 1) * JITTER_REACH;
      this.at.z += (Math.random() * 2 - 1) * JITTER_REACH;
    }
    let count = this.emit(first, this.at, colour, light, size);

    // The trail: points where the mote was a moment ago, fainter and smaller.
    // A broken trail loses its second point and, at random, some of the rest.
    const step = (mote.speed * TRAIL_STEP_S) / length;
    for (let index = 1; index <= TRAIL_POINTS; index += 1) {
      const t = mote.t - step * index;
      if (t <= 0 || !this.place(mote, t, this.behind)) break;
      if (glitch === 'broken' && (index === 2 || Math.random() < 0.35)) continue;
      const trail = moteBrightness(t) * state * trailBrightness(index);
      count = this.emit(count, this.behind, colour, trail, mote.scale * trailSize(index));
    }

    if (glitch === 'ghost') {
      // A copy that lags behind, as if the packet were sent twice.
      const lag = (mote.speed * GHOST_LAG_S) / length;
      if (mote.t - lag > 0 && this.place(mote, mote.t - lag, this.behind)) {
        count = this.emit(count, this.behind, colour, base * 0.5, size * 1.1);
      }
    } else if (glitch === 'split') {
      // The signal splits into its cyan and magenta halves for a moment:
      // the mote's own colour without its red, and without its green, so
      // the split stays in the token's light rather than a colour of its own.
      this.sideways(mote);
      this.behind.copy(this.at).addScaledVector(this.side, SPLIT_REACH);
      this.tint.copy(colour).r = 0;
      count = this.emit(count, this.behind, this.tint, base * 0.8, size);
      this.behind.copy(this.at).addScaledVector(this.side, -SPLIT_REACH);
      this.tint.copy(colour).g = 0;
      count = this.emit(count, this.behind, this.tint, base * 0.8, size);
    }
    return count;
  }

  /** One point into the buffers; returns the next free one. */
  private emit(index: number, at: Vector3, colour: Color, light: number, size: number): number {
    const offset = index * 3;
    this.positions[offset] = at.x;
    this.positions[offset + 1] = at.y;
    this.positions[offset + 2] = at.z;
    this.colours[offset] = colour.r * light;
    this.colours[offset + 1] = colour.g * light;
    this.colours[offset + 2] = colour.b * light;
    this.scales[index] = size;
    return index + 1;
  }

  /**
   * Moves a mote's signal on: a disturbance that is over gives way to a calm
   * of random length, a calm that is over to a disturbance of random kind.
   * Every mote keeps its own clock, so no two flicker in step.
   */
  private disturb(mote: Mote, now: number): void {
    if (now < mote.until) return;
    if (mote.disturbance !== null) {
      mote.disturbance = null;
      mote.from = now;
      mote.until = now + calmMs(Math.random);
      return;
    }
    mote.disturbance = disturbanceKind(Math.random);
    mote.from = now;
    mote.until = now + disturbanceMs(Math.random);
    mote.peak = flickerPeak(Math.random);
    mote.ripple = Math.random();
    mote.shape = glitchShape(Math.random);
    mote.across.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
  }

  /** A direction across the mote's line for a split, into `this.side`. */
  private sideways(mote: Mote): void {
    this.side.set(0, 1, 0);
    const source = placed(mote.link.source);
    const target = placed(mote.link.target);
    if (source === null || target === null) return;
    this.behind.set(
      (target.x ?? 0) - (source.x ?? 0),
      (target.y ?? 0) - (source.y ?? 0),
      (target.z ?? 0) - (source.z ?? 0),
    );
    this.side.crossVectors(this.behind, mote.across);
    if (this.side.lengthSq() < 1e-9) this.side.set(0, 1, 0);
    this.side.normalize();
  }

  /** Where a mote is at `t` along its line, into `into`; false when its line has no place yet. */
  private place(mote: Mote, t: number, into: Vector3): boolean {
    const along = mote.forward ? t : 1 - t;
    const curve = curveOf(mote.link);
    if (curve !== null) {
      curve.getPoint(along, into);
      return true;
    }
    const source = placed(mote.link.source);
    const target = placed(mote.link.target);
    if (source === null || target === null) return false;
    into.set(
      (source.x ?? 0) + ((target.x ?? 0) - (source.x ?? 0)) * along,
      (source.y ?? 0) + ((target.y ?? 0) - (source.y ?? 0)) * along,
      (source.z ?? 0) + ((target.z ?? 0) - (source.z ?? 0)) * along,
    );
    return true;
  }
}
