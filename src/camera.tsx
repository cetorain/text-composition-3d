import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * A "camera rig" for the 2D-CSS-3D poster.
 * We simulate a virtual camera by transforming the ENTIRE poster inside a
 * perspective container: rotations (cameraOrbitX/Y/Z), dolly (zoom), and
 * pan (translateX/Y). All text layers share the same camera view so the
 * effect is one unified "camera trajectory", not per-layer tweaks.
 */
export interface CameraRig {
  orbitX: number; // deg, camera pitch around the poster
  orbitY: number; // deg, camera yaw around the poster
  orbitZ: number; // deg, camera roll
  dolly: number;  // 1 = 100% scale, >1 = camera closer (zoom in), <1 = farther (zoom out)
  panX: number;   // px, horizontal pan
  panY: number;   // px, vertical pan
  /** px, depth into the scene (translateZ). + = camera moves forward into scene. */
  z: number;
  perspective: number; // px for the perspective wrapper
}

export const DEFAULT_CAMERA: CameraRig = {
  orbitX: 0,
  orbitY: 0,
  orbitZ: 0,
  dolly: 1,
  panX: 0,
  panY: 0,
  z: 0,
  perspective: 1200,
};

export type EasingFn = (t: number) => number;

/* ---------- Custom spherical waypoints ---------- */

/**
 * A spherical waypoint encodes a camera position on a latitude/longitude
 * sphere. `lat` and `lon` are expressed in degrees. Clicking a node on the
 * 2D ring grid maps directly to (lat, lon). The camera rig interprets this as:
 *  - orbitY = lon (yaw around the poster, positive = right)
 *  - orbitX = -lat (pitch, a point on the north pole of the sphere looks down)
 *  - dolly = derived from latitude weight and optional user dolly tuning
 *  - orbitZ = roll, currently 0 (kept for future extensions)
 */
export const CUSTOM_TRAJECTORY_ID = 'custom-sphere';
export const CUSTOM_TRAJECTORY_LABEL = 'Sphere Custom';
export const CUSTOM_TRAJECTORY_DURATION_MS = 8000;
/** Pan scale for sphere x/y offsets (matches walk). */
const SPHERE_PAN_SCALE = 500;
/** Depth scale for sphere z offsets (matches walk). */
const SPHERE_DEPTH_SCALE = 900;

export interface SphereWaypoint {
  id: string;
  lat: number; // -90..+90 (degrees)
  lon: number; // -180..+180 (degrees)
  dolly: number; // 0.6..1.7 — how close the camera feels at this waypoint
  /** -2..2 — extra horizontal pan offset at this waypoint. */
  x: number;
  /** -2..2 — extra vertical pan offset at this waypoint. */
  y: number;
  /** -2..2 — extra depth (translateZ) offset at this waypoint. */
  z: number;
  /** deg, pitch: + = look up, - = look down. Range -45..45. */
  lookX: number;
  /** deg, yaw: + = look right, - = look left. Range -45..45. */
  lookY: number;
  /** deg, roll: + = clockwise tilt. Range -15..15. */
  lookZ: number;
}

/** Latitude rings shown on the sphere UI (degrees). 5 latitudes × 8 longitudes = 40 nodes. */
export const SPHERE_LATITUDES: readonly number[] = [
  -60, -30, 0, 30, 60,
] as const;

/** Longitude count (uniform) per ring. */
export const SPHERE_LONGITUDE_COUNT = 8;

/** Produce a list of (lon, index) positions for a ring. */
export function getRingLons(): number[] {
  const out: number[] = [];
  for (let i = 0; i < SPHERE_LONGITUDE_COUNT; i++) {
    out.push((i / SPHERE_LONGITUDE_COUNT) * 360 - 180);
  }
  return out;
}

/**
 * Equirectangular-like projection onto a 2D SVG viewport. Returns a point
 * {x, y} inside a virtual circle of radius = min(width, height) / 2 centered
 * at (cx, cy). lat/lon are degrees. This is a *simple* orthographic front-on
 * projection so points near ±90 lat stay within the disc and longitude wraps
 * around visibly. To avoid ambiguity back-to-front we do a mild perspective:
 * z < 0 points are shrunk + dimmed so the user can see "the far side" nodes.
 */
export function projectSpherePoint(
  latDeg: number,
  lonDeg: number,
  cx: number,
  cy: number,
  radius: number,
): { x: number; y: number; z: number } {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const x = Math.cos(lat) * Math.sin(lon);
  const y = -Math.sin(lat);
  const z = Math.cos(lat) * Math.cos(lon); // front = +z
  return {
    x: cx + radius * x,
    y: cy + radius * y,
    z,
  };
}

