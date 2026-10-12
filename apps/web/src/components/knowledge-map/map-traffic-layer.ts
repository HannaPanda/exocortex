import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  type Color,
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
  private readonly positions = new Float32Array(CAPACITY * 3);
  private readonly colours = new Float32Array(CAPACITY * 3);
  private readonly geometry = new BufferGeometry();
  private readonly material: PointsMaterial;
  private readonly points: Points;
  private motes: Mote[] = [];
  private waiting: Waiting[] = [];
  private liveliness = new Map<string, number>();
  private last = performance.now();
  private readonly at = new Vector3();

  constructor(
    private readonly scene: Scene,
    texture: DataTexture,
    private readonly source: TrafficSource,
  ) {
    const position = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    const colour = new BufferAttribute(this.colours, 3).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', position);
    this.geometry.setAttribute('color', colour);
    this.geometry.setDrawRange(0, 0);
    this.material = new PointsMaterial({
      size: MOTE_SIZE,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
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
    this.paint();
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

  private paint(): void {
    let count = 0;
    for (const mote of this.motes) {
      if (!this.place(mote)) continue;
      const offset = count * 3;
      this.positions[offset] = this.at.x;
      this.positions[offset + 1] = this.at.y;
      this.positions[offset + 2] = this.at.z;
      const colour = this.source.colour(mote.link);
      const brightness = moteBrightness(mote.t) * STATE_BRIGHTNESS[this.source.state(mote.link)];
      this.colours[offset] = colour.r * brightness;
      this.colours[offset + 1] = colour.g * brightness;
      this.colours[offset + 2] = colour.b * brightness;
      count += 1;
    }
    this.geometry.setDrawRange(0, count);
    const position = this.geometry.getAttribute('position');
    const colour = this.geometry.getAttribute('color');
    position.needsUpdate = true;
    colour.needsUpdate = true;
  }

  /** Where a mote is now, into `this.at`; false when its line has no place yet. */
  private place(mote: Mote): boolean {
    const along = mote.forward ? mote.t : 1 - mote.t;
    const curve = curveOf(mote.link);
    if (curve !== null) {
      curve.getPoint(along, this.at);
      return true;
    }
    const source = placed(mote.link.source);
    const target = placed(mote.link.target);
    if (source === null || target === null) return false;
    this.at.set(
      (source.x ?? 0) + ((target.x ?? 0) - (source.x ?? 0)) * along,
      (source.y ?? 0) + ((target.y ?? 0) - (source.y ?? 0)) * along,
      (source.z ?? 0) + ((target.z ?? 0) - (source.z ?? 0)) * along,
    );
    return true;
  }
}
