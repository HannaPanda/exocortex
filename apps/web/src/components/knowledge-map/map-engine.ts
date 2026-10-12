import ForceGraph3D, { type ConfigOptions, type ForceGraph3DInstance } from '3d-force-graph';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DodecahedronGeometry,
  type Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  OctahedronGeometry,
  Points,
  PointsMaterial,
  SphereGeometry,
  type Sprite,
  Vector2,
} from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
  type KnowledgeMapAppearance,
  type KnowledgeMapEdgeKind,
} from '@exocortex/contracts';

import { cssOf, type MapPalette, type PointColours, pointColours } from './map-colors';
import { disposeLabel, makeLabel } from './map-labels';
import {
  branchColourIndex,
  endpointId,
  existsAt,
  linkDegrees,
  type MapGraph,
  type MapLink,
  type MapNode,
  neighboursOf,
  type Pulse,
  type PulseKind,
  pulseOver,
  pulseStrength,
  sharedPull,
  supersedes,
} from './map-model';
import { disposeStar, haloGeometry, makeStar, paintStar, type Star } from './map-star';
import { TrafficLayer } from './map-traffic-layer';

/**
 * The library's constructor, typed for the map's own points and lines. Its
 * declaration keeps the node and link types on the interface but not on the
 * exported value, which is therefore typed for the library's bare defaults.
 * The instance holds whatever objects it is handed and calls every accessor
 * with them, so narrowing here is exactly what the generic interface means;
 * the assertion is the one place the map trusts the library's runtime over
 * its declaration (rule 7: isolated, typed, explained).
 */
type MapForceGraphConstructor = new (
  element: HTMLElement,
  options?: ConfigOptions,
) => ForceGraph3DInstance<MapNode, MapLink>;
const MapForceGraph = ForceGraph3D as unknown as MapForceGraphConstructor;

/** The bloom is gentler when the system asks for less motion; this much of the chosen strength. */
const REDUCED_MOTION_BLOOM = 0.65;
/** How long the room waits after the last touch before it starts turning again. */
const IDLE_BEFORE_TURNING_MS = 15_000;
/** How fast the room turns on its own; faster while it is a screensaver. */
const TURNING_SPEED = 0.35;
const SCREENSAVER_TURNING_SPEED = 0.6;

/**
 * The spark a lit point gives off: a few motes drifting outwards and fading.
 * Light on purpose, a flicker around the star rather than an explosion, and
 * capped, because a screensaver lights a point every few hundred milliseconds.
 */
const SPARK_MOTES = 16;
const SPARK_MS = 1_900;
/** World units per second at the start; seen from the whole map, not only up close. */
const SPARK_SPEED: readonly [number, number] = [22, 60];
/** A mote's size in world units, about a third of a small star. */
const SPARK_SIZE = 6;
const SPARK_LIMIT = 40;

interface Spark {
  points: Points;
  velocities: Float32Array;
  born: number;
  last: number;
}

/**
 * A soft round mote, computed once: without it a point sprite is a square.
 * White with a falling alpha, as numbers rather than a CSS colour, so the
 * material's own colour (the pulse token) is the only hue it ever shows.
 */
function moteTexture(): DataTexture {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const alpha = Math.max(0, 1 - distance) ** 2;
      pixels.set([255, 255, 255, Math.round(alpha * 255)], (y * size + x) * 4);
    }
  }
  const texture = new DataTexture(pixels, size, size);
  texture.needsUpdate = true;
  return texture;
}

/**
 * How far apart two connected points settle. Wide enough that a big branch is
 * a region rather than a knot: packed tighter, a hundred halos overlapped into
 * one white blot and its colour was gone.
 */
