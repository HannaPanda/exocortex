import ForceGraph3D, { type ConfigOptions, type ForceGraph3DInstance } from '3d-force-graph';
import {
  type BufferGeometry,
  Color,
  DodecahedronGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  SphereGeometry,
  type Sprite,
  Vector2,
} from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { type KnowledgeMapEdgeKind } from '@exocortex/contracts';

import { cssOf, type MapPalette } from './map-colors';
import { disposeLabel, makeLabel } from './map-labels';
import {
  branchColourIndex,
  endpointId,
  existsAt,
  labelledNodeIds,
  type MapGraph,
  type MapLink,
  type MapNode,
  neighboursOf,
  type Pulse,
  type PulseKind,
  pulseStrength,
  supersedes,
} from './map-model';

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

/** How many of the best connected points always carry a label. */
const ALWAYS_LABELLED = 18;
/** How long the room waits after the last touch before it starts turning again. */
const IDLE_BEFORE_TURNING_MS = 15_000;

const LINK_DISTANCE: Record<KnowledgeMapEdgeKind, number> = {
  tree: 26,
  link: 38,
  entity: 44,
  similar: 52,
};

/** The part of d3's link force the map tunes. The library types it as an open record. */
interface LinkForce {
  distance(value: (link: MapLink) => number): LinkForce;
  strength(value: (link: MapLink) => number): LinkForce;
}