/** Build a waypoint from a ring click. */
export function makeSphereWaypoint(
  lat: number,
  lon: number,
  dolly = 1,
  x = 0,
  y = 0,
  z = 0,
  lookX = 0,
  lookY = 0,
  lookZ = 0,
): SphereWaypoint {
  const id = `wp_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
  return { id, lat, lon, dolly, x, y, z, lookX, lookY, lookZ };
}

/**
 * Catmull-Rom centripetal spline helper. Returns an interpolated point on the
 * closed/open polyline of points for parameter u ∈ [0, segments.length - 1].
 * `u` fractional index inside [i, i+1]. Works per-dimension.
 */
function catmullRom1D(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  return (
    (2 * p1 - 2 * p2 + v0 + v1) * t3 +
    (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 +
    v0 * t +
    p1
  );
}

/**
 * Shortest angular path for longitude (degrees) so we never wrap the long way
 * around the sphere.
 */
function shortestLonPath(values: number[]): number[] {
  const out = [values[0]];
  let current = values[0];
  for (let i = 1; i < values.length; i++) {
    let delta = values[i] - current;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    current += delta;
    out.push(current);
  }
  return out;
}

/**
 * Evaluate a user waypoint sequence into a camera rig at normalized
 * progress u ∈ [0, 1]. If there are fewer than 2 waypoints we just park at
 * that single point so the user still sees the orientation update live as
 * they click single ring nodes.
 */
export function evaluateCustomTrajectory(
  waypoints: readonly SphereWaypoint[],
  u: number,
  loop: boolean,
): CameraRig {
  const n = waypoints.length;
  if (n === 0) return DEFAULT_CAMERA;
  if (n === 1) {
    return rigFromSpherePoint(waypoints[0]);
  }
  const pts = loop ? [...waypoints, waypoints[0]] : waypoints;
  const latitudes = pts.map((p) => p.lat);
  const longitudesRaw = pts.map((p) => p.lon);
  const longitudes = shortestLonPath(longitudesRaw);
  const dollies = pts.map((p) => p.dolly);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const zs = pts.map((p) => p.z);
  const lxs = pts.map((p) => p.lookX);
  const lys = pts.map((p) => p.lookY);
  const lzs = pts.map((p) => p.lookZ);

  const segments = pts.length - 1;
  const idx = Math.min(segments - 1, Math.floor(u * segments));
  const t = Math.min(1, Math.max(0, u * segments - idx));

  const getSafe = (arr: number[], i: number): number =>
    arr[((i % arr.length) + arr.length) % arr.length];

  const lat = catmullRom1D(
    getSafe(latitudes, idx - 1),
    getSafe(latitudes, idx),
    getSafe(latitudes, idx + 1),
    getSafe(latitudes, idx + 2),
    t,
  );
  const lon = catmullRom1D(
    getSafe(longitudes, idx - 1),
    getSafe(longitudes, idx),
    getSafe(longitudes, idx + 1),
    getSafe(longitudes, idx + 2),
    t,
  );
  const dolly = catmullRom1D(
    getSafe(dollies, idx - 1),
    getSafe(dollies, idx),
    getSafe(dollies, idx + 1),
    getSafe(dollies, idx + 2),
    t,
  );
  const x = catmullRom1D(
    getSafe(xs, idx - 1), getSafe(xs, idx), getSafe(xs, idx + 1), getSafe(xs, idx + 2), t,
  );
  const y = catmullRom1D(
    getSafe(ys, idx - 1), getSafe(ys, idx), getSafe(ys, idx + 1), getSafe(ys, idx + 2), t,
  );
  const z = catmullRom1D(
    getSafe(zs, idx - 1), getSafe(zs, idx), getSafe(zs, idx + 1), getSafe(zs, idx + 2), t,
  );
  const lookX = catmullRom1D(
    getSafe(lxs, idx - 1), getSafe(lxs, idx), getSafe(lxs, idx + 1), getSafe(lxs, idx + 2), t,
  );
  const lookY = catmullRom1D(
    getSafe(lys, idx - 1), getSafe(lys, idx), getSafe(lys, idx + 1), getSafe(lys, idx + 2), t,
  );
  const lookZ = catmullRom1D(
    getSafe(lzs, idx - 1), getSafe(lzs, idx), getSafe(lzs, idx + 1), getSafe(lzs, idx + 2), t,
  );
  return rigFromSpherePoint({ id: '_interp', lat, lon, dolly, x, y, z, lookX, lookY, lookZ });
}

export function rigFromSpherePoint(wp: SphereWaypoint): CameraRig {
  return {
    orbitX: -wp.lat + wp.lookX,       // sphere pitch + extra look pitch
    orbitY: wp.lon + wp.lookY,         // sphere yaw + extra look yaw
    orbitZ: wp.lookZ,                  // roll from look
    dolly: wp.dolly,
    panX: wp.x * SPHERE_PAN_SCALE,
    panY: -wp.y * SPHERE_PAN_SCALE,    // y axis flip (SVG down → 3D up)
    z: wp.z * SPHERE_DEPTH_SCALE,
    perspective: 1150,
  };
}

/* ---------- Custom walk-through trajectory ---------- */

export const WALK_TRAJECTORY_ID = 'custom-walk';
export const WALK_TRAJECTORY_LABEL = 'Walk Path';

/** Pan scale: maps normalized position [-2, 2] to pixel offset. */
const WALK_PAN_SCALE = 500;
/** Depth scale: maps normalized z [-2, 2] to pixel translateZ. */
const WALK_DEPTH_SCALE = 900;

/**
 * A 3D walk waypoint: the camera position in a virtual cube (x = left/right,
 * y = up/down, z = forward/backward through the scene) plus a look direction
 * (pitch/yaw/roll) and zoom. The text itself never moves — only the camera
 * container moves and rotates in 3D, making the text *appear* to shift.
 *
 * z > 0 = camera pushes forward into the scene (text gets closer / bigger
 *         via perspective).
 * z < 0 = camera pulls back.
 */
export interface WalkWaypoint {
  id: string;
  /** -1..1, normalized horizontal position (left ↔ right). */
  x: number;
  /** -1..1, normalized vertical position (down ↔ up). */
  y: number;
  /** -1..1, normalized depth (back ↔ front / into the scene). */
  z: number;
  /** deg, pitch: + = look up, - = look down. Range -45..45. */
  lookX: number;
  /** deg, yaw: + = look right, - = look left. Range -45..45. */
  lookY: number;
  /** deg, roll: + = clockwise tilt. Range -15..15. */
  lookZ: number;
  /** 0.6..1.7 — zoom level at this waypoint. */
  dolly: number;
}

export function makeWalkWaypoint(
  x: number,
  y: number,
  z = 0,
  lookX = 0,
  lookY = 0,
  lookZ = 0,
  dolly = 1,
): WalkWaypoint {
  const id = `wk_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
  return { id, x, y, z, lookX, lookY, lookZ, dolly };
}

function rigFromWalkPoint(wp: WalkWaypoint): CameraRig {
  return {
    orbitX: wp.lookX,
    orbitY: wp.lookY,
    orbitZ: wp.lookZ,
    dolly: wp.dolly,
    panX: wp.x * WALK_PAN_SCALE,
    panY: -wp.y * WALK_PAN_SCALE, // SVG y is down, 3D y is up → flip
    z: wp.z * WALK_DEPTH_SCALE,
    perspective: 1150,
  };
}

/**
 * Evaluate a 3D walk-through waypoint sequence into a camera rig at normalized
 * progress u ∈ [0, 1]. Uses Catmull-Rom interpolation across all dimensions
 * (position x/y/z, look angles, dolly) for smooth camera movement through 3D space.
 */
export function evaluateWalkTrajectory(
  waypoints: readonly WalkWaypoint[],
  u: number,
  loop: boolean,
): CameraRig {
  const n = waypoints.length;
  if (n === 0) return DEFAULT_CAMERA;
  if (n === 1) return rigFromWalkPoint(waypoints[0]);

  const pts = loop ? [...waypoints, waypoints[0]] : waypoints;
  const segments = pts.length - 1;
  const idx = Math.min(segments - 1, Math.floor(u * segments));
  const t = Math.min(1, Math.max(0, u * segments - idx));

  const getSafe = (arr: number[], i: number): number =>
    arr[((i % arr.length) + arr.length) % arr.length];

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const zs = pts.map((p) => p.z);
  const lxs = pts.map((p) => p.lookX);
  const lys = pts.map((p) => p.lookY);
  const lzs = pts.map((p) => p.lookZ);
  const dollies = pts.map((p) => p.dolly);

  const x = catmullRom1D(getSafe(xs, idx - 1), getSafe(xs, idx), getSafe(xs, idx + 1), getSafe(xs, idx + 2), t);
  const y = catmullRom1D(getSafe(ys, idx - 1), getSafe(ys, idx), getSafe(ys, idx + 1), getSafe(ys, idx + 2), t);
  const z = catmullRom1D(getSafe(zs, idx - 1), getSafe(zs, idx), getSafe(zs, idx + 1), getSafe(zs, idx + 2), t);
  const lookX = catmullRom1D(getSafe(lxs, idx - 1), getSafe(lxs, idx), getSafe(lxs, idx + 1), getSafe(lxs, idx + 2), t);
  const lookY = catmullRom1D(getSafe(lys, idx - 1), getSafe(lys, idx), getSafe(lys, idx + 1), getSafe(lys, idx + 2), t);
  const lookZ = catmullRom1D(getSafe(lzs, idx - 1), getSafe(lzs, idx), getSafe(lzs, idx + 1), getSafe(lzs, idx + 2), t);
  const dolly = catmullRom1D(getSafe(dollies, idx - 1), getSafe(dollies, idx), getSafe(dollies, idx + 1), getSafe(dollies, idx + 2), t);

  return rigFromWalkPoint({ id: '_interp', x, y, z, lookX, lookY, lookZ, dolly });
}

export const ease: Record<string, EasingFn> = {
  linear: (t) => t,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inOutCubic: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

/* ========== Handheld Shake ========== */

export interface HandheldSettings {
  /** 0 - 100 — overall amplitude of the wobble. */
  strength: number;
  /** 0 - 100 — frequency multiplier. 50 = 1x normal speed, 100 = 2x fast, 0 = near frozen. */
  frequency: number;
}

export const DEFAULT_HANDHELD: HandheldSettings = {
  strength: 50,
  frequency: 50,
};

/** Hashed pseudo-random in [-1, 1], deterministic per integer key. */
function hashNoise(key: number): number {
  let x = (key * 2654435761) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return (x % 1000000) / 500000 - 1;
}

/** Smooth interpolated noise — continuous, no per-frame jumps. */
function smoothNoise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hashNoise(i);
  const b = hashNoise(i + 1);
  const s = f * f * (3 - 2 * f);
  return a * (1 - s) + b * s;
}

/**
 * Fractal Brownian motion (fBm): stack multiple octaves of smoothNoise.
 * Gives organic, natural-looking noise — like Perlin but cheaper.
 * Each octave doubles frequency and halves amplitude.
 */
function fbm(t: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    sum += smoothNoise(t * freq + i * 37.3) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / max;
}