const LINK_DISTANCE: Record<KnowledgeMapEdgeKind, number> = {
  tree: 50,
  link: 70,
  entity: 75,
  similar: 95,
};
/** How hard a line of this kind pulls its two points together, before it is shared. */
function kindPull(link: MapLink): number {
  if (link.kind === 'similar') return 0.15 + link.weight * 0.25;
  // The tree pulls even while it is hidden, and a parent with a hundred
  // children pulled them into a ball; looser, it still keeps the branch together.
  if (link.kind === 'tree') return 0.35;
  return 0.6;
}

/** How hard every point pushes the others away. */
const CHARGE = -130;
/**
 * How far that push reaches. Unbounded, two branches with no line between
 * them pushed each other apart for as long as the simulation ran, and a new
 * area ended up a speck at the edge of the room.
 */
const CHARGE_REACH = 450;
/**
 * How hard the room's centre pulls every point back, per tick of the
 * simulation. Weak enough that a branch keeps its own shape, strong enough
 * that an island without a line to the rest stays in sight of it.
 */
const GRAVITY = 0.035;

/** A pull towards the origin, d3's `forceX/Y/Z` in one force without the dependency. */
function gravity(strength: number): ((alpha: number) => void) & {
  initialize: (nodes: MapNode[]) => void;
} {
  let nodes: MapNode[] = [];
  const force = (alpha: number): void => {
    const pull = strength * alpha;
    for (const node of nodes) {
      node.vx = (node.vx ?? 0) - (node.x ?? 0) * pull;
      node.vy = (node.vy ?? 0) - (node.y ?? 0) * pull;
      node.vz = (node.vz ?? 0) - (node.z ?? 0) * pull;
    }
  };
  force.initialize = (next: MapNode[]): void => {
    nodes = next;
  };
  return force;
}

/**
 * How much a similarity line bows. A one-pixel line cannot be told apart by
 * colour alone (white and pastel looked the same), so the line nobody drew
 * also has a different shape: references are straight, similarities curved.
 */
const SIMILAR_CURVATURE = 0.3;

/** The part of d3's link force the map tunes. The library types it as an open record. */
interface LinkForce {
  distance(value: (link: MapLink) => number): LinkForce;
  strength(value: (link: MapLink) => number): LinkForce;
}

interface ChargeForce {
  strength(value: number): ChargeForce;
  distanceMax(value: number): ChargeForce;
}

function isLinkForce(force: unknown): force is LinkForce {
  return (
    typeof force === 'function' &&
    'distance' in force &&
    typeof force.distance === 'function' &&
    'strength' in force &&
    typeof force.strength === 'function'
  );
}

function isChargeForce(force: unknown): force is ChargeForce {
  return (
    typeof force === 'function' &&
    'strength' in force &&
    typeof force.strength === 'function' &&
    'distanceMax' in force &&
    typeof force.distanceMax === 'function'
  );
}

/** The orbit controls' knobs the map uses; the library returns them as `object`. */
interface TurningControls {
  autoRotate: boolean;
  autoRotateSpeed: number;
  addEventListener(type: 'start', listener: () => void): void;
}

function isTurningControls(controls: object): controls is TurningControls {
  return 'autoRotate' in controls && 'addEventListener' in controls;
}

interface NodeVisual {
  group: Group;
  star: Star;
  radius: number;
  label: Sprite | null;
}

type LinkState = 'normal' | 'dim' | 'lit';

export interface MapEngineOptions {
  reducedMotion: boolean;
  onSelect: (nodeId: string | null) => void;
  onHover: (nodeId: string | null) => void;
}

/**
 * The knowledge map's renderer (issue #189): a force-directed 3D graph with a
 * glow pass, built on `3d-force-graph`.
 *
 * Imperative on purpose. The library owns a WebGL context and a simulation
 * that runs at 60 frames a second; React re-rendering it would rebuild the
 * scene on every state change. So the React side hands facts over (the graph,
 * which kinds are shown, the moment of the timeline, what is selected, what
 * just happened) and this class turns them into light.
 */