interface ChargeForce {
  strength(value: number): ChargeForce;
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
  return typeof force === 'function' && 'strength' in force && typeof force.strength === 'function';
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
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
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
  private data: MapGraph = { nodes: [], links: [] };
  private branchIndex = new Map<string, number>();
  private labelled = new Set<string>();
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
    this.geometries = {
      page: new SphereGeometry(1, 20, 14),
      collection: new IcosahedronGeometry(1.25, 0),
      entity: new OctahedronGeometry(1.35, 0),
      project: new DodecahedronGeometry(1.2, 0),
    };
    const material = (colour: Color, opacity: number): LineBasicMaterial =>
      new LineBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false });
    const kinds: Record<KnowledgeMapEdgeKind, [Color, number]> = {
      link: [palette.foreground, 0.42],
      similar: [palette.branches[2] ?? palette.muted, 0.3],
      entity: [palette.entity, 0.32],
      tree: [palette.muted, 0.14],
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
      .linkDirectionalParticles((link) => this.particlesOf(link))
      .linkDirectionalParticleSpeed((link) => 0.0025 + link.weight * 0.003)
      .linkDirectionalParticleWidth((link) => (link.kind === 'link' ? 1.1 : 0.8))
      .linkDirectionalParticleColor((link) => cssOf(this.particleColour(link)))
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
      link
        .distance((entry) => LINK_DISTANCE[entry.kind])
        .strength((entry) => (entry.kind === 'similar' ? 0.15 + entry.weight * 0.25 : 0.6));
    }
    const charge = this.graph.d3Force('charge');
    if (isChargeForce(charge)) charge.strength(-55);

    // The glow: everything bright enough bleeds light into the dark room.
    // Light enough to stay legible on a laptop GPU; the labels are kept out
    // of the pass by not being tone mapped and staying below the threshold.
    const bloom = new UnrealBloomPass(
      new Vector2(element.clientWidth, element.clientHeight),
      options.reducedMotion ? 0.7 : 1.05,
      0.55,
      0.18,
    );
    this.graph.postProcessingComposer().addPass(bloom);

    const controls = this.graph.controls();
    if (isTurningControls(controls)) {
      controls.autoRotateSpeed = 0.35;
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
    this.branchIndex = branchColourIndex(graph.nodes, this.palette.branches.length);
    this.labelled = labelledNodeIds(graph.nodes, ALWAYS_LABELLED);
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
    const now = performance.now();
    for (const id of added.nodes) this.pulse(id, 'created', now);
    if (!this.options.reducedMotion) {
      const addedLinks = new Set(added.links);
      for (const entry of graph.links) {
        if (addedLinks.has(entry.key)) this.graph.emitParticle(entry);
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

  setCalm(calm: boolean): void {
    this.calm = calm;
    this.graph.linkDirectionalParticles(this.graph.linkDirectionalParticles());
  }

  setSize(width: number, height: number): void {
    this.graph.width(width).height(height);
  }

  /** Lights a point up, and sends light along its lines. */
  pulse(nodeId: string, kind: PulseKind, now = performance.now()): void {
    const next = { kind, at: now };
    if (!supersedes(next, this.pulses.get(nodeId), now)) return;
    this.pulses.set(nodeId, next);
    if (this.options.reducedMotion || this.calm) return;
    for (const entry of this.data.links) {
      if (!this.linkVisible(entry)) continue;
      if (endpointId(entry.source) === nodeId || endpointId(entry.target) === nodeId) {
        this.graph.emitParticle(entry);
      }
    }
  }

  /** Flies the camera to a point, or jumps there when motion is reduced. */
  flyTo(nodeId: string, durationMs = 1_400): void {
    const node = this.data.nodes.find((entry) => entry.id === nodeId);
    if (node?.x === undefined || node.y === undefined || node.z === undefined) return;
    this.touch();
    const distance = 70;
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
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
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

  private particlesOf(link: MapLink): number {
    if (this.options.reducedMotion || this.calm) return 0;
    if (this.linkState(link) === 'lit') return 3;
    if (link.kind === 'link') return 1;
    if (link.kind === 'similar') return link.weight > 0.5 ? 1 : 0;
    return 0;
  }

  private particleColour(link: MapLink): Color {
    if (link.kind === 'link') return this.palette.foreground;
    if (link.kind === 'entity') return this.palette.entity;
    return this.palette.branches[2] ?? this.palette.muted;
  }

  private refreshLinks(): void {
    this.graph
      .linkVisibility(this.graph.linkVisibility())
      .linkMaterial(this.graph.linkMaterial())
      .linkDirectionalParticles(this.graph.linkDirectionalParticles());
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
    const mesh = new Mesh(
      geometry,
      new MeshBasicMaterial({ color: this.baseColour(node), transparent: true }),
    );
    const radius = 1.4 + Math.sqrt(node.degree) * 0.95;
    mesh.scale.setScalar(radius);
    const group = new Group();
    group.add(mesh);
    const visual: NodeVisual = { group, mesh, radius, label: null };
    this.visuals.set(node.id, visual);
    return visual;
  }

  private baseColour(node: MapNode): Color {
    if (node.kind === 'entity') return this.palette.entity;
    return this.palette.branches[this.branchIndex.get(node.rootId) ?? 0] ?? this.palette.foreground;
  }

  private pulseColour(kind: PulseKind): Color {
    if (kind === 'write') return this.palette.signal;
    if (kind === 'read') return this.palette.read;
    if (kind === 'created') return this.palette.created;
    return this.palette.removed;
  }

  private disposeVisual(visual: NodeVisual): void {
    visual.mesh.material.dispose();
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
        this.selected === null &&
        now - this.lastTouch > IDLE_BEFORE_TURNING_MS;
    }

    for (const node of this.data.nodes) {
      const visual = this.visuals.get(node.id);
      if (visual !== undefined) this.paint(node, visual, now);
    }
    this.frame = requestAnimationFrame(this.animate);
  };

  private paint(node: MapNode, visual: NodeVisual, now: number): void {
    const pulse = this.pulses.get(node.id);
    const strength = pulse === undefined ? 0 : pulseStrength(pulse, now);
    if (pulse !== undefined && strength === 0) this.pulses.delete(node.id);

    this.scratch.copy(this.baseColour(node));
    if (pulse !== undefined && strength > 0) {
      this.scratch.lerp(this.pulseColour(pulse.kind), Math.min(1, strength * 1.4));
    }
    visual.mesh.material.color.copy(this.scratch);
    const inFocus = this.highlighted === null || this.highlighted.has(node.id);
    visual.mesh.material.opacity = inFocus || strength > 0 ? 1 : 0.14;
    const size = visual.radius * this.growth(strength) * this.emphasis(node.id);
    visual.mesh.scale.setScalar(size);
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
      (this.highlighted === null ? this.labelled.has(node.id) : this.highlighted.has(node.id));
    if (wantsLabel && visual.label === null) {
      visual.label = makeLabel(node.title, this.palette.foreground);
      visual.label.name = node.title;
      visual.group.add(visual.label);
    }
    if (visual.label !== null) {
      visual.label.visible = wantsLabel;
      visual.label.position.set(0, size + 3.2, 0);
    }
  }
}