/**
 * Natural handheld camera simulation using fBm noise:
 *
 *   Layer 1 — Low-frequency drift (~0.3 Hz): breathing + body sway.
 *   Layer 2 — Mid-frequency wobble (~2-5 Hz): arm/hand movement.
 *   Layer 3 — High-frequency tremor (~8-16 Hz): muscle jitter.
 *
 * All layers use fbm() (smooth, continuous noise) — NO raw step noise.
 * Real cameras have mass and inertia, so even high-frequency shake
 * is continuous, not per-frame teleporting.
 *
 * Additional naturalness:
 *   - Axis correlation: rotation Y feeds into pan X (tilt right → drift right)
 *   - Axis correlation: rotation X feeds into pan Y (tilt up → drift up)
 *   - Spring-back: sin-based base keeps camera returning to center
 *
 * `strength` (0..100): overall amplitude.
 * `frequency` (0..100): time multiplier. 50 = 1x, 100 = 2x, 0 = frozen.
 */
export function evaluateHandheld(
  ms: number,
  settings: HandheldSettings,
): CameraRig {
  const strength = Math.max(0, Math.min(100, settings.strength));
  const frequency = Math.max(0, Math.min(100, settings.frequency));
  if (strength <= 0) return { ...DEFAULT_CAMERA };

  const k = strength / 100;
  const freqMult = frequency / 50;
  const t = (ms / 1000) * freqMult;

  // ===== Layer 1: Breathing / slow body sway (0.2 - 0.5 Hz) =====
  // fBm with 2 octaves for organic drift
  const L1_n1 = fbm(t * 0.3, 2);
  const L1_n2 = fbm(t * 0.37 + 100, 2);
  const L1_n3 = fbm(t * 0.23 + 200, 2);
  const L1_panX = L1_n1 * 14.0;
  const L1_panY = L1_n2 * 12.0;
  const L1_rotY = L1_n1 * 3.5;   // correlated with panX
  const L1_rotX = L1_n2 * 2.5;   // correlated with panY
  const L1_rotZ = L1_n3 * 1.2;
  const L1_dolly = L1_n3 * 0.02;
  const L1_z = L1_n3 * 40.0;

  // ===== Layer 2: Mid-frequency hand wobble (1.5 - 5 Hz) =====
  // fBm with 3 octaves for richer texture
  const L2_n1 = fbm(t * 2.5, 3);
  const L2_n2 = fbm(t * 3.1 + 50, 3);
  const L2_n3 = fbm(t * 2.8 + 150, 3);
  const L2_panX = L2_n1 * 9.0;
  const L2_panY = L2_n2 * 8.0;
  const L2_rotY = L2_n1 * 4.0;   // correlated with panX
  const L2_rotX = L2_n2 * 3.0;   // correlated with panY
  const L2_rotZ = L2_n3 * 2.0;
  const L2_dolly = L2_n3 * 0.02;
  const L2_z = L2_n3 * 5.0;

  // ===== Layer 3: High-frequency tremor (8 - 16 Hz) =====
  // fBm with 4 octaves — smooth but detailed, like real muscle tremor
  const L3_n1 = fbm(t * 12, 4);
  const L3_n2 = fbm(t * 14 + 300, 4);
  const L3_n3 = fbm(t * 10 + 400, 4);
  const L3_panX = L3_n1 * 4.0;
  const L3_panY = L3_n2 * 3.5;
  const L3_rotY = L3_n1 * 2.5;
  const L3_rotX = L3_n2 * 2.0;
  const L3_rotZ = L3_n3 * 1.0;
  const L3_dolly = L3_n3 * 0.008;
  const L3_z = L3_n3 * 3.0;

  // ===== Combine with axis correlation =====
  // Rotation naturally causes pan drift (camera tilts → view shifts)
  const rotX = L1_rotX + L2_rotX + L3_rotX;
  const rotY = L1_rotY + L2_rotY + L3_rotY;
  const rotZ = L1_rotZ + L2_rotZ + L3_rotZ;
  const panX = L1_panX + L2_panX + L3_panX + rotY * 1.5;  // tilt → drift
  const panY = L1_panY + L2_panY + L3_panY + rotX * 1.5;
  const dollyDelta = L1_dolly + L2_dolly + L3_dolly;
  const z = L1_z + L2_z + L3_z;

  return {
    orbitX: rotX * k,
    orbitY: rotY * k,
    orbitZ: rotZ * k,
    dolly: 1 + dollyDelta * k,
    panX: panX * k,
    panY: panY * k,
    z: z * k,
    perspective: 1300,
  };
}

/* ========== Rig composition ========== */

/**
 * Combine a *base rig* (from trajectory / Sphere Custom / idle) with a
 * *handheld delta rig*. Rotations sum in deg, pans sum in px, dolly multiplies
 * so dolly=1 in handheld leaves base untouched. Perspective falls back to the
 * non-default value when only one side provides one.
 */
export function composeRigs(base: CameraRig, handheld: CameraRig): CameraRig {
  return {
    orbitX: base.orbitX + handheld.orbitX,
    orbitY: base.orbitY + handheld.orbitY,
    orbitZ: base.orbitZ + handheld.orbitZ,
    dolly: base.dolly * handheld.dolly,
    panX: base.panX + handheld.panX,
    panY: base.panY + handheld.panY,
    z: base.z + handheld.z,
    perspective:
      base.perspective !== 1200 ? base.perspective : handheld.perspective,
  };
}

/* -------------- Trajectory library -------------- */
// NOTE: User narrowed Camera Motion to a single preset (Handheld Shake).
// All built-in presets have been removed from the UI; Handheld is now its
// own independently toggled + composed layer above the Sphere Custom player.
export const CAMERA_TRAJECTORIES: {
  id: string;
  label: string;
  durationMs: number;
}[] = [];

export type CameraTrajectory = {
  id: string;
  label: string;
  durationMs: number;
};

/* -------------- Animation driver hook -------------- */

const SPHERE_DURATION_MIN = 3000;
const SPHERE_DURATION_PER_WP = 1600;
const WALK_DURATION_MIN = 3000;
const WALK_DURATION_PER_WP = 1800;

export function sphereDurationMs(n: number): number {
  return n <= 1 ? 1000 : Math.max(SPHERE_DURATION_MIN, n * SPHERE_DURATION_PER_WP);
}
export function walkDurationMs(n: number): number {
  return n <= 1 ? 1000 : Math.max(WALK_DURATION_MIN, n * WALK_DURATION_PER_WP);
}

export interface CameraPlayerState {
  // Legacy single-track fields — kept for back-compat with current consumers.
  // - trajectoryId: currently focused track (CUSTOM_TRAJECTORY_ID / WALK_TRAJECTORY_ID / null).
  //   Used by the UI to know which editor's progress bar to highlight; no longer
  //   the sole "which motion is playing" flag.
  // - playing: true if EITHER track is playing (back-compat boolean).
  // - progress: the active-trajectory progress (for legacy UI components).
  trajectoryId: string | null;
  playing: boolean;
  loop: boolean;
  speed: number; // 0.25x .. 4x (shared — sphere + walk use the same speed knob)
  progress: number;
  /** Legacy combined trajectory rig — kept for consumers that read state.trajectoryRig
   *  (equals walk ⊕ sphere; walk treated as base because it provides pan/z/dolly).
   *  New code should read state.sphereRig + state.walkRig individually. */
  trajectoryRig: CameraRig;

  // ---- Dual independent tracks ----
  /** Sphere Custom (rotations only) — when there are waypoints. */
  sphereRig: CameraRig;
  spherePlaying: boolean;
  sphereProgress: number; // 0..1
  /** Walk Path (pan + z + dolly + rotations) — when there are waypoints. */
  walkRig: CameraRig;
  walkPlaying: boolean;
  walkProgress: number; // 0..1

