import {
  AdditiveBlending,
  type BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';

/**
 * A point of the knowledge map drawn as a star (issue #189): a small bright
 * core in the page's shape and a soft halo that always faces the camera.
 *
 * The halo carries the colour, so the branches stay apart even where the
 * bloom pass would wash them towards white; the bloom only adds the last
 * shimmer. Chosen by the person in a side-by-side of six styles, over flat
 * spheres, glass, plasma, hologram and mother-of-pearl.
 */

/** How far the core is lifted towards white: a star's centre is hotter than its glow. */
const CORE_WHITENESS = 0.35;

const WHITE = new Color(1, 1, 1);

const HALO_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // A billboard: the quad is laid out in view space around the point's
    // centre, at the scale the mesh was given, so it faces the camera from
    // every angle without being turned every frame.
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.xy += position.xy * length(modelMatrix[0].xyz);
    gl_Position = projectionMatrix * centre;
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSoftness;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    if (r > 1.0) discard;
    float glow = pow(1.0 - r, uSoftness) * uOpacity;
    gl_FragColor = vec4(uColor * glow, glow);
  }
`;

/** The quad every halo is drawn on; one for the whole map. */
export function haloGeometry(): BufferGeometry {
  return new PlaneGeometry(2, 2);
}

/** Uniforms every halo shares, so a change of the look is one assignment. */
export interface SharedStarUniforms {
  uSoftness: { value: number };
}

export interface Star {
  group: Group;
  core: Mesh<BufferGeometry, MeshBasicMaterial>;
  halo: Mesh<BufferGeometry, ShaderMaterial>;
  /** Invisible, the size of the whole point: what a click hits, since the core is small. */
  hit: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** The halo's own uniforms, held here typed rather than read back from the material. */
  haloColour: Color;
  haloOpacity: { value: number };
}

export function makeStar(
  shape: BufferGeometry,
  quad: BufferGeometry,
  hitShape: BufferGeometry,
  shared: SharedStarUniforms,
): Star {
  const core = new Mesh(shape, new MeshBasicMaterial({ transparent: true }));
  const haloColour = new Color();
  const haloOpacity = { value: 1 };
  const halo = new Mesh(
    quad,
    new ShaderMaterial({
      uniforms: {
        uColor: { value: haloColour },
        uOpacity: haloOpacity,
        uSoftness: shared.uSoftness,
      },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  // The halo is light, not matter: it must not catch the pointer.
  halo.raycast = () => undefined;
  const hit = new Mesh(
    hitShape,
    new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  );
  const group = new Group();
  group.add(hit, halo, core);
  return { group, core, halo, hit, haloColour, haloOpacity };
}

/** Colours, opacity and size of a star for one frame. */
export function paintStar(
  star: Star,
  colour: Color,
  opacity: number,
  size: number,
  proportions: { core: number; halo: number },
): void {
  star.core.material.color.copy(colour).lerp(WHITE, CORE_WHITENESS);
  star.core.material.opacity = opacity;
  star.haloColour.copy(colour);
  star.haloOpacity.value = opacity;
  star.core.scale.setScalar(size * proportions.core);
  star.halo.scale.setScalar(size * proportions.halo);
  star.hit.scale.setScalar(size);
}

export function disposeStar(star: Star): void {
  star.core.material.dispose();
  star.halo.material.dispose();
  star.hit.material.dispose();
}