export class MapEngine {
  private readonly graph: ForceGraph3DInstance<MapNode, MapLink>;
  private readonly visuals = new Map<string, NodeVisual>();
  private readonly pulses = new Map<string, Pulse>();
  private readonly linkMaterials: Record<
    KnowledgeMapEdgeKind,
    Record<LinkState, LineBasicMaterial>
  >;
  private readonly geometries: Record<'page' | 'collection' | 'entity' | 'project', BufferGeometry>;
  private readonly quad = haloGeometry();
  private readonly starUniforms = {
    uSoftness: { value: DEFAULT_KNOWLEDGE_MAP_APPEARANCE.star.softness },
  };
  private readonly bloom: UnrealBloomPass;
  private readonly outputPass = new OutputPass();
  private look: KnowledgeMapAppearance = DEFAULT_KNOWLEDGE_MAP_APPEARANCE;
  private colours: PointColours;
  private data: MapGraph = { nodes: [], links: [] };
  private branchIndex = new Map<string, number>();
  private degrees = new Map<string, number>();
  private readonly sparks: Spark[] = [];
  private readonly mote = moteTexture();
  private readonly traffic: TrafficLayer;
  private screensaver = false;
  private shown: ReadonlySet<KnowledgeMapEdgeKind> = new Set(['link', 'similar', 'entity']);
  private moment: number | null = null;
  private selected: string | null = null;
  private hovered: string | null = null;
  private focus: ReadonlySet<string> | null = null;
  private highlighted: ReadonlySet<string> | null = null;
  private calm = false;
  private lastTouch = 0;
  private frame = 0;
  private disposed = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly palette: MapPalette,
    private readonly options: MapEngineOptions,
  ) {
    this.colours = pointColours(palette, this.look);
    this.geometries = {
      page: new SphereGeometry(1, 20, 14),
      collection: new IcosahedronGeometry(1.25, 0),
      entity: new OctahedronGeometry(1.35, 0),
      project: new DodecahedronGeometry(1.2, 0),
    };
    const material = (colour: Color, opacity: number): LineBasicMaterial =>
      new LineBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false });
    const kinds: Record<KnowledgeMapEdgeKind, [Color, number]> = {
      link: [palette.foreground, 0.5],
      similar: [palette.similar, 0.45],
      entity: [palette.entity, 0.4],
      tree: [palette.muted, 0.32],
    };
    this.linkMaterials = Object.fromEntries(
      Object.entries(kinds).map(([kind, [colour, opacity]]) => [
        kind,
        {
          normal: material(colour, opacity),
          dim: material(colour, opacity * 0.18),
          lit: material(colour, Math.min(1, opacity * 2.4)),
        },
      ]),
    ) as Record<KnowledgeMapEdgeKind, Record<LinkState, LineBasicMaterial>>;

    this.graph = new MapForceGraph(element, { controlType: 'orbit' })
      .backgroundColor(cssOf(palette.space))
      .showNavInfo(false)
      .width(element.clientWidth)
      .height(element.clientHeight)
      .nodeId('id')
      .nodeLabel(() => '')
      .nodeThreeObject((node) => this.visualOf(node).group)
      .nodeVisibility((node) => existsAt(node, this.moment))
      .linkVisibility((link) => this.linkVisible(link))
      .linkMaterial((link) => this.linkMaterials[link.kind][this.linkState(link)])
      .linkCurvature((link) => (link.kind === 'similar' ? SIMILAR_CURVATURE : 0))
      .enableNodeDrag(false)
      .warmupTicks(60)
      .cooldownTime(12_000)
      .onNodeClick((node) => {
        this.touch();
        this.options.onSelect(node.id);
      })
      .onNodeHover((node) => {
        this.hovered = node?.id ?? null;
        element.style.cursor = node === null ? 'default' : 'pointer';
        this.options.onHover(this.hovered);
      })
      .onBackgroundClick(() => {
        this.touch();
        this.options.onSelect(null);
      });

    const link = this.graph.d3Force('link');
    if (isLinkForce(link)) {
      link.distance((entry) => LINK_DISTANCE[entry.kind]).strength((entry) => this.pullOf(entry));
    }
    const charge = this.graph.d3Force('charge');
    if (isChargeForce(charge)) charge.strength(CHARGE).distanceMax(CHARGE_REACH);
    this.graph.d3Force('gravity', gravity(GRAVITY));

    // The room is the scene's background, not the renderer's clear colour:
    // the bloom pass composites over a cleared target and lifts a clear colour
    // into the slate of the page (measured: #09151c came out as #36566a),
    // while a scene background is drawn as geometry and stays what it is.
    this.graph.scene().background = palette.space.clone();

    // The motes on the lines are the map's own, not the library's: see `map-traffic.ts`.
    this.traffic = new TrafficLayer(this.graph.scene(), this.mote, {
      links: () => this.data.links,
      visible: (entry) => this.linkVisible(entry),
      state: (entry) => this.linkState(entry),
      colour: (entry) => this.particleColour(entry),
    });

    // The glow: everything bright enough bleeds light into the dark room.
    // Moderate by default. At full strength every point turned white and the
    // branch colours were gone; the threshold keeps the lines and the labels
    // out of it, so only the stars and the pulses glow. Its values are the
    // person's look (`setAppearance`).
    this.bloom = new UnrealBloomPass(
      new Vector2(element.clientWidth, element.clientHeight),
      0.7,
      0.4,
      0.32,
    );
    this.graph.postProcessingComposer().addPass(this.bloom);
    this.setAppearance(this.look);

    const controls = this.graph.controls();
    if (isTurningControls(controls)) {
      controls.autoRotateSpeed = TURNING_SPEED;
      controls.addEventListener('start', () => this.touch());
    }
    this.lastTouch = performance.now() - IDLE_BEFORE_TURNING_MS;
    this.frame = requestAnimationFrame(this.animate);
  }

  /** The new graph, keeping every point that stays where it is. */
  setGraph(graph: MapGraph, added: { nodes: readonly string[]; links: readonly string[] }): void {
    const known = new Set(graph.nodes.map((node) => node.id));
    for (const [id, visual] of this.visuals) {
      if (known.has(id)) continue;
      this.disposeVisual(visual);
      this.visuals.delete(id);
    }
    this.data = graph;
    this.degrees = linkDegrees(graph.links);
    this.branchIndex = branchColourIndex(graph.nodes, this.colours.branches.length);
    // A renamed page needs a new label texture.
    for (const node of graph.nodes) {
      const visual = this.visuals.get(node.id);
      if (
        visual?.label !== null &&
        visual?.label !== undefined &&
        visual.label.name !== node.title
      ) {
        visual.group.remove(visual.label);
        disposeLabel(visual.label);
        visual.label = null;
      }
    }
    this.graph.graphData(graph);
    this.traffic.setGraph(graph.nodes, graph.links);
    const now = performance.now();
    for (const id of added.nodes) this.pulse(id, 'created', now);
    if (!this.options.reducedMotion) {
      const addedLinks = new Set(added.links);
      for (const entry of graph.links) {
        if (addedLinks.has(entry.key)) this.traffic.send(entry, true, now);
      }
    }
  }

  setShownKinds(kinds: ReadonlySet<KnowledgeMapEdgeKind>): void {
    this.shown = kinds;
    this.refreshLinks();
  }

  /** A moment of the timeline, or `null` for now. */
  setMoment(moment: number | null): void {
    if (moment === this.moment) return;
    this.moment = moment;
    this.graph.nodeVisibility(this.graph.nodeVisibility());
    this.graph.linkVisibility(this.graph.linkVisibility());
  }

  setSelected(nodeId: string | null): void {
    this.selected = nodeId;
    this.highlighted =
      nodeId === null
        ? this.focus
        : new Set([nodeId, ...neighboursOf(this.data, nodeId, this.shown)]);
    this.refreshLinks();
    if (nodeId !== null) this.flyTo(nodeId);
  }

  /** The points a search found; everything else dims while it is set. */
  setFocus(nodeIds: ReadonlySet<string> | null): void {
    this.focus = nodeIds;
    if (this.selected === null) this.highlighted = nodeIds;
    this.refreshLinks();
  }

  /**
   * The room as a screensaver: it keeps turning whatever the last touch was,
   * a little faster, and shows the whole cloud. What lights up comes from
   * outside (`map-screensaver.ts`) through `pulse`, like everything else.
   */
  setScreensaver(on: boolean): void {
    this.screensaver = on;
    const controls = this.graph.controls();
    if (isTurningControls(controls)) {
      controls.autoRotateSpeed = on ? SCREENSAVER_TURNING_SPEED : TURNING_SPEED;
    }
    if (on) this.zoomToFit();
  }

  setCalm(calm: boolean): void {
    this.calm = calm;
  }

  /**
   * How the room looks to this person: the glow, the colours and the stars.
   * Applied at once, so the panel that tunes it is a live preview; the next
   * frame paints every star from the new colours.
   */
  setAppearance(look: KnowledgeMapAppearance): void {
    this.look = look;
    this.colours = pointColours(this.palette, look);
    this.starUniforms.uSoftness.value = look.star.softness;
    this.bloom.strength =
      look.bloom.strength * (this.options.reducedMotion ? REDUCED_MOTION_BLOOM : 1);
    this.bloom.radius = look.bloom.radius;
    this.bloom.threshold = look.bloom.threshold;
    // Without it the linear picture is shown as it is: darker, and blue and
    // purple glow less than green. Off by default because the room was
    // designed that way; the person decides.
    const composer = this.graph.postProcessingComposer();
    const corrected = composer.passes.includes(this.outputPass);
    if (look.colourCorrection && !corrected) composer.addPass(this.outputPass);
    if (!look.colourCorrection && corrected) composer.removePass(this.outputPass);
  }

  setSize(width: number, height: number): void {
    this.graph.width(width).height(height);
  }

  /** Lights a point up, and sends light along its lines: in for a read, out for the rest. */
  pulse(nodeId: string, kind: PulseKind, now = performance.now()): void {
    const next = { kind, at: now };
    if (!supersedes(next, this.pulses.get(nodeId), now)) return;
    this.pulses.set(nodeId, next);
    if (this.options.reducedMotion || this.calm) return;
    this.spark(nodeId, kind, now);
    this.traffic.burst(nodeId, kind, now);
  }

  /** Flies the camera to a point, or jumps there when motion is reduced. */
  flyTo(nodeId: string, durationMs = 1_400): void {
    const node = this.data.nodes.find((entry) => entry.id === nodeId);
    if (node?.x === undefined || node.y === undefined || node.z === undefined) return;
    this.touch();
    // Far enough to see the neighbourhood, not so close the neighbours fill the screen.
    const distance = 160;
    const length = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + distance / length;
    this.graph.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio },
      { x: node.x, y: node.y, z: node.z },
      this.options.reducedMotion ? 0 : durationMs,
    );
  }

  zoomToFit(): void {
    this.graph.zoomToFit(this.options.reducedMotion ? 0 : 900, 40);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const spark of this.sparks.splice(0)) this.disposeSpark(spark);
    this.traffic.dispose();
    this.mote.dispose();
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.quad.dispose();
    this.outputPass.dispose();
    for (const states of Object.values(this.linkMaterials)) {
      for (const material of Object.values(states)) material.dispose();
    }
    this.graph.pauseAnimation();
    this.graph._destructor();
    this.element.replaceChildren();
  }

  private touch(): void {
    this.lastTouch = performance.now();
  }

  /** Read by d3 when it is handed a graph, which `setGraph` does after counting the degrees. */
  private pullOf(link: MapLink): number {
    return sharedPull(
      kindPull(link),
      this.degrees.get(endpointId(link.source)) ?? 1,
      this.degrees.get(endpointId(link.target)) ?? 1,
    );
  }

  private linkVisible(link: MapLink): boolean {
    if (!this.shown.has(link.kind)) return false;
    const source = typeof link.source === 'string' ? undefined : link.source;
    const target = typeof link.target === 'string' ? undefined : link.target;
    if (source !== undefined && !existsAt(source, this.moment)) return false;
    if (target !== undefined && !existsAt(target, this.moment)) return false;
    return true;
  }

  private linkState(link: MapLink): LinkState {
    if (this.highlighted === null) return 'normal';
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (this.selected !== null) {
      return source === this.selected || target === this.selected ? 'lit' : 'dim';
    }
    return this.highlighted.has(source) && this.highlighted.has(target) ? 'lit' : 'dim';
  }

  private particleColour(link: MapLink): Color {
    if (link.kind === 'link') return this.palette.foreground;
    if (link.kind === 'entity') return this.palette.entity;
    return this.palette.similar;
  }

  private refreshLinks(): void {
    this.graph.linkVisibility(this.graph.linkVisibility()).linkMaterial(this.graph.linkMaterial());
  }

  private visualOf(node: MapNode): NodeVisual {
    const existing = this.visuals.get(node.id);
    if (existing !== undefined) return existing;
    const geometry =
      node.kind === 'entity'
        ? this.geometries.entity
        : node.type === 'COLLECTION'
          ? this.geometries.collection
          : node.type === 'PROJECT'
            ? this.geometries.project
            : this.geometries.page;
    const star = makeStar(geometry, this.quad, geometry, this.starUniforms);
    const radius = 1.4 + Math.sqrt(node.degree) * 0.95;
    const visual: NodeVisual = { group: star.group, star, radius, label: null };
    this.visuals.set(node.id, visual);
    return visual;
  }

  private baseColour(node: MapNode): Color {
    if (node.kind === 'entity') return this.colours.entity;
    return this.colours.branches[this.branchIndex.get(node.rootId) ?? 0] ?? this.palette.foreground;
  }

  private pulseColour(kind: PulseKind): Color {
    return this.colours.pulses[kind];
  }

  /** A few motes in the pulse's colour, leaving the point in every direction. */
  private spark(nodeId: string, kind: PulseKind, now: number): void {
    const node = this.data.nodes.find((entry) => entry.id === nodeId);
    if (node?.x === undefined || node.y === undefined || node.z === undefined) return;
    if (!existsAt(node, this.moment)) return;
    if (this.sparks.length >= SPARK_LIMIT) {
      const oldest = this.sparks.shift();
      if (oldest !== undefined) this.disposeSpark(oldest);
    }
    const positions = new Float32Array(SPARK_MOTES * 3);
    const velocities = new Float32Array(SPARK_MOTES * 3);
    const [slow, fast] = SPARK_SPEED;
    for (let mote = 0; mote < SPARK_MOTES; mote += 1) {
      // A uniform direction on the sphere, not a cube's corners.
      const z = Math.random() * 2 - 1;
      const angle = Math.random() * Math.PI * 2;
      const ring = Math.sqrt(1 - z * z);
      const speed = slow + Math.random() * (fast - slow);
      positions.set([node.x, node.y, node.z], mote * 3);
      velocities.set(
        [ring * Math.cos(angle) * speed, ring * Math.sin(angle) * speed, z * speed],
        mote * 3,
      );
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      color: this.pulseColour(kind),
      size: SPARK_SIZE,
      map: this.mote,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    this.graph.scene().add(points);
    this.sparks.push({ points, velocities, born: now, last: now });
  }

  /** Moves every mote on, slowing as it fades, and clears the spent ones. */
  private driftSparks(now: number): void {
    for (let index = this.sparks.length - 1; index >= 0; index -= 1) {
      const spark = this.sparks[index];
      if (spark === undefined) continue;
      const age = (now - spark.born) / SPARK_MS;
      if (age >= 1) {
        this.sparks.splice(index, 1);
        this.disposeSpark(spark);
        continue;
      }
      const seconds = Math.min(0.05, (now - spark.last) / 1_000) * (1 - age);
      spark.last = now;
      const attribute = spark.points.geometry.getAttribute('position');
      const positions = attribute.array;
      for (let offset = 0; offset < positions.length; offset += 1) {
        positions[offset] = (positions[offset] ?? 0) + (spark.velocities[offset] ?? 0) * seconds;
      }
      attribute.needsUpdate = true;
      const material = spark.points.material;
      if (material instanceof PointsMaterial) material.opacity = 0.85 * (1 - age) * (1 - age);
    }
  }

  private disposeSpark(spark: Spark): void {
    this.graph.scene().remove(spark.points);
    spark.points.geometry.dispose();
    const material = spark.points.material;
    if (material instanceof PointsMaterial) material.dispose();
  }

  private disposeVisual(visual: NodeVisual): void {
    disposeStar(visual.star);
    if (visual.label !== null) disposeLabel(visual.label);
  }

  private readonly scratch = new Color();

  /**
   * Once per frame: colour, size and label of every point, from its branch,
   * its pulse and whether it is in focus. Cheap enough for a thousand points,
   * and the only place the room is animated by this code rather than the
   * library.
   */
  private readonly animate = (): void => {
    if (this.disposed) return;
    const now = performance.now();

    const controls = this.graph.controls();
    if (isTurningControls(controls)) {
      controls.autoRotate =
        !this.options.reducedMotion &&
        !this.calm &&
        (this.screensaver ||
          (this.selected === null && now - this.lastTouch > IDLE_BEFORE_TURNING_MS));
    }
    this.driftSparks(now);
    this.traffic.frame(now, !this.options.reducedMotion && !this.calm);

    for (const node of this.data.nodes) {
      const visual = this.visuals.get(node.id);
      if (visual !== undefined) this.paint(node, visual, now);
    }
    this.frame = requestAnimationFrame(this.animate);
  };

  private paint(node: MapNode, visual: NodeVisual, now: number): void {
    const pulse = this.pulses.get(node.id);
    const strength = pulse === undefined ? 0 : pulseStrength(pulse, now);
    if (pulse !== undefined && pulseOver(pulse, now)) this.pulses.delete(node.id);

    this.scratch.copy(this.baseColour(node));
    if (pulse !== undefined && strength > 0) {
      this.scratch.lerp(this.pulseColour(pulse.kind), Math.min(1, strength * 1.4));
    }
    const inFocus = this.highlighted === null || this.highlighted.has(node.id);
    const size = visual.radius * this.growth(strength) * this.emphasis(node.id);
    paintStar(visual.star, this.scratch, inFocus || strength > 0 ? 1 : 0.14, size, this.look.star);
    this.syncLabel(node, visual, strength > 0, size);
  }

  private growth(strength: number): number {
    return this.options.reducedMotion ? 1 : 1 + strength * 0.9;
  }

  private emphasis(nodeId: string): number {
    if (nodeId === this.selected) return 1.5;
    return nodeId === this.hovered ? 1.25 : 1;
  }

  private syncLabel(node: MapNode, visual: NodeVisual, lit: boolean, size: number): void {
    const wantsLabel =
      node.id === this.selected ||
      node.id === this.hovered ||
      lit ||
      (this.focus !== null && this.focus.has(node.id));
    if (wantsLabel && visual.label === null) {
      visual.label = makeLabel(node.title, this.palette.muted);
      visual.label.name = node.title;
      visual.group.add(visual.label);
    }
    if (visual.label !== null) {
      visual.label.visible = wantsLabel;
      // Above the visible part of the halo, which fades out well before its edge.
      visual.label.position.set(0, size * Math.max(1, this.look.star.halo * 0.45) + 2, 0);
    }
  }
}