  /** Handheld status + settings (independent toggled layer). */
  handheldEnabled: boolean;
  handheldPlaying: boolean;
  handheldSettings: HandheldSettings;
  /** Handheld absolute clock (ms) — kept across enable/disable for continuity. */
  handheldTimeMs: number;
  /** Snapshot of the handheld layer evaluated at handheldTimeMs. */
  handheldRig: CameraRig;
  /** finalRig = combine(walkRig, sphereRig, handheldRig) — what PreviewCanvas uses. */
  rig: CameraRig;
  customWaypoints: SphereWaypoint[];
  customCloseLoop: boolean;
  /** Walk-through trajectory waypoints (independent from sphere). */
  walkWaypoints: WalkWaypoint[];
  walkCloseLoop: boolean;
  /** Currently focused walk waypoint — when set, preview shows this exact waypoint's camera rig. */
  selectedWalkWaypointId: string | null;
  /** Currently focused sphere waypoint — when set, preview shows this exact waypoint's camera rig. */
  selectedSphereWaypointId: string | null;
}

/**
 * Walk (pan + z + dolly + look-angles) is the "base" camera; Sphere Custom
 * (orbit rotation around Headline) is an additive overlay. Handheld noise sits
 * on top. So the final camera rig = handheld(compose(sphere(compose(walk, id))))
 * which is equivalent to:
 *   orbit  = walk.orbit  + sphere.orbit  + handheld.orbit
 *   pan    = walk.pan    + sphere.pan    + handheld.pan   (sphere.pan is 0 today
 *                                                         but kept for generality)
 *   z      = walk.z      + sphere.z      + handheld.z     (sphere.z 0 today)
 *   dolly  = walk.dolly  × sphere.dolly  × handheld.dolly (sphere.dolly 1 today)
 *   persp  = walk.persp if non-default, else sphere.persp if non-default, else HH
 */
function combineFinalRig(
  walkRig: CameraRig,
  sphereRig: CameraRig,
  handheldEnabled: boolean,
  handheldRig: CameraRig,
): CameraRig {
  const withSphere = composeRigs(walkRig, sphereRig);
  return handheldEnabled ? composeRigs(withSphere, handheldRig) : withSphere;
}

function combineTrajectoryRig(
  walkRig: CameraRig,
  sphereRig: CameraRig,
): CameraRig {
  return composeRigs(walkRig, sphereRig);
}

