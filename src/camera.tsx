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

export interface CameraPlayerState {
  // Sphere Custom trajectory selection + progress
  trajectoryId: string | null;
  playing: boolean;
  loop: boolean;
  speed: number; // 0.25x .. 4x
  progress: number;
  /** Live evaluated rig for trajectory (BEFORE handheld overlay). */
  trajectoryRig: CameraRig;
  /** Handheld status + settings (independent toggled layer). */
  handheldEnabled: boolean;
  handheldPlaying: boolean;
  handheldSettings: HandheldSettings;
  /** Handheld absolute clock (ms) — kept across enable/disable for continuity. */
  handheldTimeMs: number;
  /** Snapshot of the handheld layer evaluated at handheldTimeMs. */
  handheldRig: CameraRig;
  /** finalRig = composeRigs(trajectoryRig, handheldRig) — what PreviewCanvas uses. */
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

function combineRigState(
  trajectoryRig: CameraRig,
  handheldEnabled: boolean,
  handheldRig: CameraRig,
): CameraRig {
  return handheldEnabled
    ? composeRigs(trajectoryRig, handheldRig)
    : trajectoryRig;
}

export function useCameraPlayer() {
  const [state, setState] = useState<CameraPlayerState>(() => {
    const trajRig = DEFAULT_CAMERA;
    const hhRig = evaluateHandheld(0, DEFAULT_HANDHELD);
    return {
      trajectoryId: null,
      playing: false,
      loop: true,
      speed: 1,
      progress: 0,
      trajectoryRig: trajRig,
      handheldEnabled: false,
      handheldPlaying: false,
      handheldSettings: { ...DEFAULT_HANDHELD },
      handheldTimeMs: 0,
      handheldRig: hhRig,
      rig: combineRigState(trajRig, false, hhRig),
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
  const elapsedRef = useRef<number>(0); // for trajectory (ms)
  const hhElapsedRef = useRef<number>(0); // for handheld (ms)
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
    if (s.playing && s.trajectoryId) return true;
    if (s.handheldEnabled && s.handheldPlaying) return true;
    return false;
  }, []);

  const evaluateTrajectoryRig = useCallback(
    (s: CameraPlayerState, progress: number): CameraRig => {
      if (s.trajectoryId === CUSTOM_TRAJECTORY_ID) {
        return evaluateCustomTrajectory(
          s.customWaypoints,
          Math.min(1, Math.max(0, progress)),
          s.customCloseLoop,
        );
      }
      if (s.trajectoryId === WALK_TRAJECTORY_ID) {
        return evaluateWalkTrajectory(
          s.walkWaypoints,
          Math.min(1, Math.max(0, progress)),
          s.walkCloseLoop,
        );
      }
      // No other trajectories built-in anymore (see note above CAMERA_TRAJECTORIES).
      return DEFAULT_CAMERA;
    },
    [],
  );

  const tick = useCallback(
    (now: number) => {
      const prev = stateRef.current;
      if (!prev.playing && !prev.handheldPlaying) {
        rafRef.current = null;
        return;
      }

      if (!startRef.current) startRef.current = now;
      const dt = now - startRef.current;
      startRef.current = now;

      // --- Advance trajectory clock ---
      let elapsedTraj = elapsedRef.current;
      let nextProgress = prev.progress;
      let shouldStopTraj = false;
      if (prev.playing && prev.trajectoryId) {
        const dtTraj = dt * prev.speed;
        elapsedTraj += dtTraj;
        let duration: number;
        let loopable: boolean;
        if (prev.trajectoryId === CUSTOM_TRAJECTORY_ID) {
          loopable = prev.customCloseLoop || prev.customWaypoints.length >= 2;
          duration =
            prev.customWaypoints.length <= 1
              ? 1000
              : Math.max(3000, prev.customWaypoints.length * 1600);
        } else if (prev.trajectoryId === WALK_TRAJECTORY_ID) {
          loopable = prev.walkCloseLoop || prev.walkWaypoints.length >= 2;
          duration =
            prev.walkWaypoints.length <= 1
              ? 1000
              : Math.max(3000, prev.walkWaypoints.length * 1800);
        } else {
          duration = 4000;
          loopable = true;
        }
        let t = elapsedTraj / duration;
        if (t >= 1) {
          if (prev.loop && loopable) {
            const wrapT = t - Math.floor(t);
            elapsedTraj = wrapT * duration;
            nextProgress = wrapT;
          } else {
            nextProgress = 1;
            elapsedTraj = duration;
            shouldStopTraj = true;
          }
        } else {
          nextProgress = t;
        }
      }

      // --- Advance handheld clock (always when handheldPlaying, independent) ---
      let hhElapsed = hhElapsedRef.current;
      if (prev.handheldEnabled && prev.handheldPlaying) {
        hhElapsed += dt;
      }
      const hhRig = prev.handheldEnabled
        ? evaluateHandheld(hhElapsed, prev.handheldSettings)
        : { ...DEFAULT_CAMERA };

      const trajRig = evaluateTrajectoryRig(prev, nextProgress);

      elapsedRef.current = elapsedTraj;
      hhElapsedRef.current = hhElapsed;

      const finalRig = combineRigState(trajRig, prev.handheldEnabled, hhRig);

      setState((s) => ({
        ...s,
        progress: Math.min(1, Math.max(0, nextProgress)),
        trajectoryRig: trajRig,
        handheldTimeMs: hhElapsed,
        handheldRig: hhRig,
        rig: finalRig,
        playing: shouldStopTraj ? false : s.playing,
      }));

      if (shouldStopTraj && !(prev.handheldEnabled && prev.handheldPlaying)) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [evaluateTrajectoryRig],
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
      const rig = combineRigState(prev.trajectoryRig, enabled, hhRig);
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
      const rig = combineRigState(prev.trajectoryRig, enabled, hhRig);
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
        rig: combineRigState(prev.trajectoryRig, prev.handheldEnabled, hhRig),
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
        rig: combineRigState(prev.trajectoryRig, prev.handheldEnabled, hhRig),
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

  /* ---------- Trajectory controls ---------- */

  const play = useCallback((trajectoryId?: string) => {
    setState((prev) => {
      const nextId = trajectoryId ?? prev.trajectoryId;
      if (!nextId) return prev;
      if (nextId === CUSTOM_TRAJECTORY_ID) {
        if (prev.customWaypoints.length === 0) return prev;
      } else if (nextId === WALK_TRAJECTORY_ID) {
        if (prev.walkWaypoints.length === 0) return prev;
      } else {
        return prev;
      }
      if (trajectoryId && trajectoryId !== prev.trajectoryId) {
        elapsedRef.current = 0;
      }
      startRef.current = 0;
      let trajRig: CameraRig;
      if (nextId === WALK_TRAJECTORY_ID) {
        trajRig = evaluateWalkTrajectory(prev.walkWaypoints, 0, prev.walkCloseLoop);
      } else {
        trajRig = evaluateCustomTrajectory(prev.customWaypoints, 0, prev.customCloseLoop);
      }
      return {
        ...prev,
        trajectoryRig: trajRig,
        trajectoryId: nextId,
        playing: true,
        progress: 0,
        selectedWalkWaypointId: null,
        selectedSphereWaypointId: null,
        rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
      };
    });
  }, []);

  const pause = useCallback(() => {
    setState((prev) => {
      if (!prev.playing) return prev;
      return { ...prev, playing: false };
    });
  }, []);

  /** Soft-pause for global "Pause All Motion". */
  const softPause = useCallback(() => {
    setState((prev) => {
      if (!prev.playing && !prev.handheldPlaying) return prev;
      return {
        ...prev,
        playing: prev.playing ? false : prev.playing,
        handheldPlaying: prev.handheldPlaying ? false : prev.handheldPlaying,
      };
    });
  }, []);

  const softResume = useCallback(() => {
    setState((prev) => {
      const needTrajStart =
        (prev.trajectoryId === CUSTOM_TRAJECTORY_ID && prev.customWaypoints.length > 0) ||
        (prev.trajectoryId === WALK_TRAJECTORY_ID && prev.walkWaypoints.length > 0);
      return {
        ...prev,
        playing: prev.trajectoryId ? (needTrajStart ? true : prev.playing) : prev.playing,
        handheldPlaying: prev.handheldEnabled ? true : prev.handheldPlaying,
      };
    });
  }, []);

  const stop = useCallback(() => {
    elapsedRef.current = 0;
    startRef.current = 0;
    setState((prev) => {
      let trajRig = DEFAULT_CAMERA;
      if (prev.trajectoryId === CUSTOM_TRAJECTORY_ID && prev.customWaypoints.length) {
        trajRig = evaluateCustomTrajectory(prev.customWaypoints, 0, prev.customCloseLoop);
      } else if (prev.trajectoryId === WALK_TRAJECTORY_ID && prev.walkWaypoints.length) {
        trajRig = evaluateWalkTrajectory(prev.walkWaypoints, 0, prev.walkCloseLoop);
      }
      return {
        ...prev,
        playing: false,
        trajectoryId: null,
        progress: 0,
        trajectoryRig: trajRig,
        rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
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
        const isCustomActive = prev.trajectoryId === CUSTOM_TRAJECTORY_ID;
        let trajRig = prev.trajectoryRig;
        if (waypoints.length === 0) {
          trajRig = DEFAULT_CAMERA;
        } else {
          // If a sphere waypoint is selected, preview that exact waypoint
          const sel = prev.selectedSphereWaypointId
            ? waypoints.find((w) => w.id === prev.selectedSphereWaypointId)
            : null;
          if (sel) {
            trajRig = rigFromSpherePoint(sel);
          } else if (isCustomActive) {
            trajRig = evaluateCustomTrajectory(
              waypoints,
              Math.min(1, Math.max(0, prev.progress)),
              prev.customCloseLoop,
            );
          } else {
            trajRig = evaluateCustomTrajectory(waypoints, 0, prev.customCloseLoop);
          }
        }
        return {
          ...prev,
          customWaypoints: waypoints,
          trajectoryRig: trajRig,
          rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
          progress: prev.playing ? prev.progress : waypoints.length ? prev.progress : 0,
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
      const trajRig = rigFromSpherePoint(wp);
      return {
        ...prev,
        selectedSphereWaypointId: id,
        trajectoryId: CUSTOM_TRAJECTORY_ID,
        playing: false,
        trajectoryRig: trajRig,
        rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
      };
    });
  }, []);

  /* ---------- Walk waypoints ---------- */

  const setWalkWaypoints = useCallback(
    (waypoints: WalkWaypoint[]) => {
      setState((prev) => {
        // Activate walk trajectory when waypoints exist so idle sync keeps preview live
        const shouldActivate = waypoints.length > 0;
        const nextTrajId = shouldActivate ? WALK_TRAJECTORY_ID : prev.trajectoryId;
        const nextPlaying = shouldActivate ? false : prev.playing;

        let trajRig = prev.trajectoryRig;
        if (waypoints.length === 0) {
          trajRig = DEFAULT_CAMERA;
        } else {
          // If a waypoint is selected, preview that exact waypoint
          const sel = prev.selectedWalkWaypointId
            ? waypoints.find((w) => w.id === prev.selectedWalkWaypointId)
            : null;
          if (sel) {
            trajRig = rigFromWalkPoint(sel);
          } else {
            trajRig = evaluateWalkTrajectory(
              waypoints,
              Math.min(1, Math.max(0, prev.progress)),
              prev.walkCloseLoop,
            );
          }
        }
        return {
          ...prev,
          walkWaypoints: waypoints,
          trajectoryId: nextTrajId,
          playing: nextPlaying,
          trajectoryRig: trajRig,
          rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
          progress: prev.playing ? prev.progress : waypoints.length ? prev.progress : 0,
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
      const trajRig = rigFromWalkPoint(wp);
      return {
        ...prev,
        selectedWalkWaypointId: id,
        trajectoryId: WALK_TRAJECTORY_ID,
        playing: false,
        trajectoryRig: trajRig,
        rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
      };
    });
  }, []);

  const playCustomWalk = useCallback(() => {
    setState((prev) => {
      if (prev.walkWaypoints.length === 0) return prev;
      elapsedRef.current = 0;
      startRef.current = 0;
      const trajRig = evaluateWalkTrajectory(
        prev.walkWaypoints,
        0,
        prev.walkCloseLoop,
      );
      return {
        ...prev,
        trajectoryId: WALK_TRAJECTORY_ID,
        playing: true,
        progress: 0,
        selectedWalkWaypointId: null,
        trajectoryRig: trajRig,
        rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
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
    ) => {
      setState((prev) => {
        const clampedProgress = Math.min(1, Math.max(0, progress));
        const nextWalkWp = walkWaypoints ?? prev.walkWaypoints;
        const nextWalkLoop = walkCloseLoop ?? prev.walkCloseLoop;
        let nextTrajId = trajectoryId;
        if (
          nextTrajId === CUSTOM_TRAJECTORY_ID &&
          prev.customWaypoints.length === 0
        ) {
          nextTrajId = null;
        }
        if (
          nextTrajId === WALK_TRAJECTORY_ID &&
          nextWalkWp.length === 0
        ) {
          nextTrajId = null;
        }
        let trajRig: CameraRig;
        if (!nextTrajId) {
          trajRig = DEFAULT_CAMERA;
        } else if (nextTrajId === CUSTOM_TRAJECTORY_ID) {
          trajRig = evaluateCustomTrajectory(
            prev.customWaypoints,
            clampedProgress,
            prev.customCloseLoop,
          );
        } else if (nextTrajId === WALK_TRAJECTORY_ID) {
          trajRig = evaluateWalkTrajectory(
            nextWalkWp,
            clampedProgress,
            nextWalkLoop,
          );
        } else {
          trajRig = DEFAULT_CAMERA;
        }
        if (nextTrajId) {
          let duration: number;
          if (nextTrajId === CUSTOM_TRAJECTORY_ID) {
            duration = prev.customWaypoints.length <= 1
              ? 1000
              : Math.max(3000, prev.customWaypoints.length * 1600);
          } else if (nextTrajId === WALK_TRAJECTORY_ID) {
            duration = nextWalkWp.length <= 1
              ? 1000
              : Math.max(3000, nextWalkWp.length * 1800);
          } else {
            duration = 4000;
          }
          elapsedRef.current = clampedProgress * duration;
        } else {
          elapsedRef.current = 0;
        }
        const nextHHEnabled = handheldEnabled ?? prev.handheldEnabled;
        const nextHHPlaying = handheldPlaying ?? prev.handheldPlaying;
        const nextHHSettings = handheldSettings ?? prev.handheldSettings;
        const nextHHTime = handheldTimeMs ?? prev.handheldTimeMs;
        hhElapsedRef.current = nextHHTime;
        const hhRig = nextHHEnabled
          ? evaluateHandheld(nextHHTime, nextHHSettings)
          : { ...DEFAULT_CAMERA };
        return {
          ...prev,
          trajectoryId: nextTrajId,
          playing: playing && !!nextTrajId,
          progress: nextTrajId ? clampedProgress : 0,
          trajectoryRig: trajRig,
          walkWaypoints: nextWalkWp,
          walkCloseLoop: nextWalkLoop,
          handheldEnabled: nextHHEnabled,
          handheldPlaying: nextHHPlaying,
          handheldSettings: nextHHSettings,
          handheldTimeMs: nextHHTime,
          handheldRig: hhRig,
          rig: combineRigState(trajRig, nextHHEnabled, hhRig),
        };
      });
    },
    [],
  );

  const playCustomSphere = useCallback(() => {
    setState((prev) => {
      if (prev.customWaypoints.length === 0) return prev;
      elapsedRef.current = 0;
      startRef.current = 0;
      const trajRig = evaluateCustomTrajectory(
        prev.customWaypoints,
        0,
        prev.customCloseLoop,
      );
      return {
        ...prev,
        trajectoryId: CUSTOM_TRAJECTORY_ID,
        playing: true,
        progress: 0,
        trajectoryRig: trajRig,
        rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
      };
    });
  }, []);

  // Idle sync — keep preview rig in sync with waypoint edits when not playing,
  // so clicking a single node updates the view live.
  useEffect(() => {
    if (state.playing) return;
    // Sphere Custom idle sync
    if (state.trajectoryId === CUSTOM_TRAJECTORY_ID && state.customWaypoints.length > 0) {
      const selWp = state.selectedSphereWaypointId
        ? state.customWaypoints.find((w) => w.id === state.selectedSphereWaypointId)
        : null;
      const target = selWp
        ? rigFromSpherePoint(selWp)
        : evaluateCustomTrajectory(
            state.customWaypoints,
            state.progress,
            state.customCloseLoop,
          );
      if (
        Math.abs(target.orbitX - state.trajectoryRig.orbitX) > 0.01 ||
        Math.abs(target.orbitY - state.trajectoryRig.orbitY) > 0.01 ||
        Math.abs(target.dolly - state.trajectoryRig.dolly) > 0.002
      ) {
        setState((prev) => {
          const trajRig = target;
          return {
            ...prev,
            trajectoryRig: trajRig,
            rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
          };
        });
      }
    }
    // Walk Path idle sync
    if (state.trajectoryId === WALK_TRAJECTORY_ID && state.walkWaypoints.length > 0) {
      // If a waypoint is selected, preview that exact waypoint instead of interpolated progress
      const selWp = state.selectedWalkWaypointId
        ? state.walkWaypoints.find((w) => w.id === state.selectedWalkWaypointId)
        : null;
      const target = selWp
        ? rigFromWalkPoint(selWp)
        : evaluateWalkTrajectory(
            state.walkWaypoints,
            state.progress,
            state.walkCloseLoop,
          );
      if (
        Math.abs(target.orbitX - state.trajectoryRig.orbitX) > 0.01 ||
        Math.abs(target.orbitY - state.trajectoryRig.orbitY) > 0.01 ||
        Math.abs(target.panX - state.trajectoryRig.panX) > 0.5 ||
        Math.abs(target.panY - state.trajectoryRig.panY) > 0.5 ||
        Math.abs(target.z - state.trajectoryRig.z) > 0.5
      ) {
        setState((prev) => {
          const trajRig = target;
          return {
            ...prev,
            trajectoryRig: trajRig,
            rig: combineRigState(trajRig, prev.handheldEnabled, prev.handheldRig),
          };
        });
      }
    }
  }, [
    state.customWaypoints,
    state.customCloseLoop,
    state.walkWaypoints,
    state.walkCloseLoop,
    state.selectedWalkWaypointId,
    state.selectedSphereWaypointId,
    state.playing,
    state.progress,
    state.trajectoryId,
    state.trajectoryRig.orbitX,
    state.trajectoryRig.orbitY,
    state.trajectoryRig.panX,
    state.trajectoryRig.panY,
    state.trajectoryRig.dolly,
    state.trajectoryRig.z,
  ]);

  // Start the rAF loop whenever *any* motion (trajectory OR handheld) needs it.
  useEffect(() => {
    if (needLoop()) {
      cancel();
      startRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    }
    return cancel;
  }, [state.playing, state.trajectoryId, state.handheldEnabled, state.handheldPlaying, tick, cancel, needLoop]);

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