export function useCameraPlayer() {
  const [state, setState] = useState<CameraPlayerState>(() => {
    const hhRig = evaluateHandheld(0, DEFAULT_HANDHELD);
    const sphereRig = { ...DEFAULT_CAMERA };
    const walkRig = { ...DEFAULT_CAMERA };
    const trajRig = combineTrajectoryRig(walkRig, sphereRig);
    return {
      trajectoryId: null,
      playing: false,
      loop: true,
      speed: 1,
      progress: 0,
      trajectoryRig: trajRig,
      sphereRig,
      spherePlaying: false,
      sphereProgress: 0,
      walkRig,
      walkPlaying: false,
      walkProgress: 0,
      handheldEnabled: false,
      handheldPlaying: false,
      handheldSettings: { ...DEFAULT_HANDHELD },
      handheldTimeMs: 0,
      handheldRig: hhRig,
      rig: combineFinalRig(walkRig, sphereRig, false, hhRig),
      customWaypoints: [],
      customCloseLoop: true,
      walkWaypoints: [],
      walkCloseLoop: true,
      selectedWalkWaypointId: null,
      selectedSphereWaypointId: null,
    };
  });

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const sphereElapsedRef = useRef<number>(0);
  const walkElapsedRef = useRef<number>(0);
  const hhElapsedRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const cancel = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const needLoop = useCallback((): boolean => {
    const s = stateRef.current;
    if (s.spherePlaying) return true;
    if (s.walkPlaying) return true;
    if (s.handheldEnabled && s.handheldPlaying) return true;
    return false;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const prev = stateRef.current;
      if (
        !prev.spherePlaying &&
        !prev.walkPlaying &&
        !prev.handheldPlaying
      ) {
        rafRef.current = null;
        return;
      }

      if (!startRef.current) startRef.current = now;
      const dt = now - startRef.current;
      startRef.current = now;
      const speed = Math.max(0.25, prev.speed);

      // --- Advance sphere clock ---
      let sphereElapsed = sphereElapsedRef.current;
      let nextSphereProgress = prev.sphereProgress;
      let sphereShouldStop = false;
      if (prev.spherePlaying && prev.customWaypoints.length > 0) {
        const dtTraj = dt * speed;
        sphereElapsed += dtTraj;
        const n = prev.customWaypoints.length;
        const duration = sphereDurationMs(n);
        const loopable = prev.customCloseLoop || n >= 2;
        let t = sphereElapsed / duration;
        if (t >= 1) {
          if (prev.loop && loopable) {
            const wrapT = t - Math.floor(t);
            sphereElapsed = wrapT * duration;
            nextSphereProgress = wrapT;
          } else {
            nextSphereProgress = 1;
            sphereElapsed = duration;
            sphereShouldStop = true;
          }
        } else {
          nextSphereProgress = t;
        }
      }

      // --- Advance walk clock (INDEPENDENT from sphere) ---
      let walkElapsed = walkElapsedRef.current;
      let nextWalkProgress = prev.walkProgress;
      let walkShouldStop = false;
      if (prev.walkPlaying && prev.walkWaypoints.length > 0) {
        const dtTraj = dt * speed;
        walkElapsed += dtTraj;
        const n = prev.walkWaypoints.length;
        const duration = walkDurationMs(n);
        const loopable = prev.walkCloseLoop || n >= 2;
        let t = walkElapsed / duration;
        if (t >= 1) {
          if (prev.loop && loopable) {
            const wrapT = t - Math.floor(t);
            walkElapsed = wrapT * duration;
            nextWalkProgress = wrapT;
          } else {
            nextWalkProgress = 1;
            walkElapsed = duration;
            walkShouldStop = true;
          }
        } else {
          nextWalkProgress = t;
        }
      }

      // --- Advance handheld clock ---
      let hhElapsed = hhElapsedRef.current;
      if (prev.handheldEnabled && prev.handheldPlaying) hhElapsed += dt;
      const hhRig = prev.handheldEnabled
        ? evaluateHandheld(hhElapsed, prev.handheldSettings)
        : { ...DEFAULT_CAMERA };

      // --- Evaluate rigs ---
      // Waypoint-selection overrides take precedence over the playing progress.
      const selSphere = prev.selectedSphereWaypointId
        ? prev.customWaypoints.find((w) => w.id === prev.selectedSphereWaypointId)
        : null;
      const selWalk = prev.selectedWalkWaypointId
        ? prev.walkWaypoints.find((w) => w.id === prev.selectedWalkWaypointId)
        : null;
      const nextSphereRig =
        selSphere && !prev.spherePlaying
          ? rigFromSpherePoint(selSphere)
          : prev.customWaypoints.length > 0
          ? evaluateCustomTrajectory(
              prev.customWaypoints,
              Math.min(1, Math.max(0, nextSphereProgress)),
              prev.customCloseLoop,
            )
          : { ...DEFAULT_CAMERA };
      const nextWalkRig =
        selWalk && !prev.walkPlaying
          ? rigFromWalkPoint(selWalk)
          : prev.walkWaypoints.length > 0
          ? evaluateWalkTrajectory(
              prev.walkWaypoints,
              Math.min(1, Math.max(0, nextWalkProgress)),
              prev.walkCloseLoop,
            )
          : { ...DEFAULT_CAMERA };

      sphereElapsedRef.current = sphereElapsed;
      walkElapsedRef.current = walkElapsed;
      hhElapsedRef.current = hhElapsed;

      const nextTrajRig = combineTrajectoryRig(nextWalkRig, nextSphereRig);
      const finalRig = combineFinalRig(
        nextWalkRig,
        nextSphereRig,
        prev.handheldEnabled,
        hhRig,
      );

      // Focused progress follows whichever track is currently focused via
      // trajectoryId (or walk if both running, else sphere).
      const focusedProgress =
        prev.trajectoryId === CUSTOM_TRAJECTORY_ID
          ? nextSphereProgress
          : prev.trajectoryId === WALK_TRAJECTORY_ID
          ? nextWalkProgress
          : prev.walkPlaying
          ? nextWalkProgress
          : nextSphereProgress;

      const eitherPlaying =
        (prev.spherePlaying && !sphereShouldStop) ||
        (prev.walkPlaying && !walkShouldStop);

      setState((s) => ({
        ...s,
        sphereProgress: Math.min(1, Math.max(0, nextSphereProgress)),
        walkProgress: Math.min(1, Math.max(0, nextWalkProgress)),
        progress: Math.min(1, Math.max(0, focusedProgress)),
        sphereRig: nextSphereRig,
        walkRig: nextWalkRig,
        trajectoryRig: nextTrajRig,
        handheldTimeMs: hhElapsed,
        handheldRig: hhRig,
        rig: finalRig,
        spherePlaying: sphereShouldStop ? false : s.spherePlaying,
        walkPlaying: walkShouldStop ? false : s.walkPlaying,
        playing: eitherPlaying,
      }));

      if (
        !sphereShouldStop ||
        !walkShouldStop ||
        (prev.handheldEnabled && prev.handheldPlaying)
      ) {
        const keepGoing =
          (!sphereShouldStop && prev.spherePlaying) ||
          (!walkShouldStop && prev.walkPlaying) ||
          (prev.handheldEnabled && prev.handheldPlaying);
        if (keepGoing) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
      }
      rafRef.current = null;
    },
    [],
  );

  /* ---------- Handheld controls ---------- */

  const setHandheldEnabled = useCallback((enabled: boolean) => {
    setState((prev) => {
      // When turning on, also start playing so the wobble animates live.
      const playing = enabled ? prev.handheldPlaying || true : false;
      // Re-evaluate rig immediately so preview snaps on toggle.
      const hhRig = enabled
        ? evaluateHandheld(hhElapsedRef.current, prev.handheldSettings)
        : { ...DEFAULT_CAMERA };
      const rig = combineFinalRig(prev.walkRig, prev.sphereRig, enabled, hhRig);
      return {
        ...prev,
        handheldEnabled: enabled,
        handheldPlaying: playing,
        handheldRig: hhRig,
        rig,
      };
    });
  }, []);

  const toggleHandheld = useCallback(() => {
    setState((prev) => {
      const enabled = !prev.handheldEnabled;
      const playing = enabled ? true : false;
      const hhRig = enabled
        ? evaluateHandheld(hhElapsedRef.current, prev.handheldSettings)
        : { ...DEFAULT_CAMERA };
      const rig = combineFinalRig(prev.walkRig, prev.sphereRig, enabled, hhRig);
      return {
        ...prev,
        handheldEnabled: enabled,
        handheldPlaying: playing,
        handheldRig: hhRig,
        rig,
      };
    });
  }, []);

  const setHandheldIntensity = useCallback((strength: number) => {
    const clamped = Math.max(0, Math.min(100, strength));
    setState((prev) => {
      const settings = { ...prev.handheldSettings, strength: clamped };
      const hhRig = prev.handheldEnabled
        ? evaluateHandheld(hhElapsedRef.current, settings)
        : prev.handheldRig;
      return {
        ...prev,
        handheldSettings: settings,
        handheldRig: hhRig,
        rig: combineFinalRig(prev.walkRig, prev.sphereRig, prev.handheldEnabled, hhRig),
      };
    });
  }, []);

  const setHandheldFrequency = useCallback((frequency: number) => {
    const clamped = Math.max(0, Math.min(100, frequency));
    setState((prev) => {
      const settings = { ...prev.handheldSettings, frequency: clamped };
      const hhRig = prev.handheldEnabled
        ? evaluateHandheld(hhElapsedRef.current, settings)
        : prev.handheldRig;
      return {
        ...prev,
        handheldSettings: settings,
        handheldRig: hhRig,
        rig: combineFinalRig(prev.walkRig, prev.sphereRig, prev.handheldEnabled, hhRig),
      };
    });
  }, []);

  const pauseHandheld = useCallback(() => {
    setState((prev) => {
      if (!prev.handheldPlaying) return prev;
      return { ...prev, handheldPlaying: false };
    });
  }, []);

  const resumeHandheld = useCallback(() => {
    setState((prev) => {
      if (!prev.handheldEnabled) return prev;
      if (prev.handheldPlaying) return prev;
      return { ...prev, handheldPlaying: true };
    });
  }, []);

  /* ---------- Trajectory controls (dual-track: sphere + walk are INDEPENDENT) ---------- */

  /**
   * Generic "Play X" call. When a trajectoryId is provided:
   * - CUSTOM: starts (or restarts) the Sphere Custom track.
   * - WALK: starts (or restarts) the Walk Path track.
   * Calling both back-to-back (e.g. play(Sphere) then play(Walk)) is valid and
   * results in both tracks running simultaneously — their rigs are composed.
   * When called with NO argument: replay whichever track currently has focus via
   * `trajectoryId`; if both tracks have waypoints, replay the focused track
   * only (the other keeps its current state).
   */
  const play = useCallback((trajectoryId?: string) => {
    setState((prev) => {
      const focusId = trajectoryId ?? prev.trajectoryId;
      const wantSphere =
        focusId === CUSTOM_TRAJECTORY_ID || focusId == null
          ? prev.customWaypoints.length > 0
          : false;
      const wantWalk =
        focusId === WALK_TRAJECTORY_ID
          ? prev.walkWaypoints.length > 0
          : false;
      if (!wantSphere && !wantWalk) return prev;

      const nextSphereProgress = wantSphere ? 0 : prev.sphereProgress;
      const nextWalkProgress = wantWalk ? 0 : prev.walkProgress;
      if (wantSphere) sphereElapsedRef.current = 0;
      if (wantWalk) walkElapsedRef.current = 0;
      startRef.current = 0;

      const selSphere = prev.selectedSphereWaypointId
        ? prev.customWaypoints.find((w) => w.id === prev.selectedSphereWaypointId)
        : null;
      const selWalk = prev.selectedWalkWaypointId
        ? prev.walkWaypoints.find((w) => w.id === prev.selectedWalkWaypointId)
        : null;
      const nextSphereRig =
        wantSphere && selSphere && prev.spherePlaying === false
          ? rigFromSpherePoint(selSphere)
          : prev.customWaypoints.length > 0
          ? evaluateCustomTrajectory(
              prev.customWaypoints,
              nextSphereProgress,
              prev.customCloseLoop,
            )
          : { ...DEFAULT_CAMERA };
      const nextWalkRig =
        wantWalk && selWalk && prev.walkPlaying === false
          ? rigFromWalkPoint(selWalk)
          : prev.walkWaypoints.length > 0
          ? evaluateWalkTrajectory(
              prev.walkWaypoints,
              nextWalkProgress,
              prev.walkCloseLoop,
            )
          : { ...DEFAULT_CAMERA };

      const nextTrajRig = combineTrajectoryRig(nextWalkRig, nextSphereRig);
      const nextFocusId: string | null =
        focusId ?? (wantWalk ? WALK_TRAJECTORY_ID : CUSTOM_TRAJECTORY_ID);
      return {
        ...prev,
        trajectoryId: nextFocusId,
        spherePlaying: wantSphere ? true : prev.spherePlaying,
        walkPlaying: wantWalk ? true : prev.walkPlaying,
        playing:
          (wantSphere ? true : prev.spherePlaying) ||
          (wantWalk ? true : prev.walkPlaying),
        sphereProgress: nextSphereProgress,
        walkProgress: nextWalkProgress,
        progress:
          nextFocusId === WALK_TRAJECTORY_ID
            ? nextWalkProgress
            : nextSphereProgress,
        sphereRig: nextSphereRig,
        walkRig: nextWalkRig,
        trajectoryRig: nextTrajRig,
        selectedSphereWaypointId: wantSphere ? null : prev.selectedSphereWaypointId,
        selectedWalkWaypointId: wantWalk ? null : prev.selectedWalkWaypointId,
        rig: combineFinalRig(
          nextWalkRig,
          nextSphereRig,
          prev.handheldEnabled,
          prev.handheldRig,
        ),
      };
    });
  }, []);

  /**
   * Pause — behaviour:
   * If no trajectoryId given: pause exactly one track. If exactly one track
   * is playing, pause it. If both tracks are running, pause the one focused
   * by `trajectoryId`.
   * If an explicit trajectoryId (CUSTOM_TRAJECTORY_ID or WALK_TRAJECTORY_ID)
   * is given: pause ONLY that track (useful before export when you want to
   * preserve the state of the other track).
   */
  const pause = useCallback((trajectoryId?: string) => {
    setState((prev) => {
      if (!prev.spherePlaying && !prev.walkPlaying) return prev;
      if (trajectoryId === CUSTOM_TRAJECTORY_ID) {
        if (!prev.spherePlaying) return prev;
        return { ...prev, spherePlaying: false, playing: prev.walkPlaying };
      }
      if (trajectoryId === WALK_TRAJECTORY_ID) {
        if (!prev.walkPlaying) return prev;
        return { ...prev, walkPlaying: false, playing: prev.spherePlaying };
      }
      // No explicit id → single-track behaviour.
      if (prev.spherePlaying && !prev.walkPlaying) {
        return { ...prev, spherePlaying: false, playing: false };
      }
      if (prev.walkPlaying && !prev.spherePlaying) {
        return { ...prev, walkPlaying: false, playing: false };
      }
      // Both running — pause focused track only.
      if (prev.trajectoryId === CUSTOM_TRAJECTORY_ID) {
        return { ...prev, spherePlaying: false, playing: prev.walkPlaying };
      }
      if (prev.trajectoryId === WALK_TRAJECTORY_ID) {
        return { ...prev, walkPlaying: false, playing: prev.spherePlaying };
      }
      return { ...prev, spherePlaying: false, playing: prev.walkPlaying };
    });
  }, []);

  /** Soft-pause for global "Pause All Motion" — always pauses both tracks. */
  const softPause = useCallback(() => {
    setState((prev) => {
      if (
        !prev.spherePlaying &&
        !prev.walkPlaying &&
        !prev.handheldPlaying
      ) {
        return prev;
      }
      return {
        ...prev,
        spherePlaying: false,
        walkPlaying: false,
        playing: false,
        handheldPlaying: prev.handheldPlaying ? false : prev.handheldPlaying,
      };
    });
  }, []);

  const softResume = useCallback(() => {
    setState((prev) => {
      return {
        ...prev,
        spherePlaying: prev.customWaypoints.length > 0 ? true : prev.spherePlaying,
        walkPlaying: prev.walkWaypoints.length > 0 ? true : prev.walkPlaying,
        playing:
          (prev.customWaypoints.length > 0) ||
          (prev.walkWaypoints.length > 0),
        handheldPlaying: prev.handheldEnabled ? true : prev.handheldPlaying,
      };
    });
  }, []);

  const stop = useCallback(() => {
    sphereElapsedRef.current = 0;
    walkElapsedRef.current = 0;
    startRef.current = 0;
    setState((prev) => {
      const nextSphereRig =
        prev.customWaypoints.length > 0
          ? evaluateCustomTrajectory(prev.customWaypoints, 0, prev.customCloseLoop)
          : { ...DEFAULT_CAMERA };
      const nextWalkRig =
        prev.walkWaypoints.length > 0
          ? evaluateWalkTrajectory(prev.walkWaypoints, 0, prev.walkCloseLoop)
          : { ...DEFAULT_CAMERA };
      const nextTrajRig = combineTrajectoryRig(nextWalkRig, nextSphereRig);
      return {
        ...prev,
        spherePlaying: false,
        walkPlaying: false,
        playing: false,
        sphereProgress: 0,
        walkProgress: 0,
        progress: 0,
        trajectoryId: null,
        sphereRig: nextSphereRig,
        walkRig: nextWalkRig,
        trajectoryRig: nextTrajRig,
        rig: combineFinalRig(
          nextWalkRig,
          nextSphereRig,
          prev.handheldEnabled,
          prev.handheldRig,
        ),
      };
    });
  }, []);

  const reset = useCallback(() => {
    stop();
  }, [stop]);

  const setLoop = useCallback((loop: boolean) => {
    setState((prev) => ({ ...prev, loop }));
  }, []);

  const setSpeed = useCallback((speed: number) => {
    setState((prev) => ({ ...prev, speed }));
  }, []);

  /* ---------- Sphere waypoints ---------- */

  const setCustomWaypoints = useCallback(
    (waypoints: SphereWaypoint[]) => {
      setState((prev) => {
        const sel = prev.selectedSphereWaypointId
          ? waypoints.find((w) => w.id === prev.selectedSphereWaypointId)
          : null;
        let nextSphereRig = prev.sphereRig;
        if (waypoints.length === 0) {
          nextSphereRig = { ...DEFAULT_CAMERA };
        } else if (sel) {
          nextSphereRig = rigFromSpherePoint(sel);
        } else {
          nextSphereRig = evaluateCustomTrajectory(
            waypoints,
            Math.min(1, Math.max(0, prev.sphereProgress)),
            prev.customCloseLoop,
          );
        }
        const nextTrajRig = combineTrajectoryRig(prev.walkRig, nextSphereRig);
        // When sphere waypoints exist, default focused track to sphere — but
        // never override a running Walk track.
        const keepFocusWalk = prev.trajectoryId === WALK_TRAJECTORY_ID && prev.walkWaypoints.length > 0;
        const nextFocusId = keepFocusWalk
          ? prev.trajectoryId
          : waypoints.length > 0
          ? CUSTOM_TRAJECTORY_ID
          : prev.walkWaypoints.length > 0
          ? prev.trajectoryId
          : null;
        return {
          ...prev,
          customWaypoints: waypoints,
          sphereRig: nextSphereRig,
          trajectoryRig: nextTrajRig,
          trajectoryId: nextFocusId,
          sphereProgress: prev.spherePlaying
            ? prev.sphereProgress
            : waypoints.length
            ? prev.sphereProgress
            : 0,
          rig: combineFinalRig(
            prev.walkRig,
            nextSphereRig,
            prev.handheldEnabled,
            prev.handheldRig,
          ),
        };
      });
    },
    [],
  );

  const setCustomCloseLoop = useCallback((closed: boolean) => {
    setState((prev) => ({ ...prev, customCloseLoop: closed }));
  }, []);

  /** Focus a specific sphere waypoint — snaps preview to its exact camera rig. */
  const selectSphereWaypoint = useCallback((id: string | null) => {
    setState((prev) => {
      if (!id) return { ...prev, selectedSphereWaypointId: null };
      const wp = prev.customWaypoints.find((w) => w.id === id);
      if (!wp) return prev;
      const nextSphereRig = rigFromSpherePoint(wp);
      const nextTrajRig = combineTrajectoryRig(prev.walkRig, nextSphereRig);
      return {
        ...prev,
        selectedSphereWaypointId: id,
        // Don't disturb walk — it can keep running in the background.
        spherePlaying: false,
        trajectoryId: CUSTOM_TRAJECTORY_ID,
        sphereRig: nextSphereRig,
        trajectoryRig: nextTrajRig,
        rig: combineFinalRig(
          prev.walkRig,
          nextSphereRig,
          prev.handheldEnabled,
          prev.handheldRig,
        ),
      };
    });
  }, []);

  /* ---------- Walk waypoints ---------- */

  const setWalkWaypoints = useCallback(
    (waypoints: WalkWaypoint[]) => {
      setState((prev) => {
        const sel = prev.selectedWalkWaypointId
          ? waypoints.find((w) => w.id === prev.selectedWalkWaypointId)
          : null;
        let nextWalkRig = prev.walkRig;
        if (waypoints.length === 0) {
          nextWalkRig = { ...DEFAULT_CAMERA };
        } else if (sel) {
          nextWalkRig = rigFromWalkPoint(sel);
        } else {
          nextWalkRig = evaluateWalkTrajectory(
            waypoints,
            Math.min(1, Math.max(0, prev.walkProgress)),
            prev.walkCloseLoop,
          );
        }
        const nextTrajRig = combineTrajectoryRig(nextWalkRig, prev.sphereRig);
        // Walk gets focus when there are walk waypoints — unless sphere is the
        // active track (e.g. user is currently tuning Sphere Custom nodes).
        const keepFocusSphere = prev.trajectoryId === CUSTOM_TRAJECTORY_ID && prev.customWaypoints.length > 0;
        const nextFocusId = keepFocusSphere
          ? prev.trajectoryId
          : waypoints.length > 0
          ? WALK_TRAJECTORY_ID
          : prev.customWaypoints.length > 0
          ? prev.trajectoryId
          : null;
        return {
          ...prev,
          walkWaypoints: waypoints,
          walkRig: nextWalkRig,
          trajectoryRig: nextTrajRig,
          trajectoryId: nextFocusId,
          walkProgress: prev.walkPlaying
            ? prev.walkProgress
            : waypoints.length
            ? prev.walkProgress
            : 0,
          rig: combineFinalRig(
            nextWalkRig,
            prev.sphereRig,
            prev.handheldEnabled,
            prev.handheldRig,
          ),
        };
      });
    },
    [],
  );

  const setWalkCloseLoop = useCallback((closed: boolean) => {
    setState((prev) => ({ ...prev, walkCloseLoop: closed }));
  }, []);

  /** Focus a specific walk waypoint — snaps preview to its exact camera rig. */
  const selectWalkWaypoint = useCallback((id: string | null) => {
    setState((prev) => {
      if (!id) return { ...prev, selectedWalkWaypointId: null };
      const wp = prev.walkWaypoints.find((w) => w.id === id);
      if (!wp) return prev;
      const nextWalkRig = rigFromWalkPoint(wp);
      const nextTrajRig = combineTrajectoryRig(nextWalkRig, prev.sphereRig);
      return {
        ...prev,
        selectedWalkWaypointId: id,
        walkPlaying: false,
        trajectoryId: WALK_TRAJECTORY_ID,
        walkRig: nextWalkRig,
        trajectoryRig: nextTrajRig,
        rig: combineFinalRig(
          nextWalkRig,
          prev.sphereRig,
          prev.handheldEnabled,
          prev.handheldRig,
        ),
      };
    });
  }, []);

  const playCustomWalk = useCallback(() => {
    setState((prev) => {
      if (prev.walkWaypoints.length === 0) return prev;
      walkElapsedRef.current = 0;
      startRef.current = 0;
      const nextWalkRig = evaluateWalkTrajectory(
        prev.walkWaypoints,
        0,
        prev.walkCloseLoop,
      );
      const nextTrajRig = combineTrajectoryRig(nextWalkRig, prev.sphereRig);
      return {
        ...prev,
        trajectoryId: WALK_TRAJECTORY_ID,
        walkPlaying: true,
        spherePlaying: prev.spherePlaying, // leave sphere untouched
        playing: true || prev.spherePlaying,
        walkProgress: 0,
        selectedWalkWaypointId: null,
        walkRig: nextWalkRig,
        trajectoryRig: nextTrajRig,
        rig: combineFinalRig(
          nextWalkRig,
          prev.sphereRig,
          prev.handheldEnabled,
          prev.handheldRig,
        ),
      };
    });
  }, []);

  /* ---------- Snapshot restore (for undo) ---------- */
  const restorePlayerSnapshot = useCallback(
    (
      trajectoryId: string | null,
      playing: boolean,
      progress: number,
      handheldEnabled?: boolean,
      handheldPlaying?: boolean,
      handheldTimeMs?: number,
      handheldSettings?: HandheldSettings,
      walkWaypoints?: WalkWaypoint[],
      walkCloseLoop?: boolean,
      // Dual-track source-of-truth (new in dual-track snapshots). When
      // provided they override the legacy single trajectoryId/playing/progress
      // fields for the focused track. Pass them as named trailing params so
      // old snapshots (that only pass 9 positional args) remain compatible.
      spherePlaying?: boolean,
      sphereProgress?: number,
      walkPlaying?: boolean,
      walkProgress?: number,
    ) => {
      setState((prev) => {
        const clampedProgress = Math.min(1, Math.max(0, progress));
        const nextWalkWp = walkWaypoints ?? prev.walkWaypoints;
        const nextWalkLoop = walkCloseLoop ?? prev.walkCloseLoop;

        // ---- Decide next per-track play/progress ----
        // Priority 1: new dual-track fields.
        // Priority 2: legacy focusedId + playing/progress fallbacks.
        const focusedId = trajectoryId;
        const sphereIsFocused = focusedId === CUSTOM_TRAJECTORY_ID;
        const walkIsFocused = focusedId === WALK_TRAJECTORY_ID;

        const nextSphereProgress =
          sphereProgress !== undefined
            ? Math.min(1, Math.max(0, sphereProgress))
            : sphereIsFocused
            ? clampedProgress
            : 0;
        const nextWalkProgress =
          walkProgress !== undefined
            ? Math.min(1, Math.max(0, walkProgress))
            : walkIsFocused
            ? clampedProgress
            : 0;

        const rawNextSpherePlaying =
          spherePlaying !== undefined
            ? spherePlaying
            : sphereIsFocused && playing;
        const rawNextWalkPlaying =
          walkPlaying !== undefined
            ? walkPlaying
            : walkIsFocused && playing;

        const nextSpherePlaying =
          rawNextSpherePlaying && prev.customWaypoints.length > 0;
        const nextWalkPlaying = rawNextWalkPlaying && nextWalkWp.length > 0;

        const selSphere = nextSpherePlaying
          ? null
          : prev.selectedSphereWaypointId
          ? prev.customWaypoints.find((w) => w.id === prev.selectedSphereWaypointId)
          : null;
        const selWalk = nextWalkPlaying
          ? null
          : prev.selectedWalkWaypointId
          ? nextWalkWp.find((w) => w.id === prev.selectedWalkWaypointId)
          : null;
        const nextSphereRig =
          selSphere && !nextSpherePlaying
            ? rigFromSpherePoint(selSphere)
            : prev.customWaypoints.length > 0
            ? evaluateCustomTrajectory(
                prev.customWaypoints,
                nextSphereProgress,
                prev.customCloseLoop,
              )
            : { ...DEFAULT_CAMERA };
        const nextWalkRig =
          selWalk && !nextWalkPlaying
            ? rigFromWalkPoint(selWalk)
            : nextWalkWp.length > 0
            ? evaluateWalkTrajectory(
                nextWalkWp,
                nextWalkProgress,
                nextWalkLoop,
              )
            : { ...DEFAULT_CAMERA };

        // Restore per-track elapsed clocks based on focused progress.
        sphereElapsedRef.current =
          nextSpherePlaying || nextSphereProgress > 0
            ? nextSphereProgress * sphereDurationMs(prev.customWaypoints.length)
            : 0;
        walkElapsedRef.current =
          nextWalkPlaying || nextWalkProgress > 0
            ? nextWalkProgress * walkDurationMs(nextWalkWp.length)
            : 0;

        const nextHHEnabled = handheldEnabled ?? prev.handheldEnabled;
        const nextHHPlaying = handheldPlaying ?? prev.handheldPlaying;
        const nextHHSettings = handheldSettings ?? prev.handheldSettings;
        const nextHHTime = handheldTimeMs ?? prev.handheldTimeMs;
        hhElapsedRef.current = nextHHTime;
        const hhRig = nextHHEnabled
          ? evaluateHandheld(nextHHTime, nextHHSettings)
          : { ...DEFAULT_CAMERA };

        const nextTrajRig = combineTrajectoryRig(nextWalkRig, nextSphereRig);
        const focusProgress =
          focusedId === WALK_TRAJECTORY_ID
            ? nextWalkProgress
            : focusedId === CUSTOM_TRAJECTORY_ID
            ? nextSphereProgress
            : 0;
        // If caller didn't pick a focused id but we have dual-play state,
        // preserve any existing focused id to keep UI state stable.
        const nextFocusedId =
          focusedId ??
          (nextSpherePlaying && nextWalkPlaying
            ? prev.trajectoryId
            : nextWalkPlaying
            ? WALK_TRAJECTORY_ID
            : nextSpherePlaying
            ? CUSTOM_TRAJECTORY_ID
            : null);
        return {
          ...prev,
          trajectoryId: nextFocusedId,
          spherePlaying: nextSpherePlaying,
          walkPlaying: nextWalkPlaying,
          playing: nextSpherePlaying || nextWalkPlaying,
          sphereProgress: nextSphereProgress,
          walkProgress: nextWalkProgress,
          progress: focusProgress,
          sphereRig: nextSphereRig,
          walkRig: nextWalkRig,
          trajectoryRig: nextTrajRig,
          walkWaypoints: nextWalkWp,
          walkCloseLoop: nextWalkLoop,
          handheldEnabled: nextHHEnabled,
          handheldPlaying: nextHHPlaying,
          handheldSettings: nextHHSettings,
          handheldTimeMs: nextHHTime,
          handheldRig: hhRig,
          rig: combineFinalRig(nextWalkRig, nextSphereRig, nextHHEnabled, hhRig),
        };
      });
    },
    [],
  );

  const playCustomSphere = useCallback(() => {
    setState((prev) => {
      if (prev.customWaypoints.length === 0) return prev;
      sphereElapsedRef.current = 0;
      startRef.current = 0;
      const nextSphereRig = evaluateCustomTrajectory(
        prev.customWaypoints,
        0,
        prev.customCloseLoop,
      );
      const nextTrajRig = combineTrajectoryRig(prev.walkRig, nextSphereRig);
      return {
        ...prev,
        trajectoryId: CUSTOM_TRAJECTORY_ID,
        spherePlaying: true,
        walkPlaying: prev.walkPlaying, // leave walk running if already on
        playing: true || prev.walkPlaying,
        sphereProgress: 0,
        sphereRig: nextSphereRig,
        selectedSphereWaypointId: null,
        trajectoryRig: nextTrajRig,
        rig: combineFinalRig(
          prev.walkRig,
          nextSphereRig,
          prev.handheldEnabled,
          prev.handheldRig,
        ),
      };
    });
  }, []);

  // Idle sync — keep preview rig in sync with waypoint edits when not playing,
  // so clicking a single node updates the view live.
  useEffect(() => {
    if (state.spherePlaying && state.walkPlaying) return;
    let nextSphereRig: CameraRig | null = null;
    let nextWalkRig: CameraRig | null = null;

    // --- Sphere sync (when paused or selected node) ---
    if (!state.spherePlaying && state.customWaypoints.length > 0) {
      const selWp = state.selectedSphereWaypointId
        ? state.customWaypoints.find((w) => w.id === state.selectedSphereWaypointId)
        : null;
      const target = selWp
        ? rigFromSpherePoint(selWp)
        : evaluateCustomTrajectory(
            state.customWaypoints,
            state.sphereProgress,
            state.customCloseLoop,
          );
      if (
        Math.abs(target.orbitX - state.sphereRig.orbitX) > 0.01 ||
        Math.abs(target.orbitY - state.sphereRig.orbitY) > 0.01 ||
        Math.abs(target.dolly - state.sphereRig.dolly) > 0.002
      ) {
        nextSphereRig = target;
      }
    } else if (state.customWaypoints.length === 0 && state.sphereRig.orbitX !== 0) {
      nextSphereRig = { ...DEFAULT_CAMERA };
    }

    // --- Walk sync (when paused or selected node) ---
    if (!state.walkPlaying && state.walkWaypoints.length > 0) {
      const selWp = state.selectedWalkWaypointId
        ? state.walkWaypoints.find((w) => w.id === state.selectedWalkWaypointId)
        : null;
      const target = selWp
        ? rigFromWalkPoint(selWp)
        : evaluateWalkTrajectory(
            state.walkWaypoints,
            state.walkProgress,
            state.walkCloseLoop,
          );
      if (
        Math.abs(target.orbitX - state.walkRig.orbitX) > 0.01 ||
        Math.abs(target.orbitY - state.walkRig.orbitY) > 0.01 ||
        Math.abs(target.panX - state.walkRig.panX) > 0.5 ||
        Math.abs(target.panY - state.walkRig.panY) > 0.5 ||
        Math.abs(target.z - state.walkRig.z) > 0.5
      ) {
        nextWalkRig = target;
      }
    } else if (state.walkWaypoints.length === 0 && state.walkRig.panX !== 0) {
      nextWalkRig = { ...DEFAULT_CAMERA };
    }

    if (nextSphereRig || nextWalkRig) {
      setState((prev) => {
        const walk = nextWalkRig ?? prev.walkRig;
        const sphere = nextSphereRig ?? prev.sphereRig;
        return {
          ...prev,
          walkRig: walk,
          sphereRig: sphere,
          trajectoryRig: combineTrajectoryRig(walk, sphere),
          rig: combineFinalRig(walk, sphere, prev.handheldEnabled, prev.handheldRig),
        };
      });
    }
  }, [
    state.customWaypoints,
    state.customCloseLoop,
    state.walkWaypoints,
    state.walkCloseLoop,
    state.selectedWalkWaypointId,
    state.selectedSphereWaypointId,
    state.spherePlaying,
    state.walkPlaying,
    state.sphereProgress,
    state.walkProgress,
    state.sphereRig.orbitX,
    state.sphereRig.orbitY,
    state.sphereRig.dolly,
    state.walkRig.orbitX,
    state.walkRig.orbitY,
    state.walkRig.panX,
    state.walkRig.panY,
    state.walkRig.z,
  ]);

  // Start the rAF loop whenever *any* motion (sphere/walk/HH) needs it.
  useEffect(() => {
    if (needLoop()) {
      cancel();
      startRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    }
    return cancel;
  }, [
    state.spherePlaying,
    state.walkPlaying,
    state.handheldEnabled,
    state.handheldPlaying,
    tick,
    cancel,
    needLoop,
  ]);

  useEffect(() => cancel, [cancel]);

  // Memoised values consumers may need to avoid re-renders.
  const hhState = useMemo(
    () => ({
      enabled: state.handheldEnabled,
      playing: state.handheldPlaying,
      strength: state.handheldSettings.strength,
      frequency: state.handheldSettings.frequency,
    }),
    [
      state.handheldEnabled,
      state.handheldPlaying,
      state.handheldSettings.strength,
      state.handheldSettings.frequency,
    ],
  );

  return {
    state,
    hh: hhState,
    play,
    pause,
    stop,
    reset,
    setLoop,
    setSpeed,
    setCustomWaypoints,
    setCustomCloseLoop,
    playCustomSphere,
    selectSphereWaypoint,
    setWalkWaypoints,
    setWalkCloseLoop,
    playCustomWalk,
    selectWalkWaypoint,
    softPause,
    softResume,
    restorePlayerSnapshot,
    // Handheld-specific
    setHandheldEnabled,
    toggleHandheld,
    setHandheldIntensity,
    setHandheldFrequency,
    pauseHandheld,
    resumeHandheld,
  };
}
