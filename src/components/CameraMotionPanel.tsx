import { useMemo, useState, useRef } from 'react';
import type { CameraPlayerState, CameraRig, HandheldSettings, SphereWaypoint, WalkWaypoint } from '../camera';
import {
  CUSTOM_TRAJECTORY_ID,
  CUSTOM_TRAJECTORY_LABEL,
  SPHERE_LATITUDES,
  SPHERE_LONGITUDE_COUNT,
  WALK_TRAJECTORY_ID,
  WALK_TRAJECTORY_LABEL,
  evaluateCustomTrajectory,
  evaluateWalkTrajectory,
  getRingLons,
  makeSphereWaypoint,
  makeWalkWaypoint,
  projectSpherePoint,
} from '../camera';

interface CameraMotionPanelProps {
  orbitCenterUi: { nx: number; ny: number; label: string; found: boolean };
  handheld: {
    enabled: boolean;
    playing: boolean;
    strength: number;
    frequency: number;
  };
  camera: {
    state: CameraPlayerState;
    play: (trajectoryId?: string) => void;
    pause: () => void;
    stop: () => void;
    reset: () => void;
    setLoop: (loop: boolean) => void;
    setSpeed: (speed: number) => void;
    setCustomWaypoints: (waypoints: SphereWaypoint[]) => void;
    setCustomCloseLoop: (closed: boolean) => void;
    playCustomSphere: () => void;
    selectSphereWaypoint: (id: string | null) => void;
    setWalkWaypoints: (waypoints: WalkWaypoint[]) => void;
    setWalkCloseLoop: (closed: boolean) => void;
    playCustomWalk: () => void;
    selectWalkWaypoint: (id: string | null) => void;
    toggleHandheld: () => void;
    setHandheldEnabled: (enabled: boolean) => void;
    setHandheldIntensity: (strength: number) => void;
    setHandheldFrequency: (frequency: number) => void;
  };
}

export function CameraMotionPanel({ handheld, camera, orbitCenterUi }: CameraMotionPanelProps) {
  const {
    state,
    play,
    pause,
    stop,
    reset,
    setSpeed,
    setCustomWaypoints,
    setCustomCloseLoop,
    playCustomSphere,
    selectSphereWaypoint,
    setWalkWaypoints,
    setWalkCloseLoop,
    playCustomWalk,
    selectWalkWaypoint,
    toggleHandheld,
    setHandheldIntensity,
    setHandheldFrequency,
  } = camera;

  const activeTrajectoryLabel = useMemo(() => {
    if (!state.trajectoryId) return null;
    if (state.trajectoryId === CUSTOM_TRAJECTORY_ID) return CUSTOM_TRAJECTORY_LABEL;
    if (state.trajectoryId === WALK_TRAJECTORY_ID) return WALK_TRAJECTORY_LABEL;
    return null;
  }, [state.trajectoryId]);

  const activeTrajectoryIsCustom = state.trajectoryId === CUSTOM_TRAJECTORY_ID;
  const activeTrajectoryIsWalk = state.trajectoryId === WALK_TRAJECTORY_ID;

  // Map a camera rig back to (lat, lon) so ANY active custom trajectory can
  // be visualised on the sphere disc.
  const rigToSphere = (rig: CameraRig) => {
    let lat = -rig.orbitX;
    let lon = rig.orbitY;
    if (lat > 90) lat = 90;
    if (lat < -90) lat = -90;
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    return { lat, lon };
  };

  const getActiveRig = (u: number): CameraRig | null => {
    if (!state.trajectoryId) return null;
    if (state.trajectoryId === CUSTOM_TRAJECTORY_ID) {
      return evaluateCustomTrajectory(
        state.customWaypoints,
        Math.min(1, Math.max(0, u)),
        state.customCloseLoop,
      );
    }
    return null;
  };

  const durationLabel = useMemo(() => {
    if (activeTrajectoryIsCustom) {
      const n = state.customWaypoints.length;
      if (n <= 1) return 'static';
      const ms = Math.max(3000, n * 1600);
      return `${(ms / 1000).toFixed(1)}s`;
    }
    return '—';
  }, [activeTrajectoryIsCustom, state.customWaypoints.length]);

  return (
    <section className="macos-card p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="section-title !mb-0">Camera Motion</h3>
        <span
          className={[
            'chip',
            state.playing || handheld.playing ? '!border-accent-blue !text-fg-bright' : '',
          ].join(' ')}
        >
          {state.playing || handheld.playing ? 'Active' : state.trajectoryId ? 'Paused' : 'Idle'}
        </span>
      </div>

      {/* ------- Single preset: Handheld Shake ------- */}
      <HandheldShakeCard
        handheld={handheld}
        onToggle={toggleHandheld}
        onIntensity={setHandheldIntensity}
        onFrequency={setHandheldFrequency}
      />

      {/* ------- Custom sphere trajectory editor ------- */}
      <SphereEditor
        orbitCenterUi={orbitCenterUi}
        waypoints={state.customWaypoints}
        closeLoop={state.customCloseLoop}
        isCustomActive={activeTrajectoryIsCustom}
        activeTrajectoryId={state.trajectoryId}
        builtInLabel={
          activeTrajectoryIsCustom ? CUSTOM_TRAJECTORY_LABEL : null
        }
        getActiveRig={getActiveRig}
        rigToSphere={rigToSphere}
        currentProgress={state.progress}
        currentRig={state.trajectoryRig}
        playing={state.playing}
        selectedWaypointId={state.selectedSphereWaypointId}
        onAddWaypoint={(lat, lon) => {
          const wp = makeSphereWaypoint(lat, lon, 1);
          const arr = [...state.customWaypoints, wp];
          setCustomWaypoints(arr);
          selectSphereWaypoint(wp.id);
        }}
        onDrawPath={(points) => {
          // Replace all waypoints with the drawn path
          const wps = points.map((p) => makeSphereWaypoint(p.lat, p.lon, 1));
          setCustomWaypoints(wps);
          selectSphereWaypoint(null);
        }}
        onRemoveWaypoint={(id) =>
          setCustomWaypoints(state.customWaypoints.filter((w) => w.id !== id))
        }
        onMoveWaypoint={(id, delta) => {
          const arr = [...state.customWaypoints];
          const i = arr.findIndex((w) => w.id === id);
          if (i < 0) return;
          const j = i + delta;
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          setCustomWaypoints(arr);
        }}
        onChangeDolly={(id, dolly) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id
                ? { ...w, dolly: Math.max(0.6, Math.min(1.7, dolly)) }
                : w,
            ),
          )
        }
        onChangeX={(id, x) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id ? { ...w, x: Math.max(-2, Math.min(2, x)) } : w,
            ),
          )
        }
        onChangeY={(id, y) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id ? { ...w, y: Math.max(-2, Math.min(2, y)) } : w,
            ),
          )
        }
        onChangeZ={(id, z) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id ? { ...w, z: Math.max(-2, Math.min(2, z)) } : w,
            ),
          )
        }
        onChangeLookX={(id, v) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id ? { ...w, lookX: Math.max(-45, Math.min(45, v)) } : w,
            ),
          )
        }
        onChangeLookY={(id, v) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id ? { ...w, lookY: Math.max(-45, Math.min(45, v)) } : w,
            ),
          )
        }
        onChangeLookZ={(id, v) =>
          setCustomWaypoints(
            state.customWaypoints.map((w) =>
              w.id === id ? { ...w, lookZ: Math.max(-15, Math.min(15, v)) } : w,
            ),
          )
        }
        onSelectWaypoint={selectSphereWaypoint}
        onClearWaypoints={() => {
          selectSphereWaypoint(null);
          setCustomWaypoints([]);
        }}
        onToggleCloseLoop={(v) => setCustomCloseLoop(v)}
        onPlayCustom={playCustomSphere}
      />

      {/* ------- Walk-through trajectory editor ------- */}
      <WalkEditor
        waypoints={state.walkWaypoints}
        closeLoop={state.walkCloseLoop}
        isWalkActive={activeTrajectoryIsWalk}
        playing={state.playing}
        currentProgress={state.progress}
        selectedWaypointId={state.selectedWalkWaypointId}
        onSelectWaypoint={selectWalkWaypoint}
        onAddWaypoint={(x, y, z) => {
          const wp = makeWalkWaypoint(x, y, z);
          const arr = [...state.walkWaypoints, wp];
          setWalkWaypoints(arr);
          selectWalkWaypoint(wp.id);
        }}
        onRemoveWaypoint={(id) =>
          setWalkWaypoints(state.walkWaypoints.filter((w) => w.id !== id))
        }
        onMoveWaypoint={(id, delta) => {
          const arr = [...state.walkWaypoints];
          const i = arr.findIndex((w) => w.id === id);
          if (i < 0) return;
          const j = i + delta;
          if (j < 0 || j >= arr.length) return;
          [arr[i], arr[j]] = [arr[j], arr[i]];
          setWalkWaypoints(arr);
        }}
        onChangeLook={(id, field, value) =>
          setWalkWaypoints(
            state.walkWaypoints.map((w) =>
              w.id === id ? { ...w, [field]: value } : w,
            ),
          )
        }
        onChangeDolly={(id, dolly) =>
          setWalkWaypoints(
            state.walkWaypoints.map((w) =>
              w.id === id
                ? { ...w, dolly: Math.max(0.6, Math.min(1.7, dolly)) }
                : w,
            ),
          )
        }
        onChangePosition={(id, field, value) =>
          setWalkWaypoints(
            state.walkWaypoints.map((w) =>
              w.id === id ? { ...w, [field]: value } : w,
            ),
          )
        }
        onClearWaypoints={() => setWalkWaypoints([])}
        onToggleCloseLoop={(v) => setWalkCloseLoop(v)}
        onPlayWalk={playCustomWalk}
      />

      {/* ------- Active trajectory summary ------- */}
      {activeTrajectoryLabel && (
        <div className="mb-3">
          <div className="field-label">
            <span>
              {activeTrajectoryLabel}
              <span className="ml-2 font-mono text-fg-muted">
                {(state.progress * 100).toFixed(0)}%
              </span>
            </span>
            <span className="field-value">
              {activeTrajectoryIsCustom
                ? state.customCloseLoop
                  ? 'Loop'
                  : 'Open path'
                : 'Play'}
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-border-soft">
            <div
              className="h-full bg-white transition-[width] duration-75"
              style={{
                width: `${Math.max(0, Math.min(1, state.progress)) * 100}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-fg-muted">
            {activeTrajectoryIsCustom
              ? `Your ${state.customWaypoints.length}-waypoint spherical path. Duration auto: ${durationLabel}. Works together with Handheld Shake above.`
              : activeTrajectoryIsWalk
              ? `Your ${state.walkWaypoints.length}-waypoint walk-through path. Camera moves and rotates at each waypoint. Works with Handheld Shake.`
              : ''}
          </p>
        </div>
      )}

      {/* ------- Global playback controls (Sphere Custom trajectory only) ------- */}
      <div className="mb-3">
        <div className="field-label">
          <span>Speed · Sphere Path</span>
          <span className="field-value">×{state.speed.toFixed(2)}</span>
        </div>
        <input
          type="range"
          className="slider"
          min={0.25}
          max={4}
          step={0.05}
          value={state.speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => play()}
          disabled={!state.trajectoryId}
          className="btn h-10"
        >
          {state.playing ? 'Replay' : 'Play'}
        </button>
        <button
          type="button"
          onClick={pause}
          disabled={!state.playing}
          className="btn h-10"
        >
          Pause
        </button>
        <button type="button" onClick={stop} className="btn h-10">
          Stop
        </button>
      </div>
      <button
        type="button"
        onClick={reset}
        className="btn mt-2 w-full"
        title="Stop Sphere Custom trajectory and return camera to the default front view (Handheld stays as-is)."
      >
        Reset Camera View
      </button>
    </section>
  );
}

/* -------- Handheld Shake card (the *only* remaining camera preset) -------- */

interface HandheldShakeCardProps {
  handheld: HandheldSettings & { enabled: boolean; playing: boolean };
  onToggle: () => void;
  onIntensity: (strength: number) => void;
  onFrequency: (frequency: number) => void;
}

function HandheldShakeCard({
  handheld,
  onToggle,
  onIntensity,
  onFrequency,
}: HandheldShakeCardProps) {
  return (
    <div className="macos-card mb-4 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="subsection-title !mb-0">
            Handheld Shake
          </span>
          <span className="font-mono text-[10px] text-fg-muted">
            {handheld.enabled
              ? handheld.playing
                ? 'shaking'
                : 'on · paused'
              : 'off'}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2"
          title={handheld.enabled ? 'Disable Handheld Shake' : 'Enable Handheld Shake'}
        >
          <span
            className={[
              'relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors',
              handheld.enabled ? 'bg-accent-blue' : 'bg-border-medium',
            ].join(' ')}
          >
            <span
              className={[
                'absolute top-0.5 h-3 w-3 rounded-full transition-all',
                handheld.enabled
                  ? 'left-[calc(100%-14px)] bg-white'
                  : 'left-0.5 bg-fg-muted',
              ].join(' ')}
            />
          </span>
        </button>
      </div>

      {/* Intensity (晃动程度) */}
      <div className="mb-3">
        <div className="field-label">
          <span>Intensity</span>
          <span className="field-value">{handheld.strength.toFixed(0)}</span>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={100}
          step={1}
          value={handheld.strength}
          disabled={!handheld.enabled}
          onChange={(e) => onIntensity(Number(e.target.value))}
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-muted">
          <span>0 · still</span>
          <span>50 · gentle</span>
          <span>100 · strong</span>
        </div>
      </div>

      {/* Frequency (频率) */}
      <div>
        <div className="field-label">
          <span>Frequency</span>
          <span className="field-value">
            {handheld.frequency.toFixed(0)}
          </span>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={100}
          step={1}
          value={handheld.frequency}
          disabled={!handheld.enabled}
          onChange={(e) => onFrequency(Number(e.target.value))}
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-fg-muted">
          <span>0 · frozen</span>
          <span>50 · normal</span>
          <span>100 · 2x fast</span>
        </div>
      </div>
    </div>
  );
}

/* ------------- Sphere Editor ------------- */

interface SphereEditorProps {
  orbitCenterUi: { nx: number; ny: number; label: string; found: boolean };
  waypoints: readonly SphereWaypoint[];
  closeLoop: boolean;
  isCustomActive: boolean;
  activeTrajectoryId: string | null;
  builtInLabel: string | null;
  getActiveRig: (u: number) => CameraRig | null;
  rigToSphere: (rig: CameraRig) => { lat: number; lon: number };
  currentProgress: number;
  currentRig: CameraRig;
  playing: boolean;
  selectedWaypointId: string | null;
  onAddWaypoint: (lat: number, lon: number) => void;
  onDrawPath: (points: { lat: number; lon: number }[]) => void;
  onRemoveWaypoint: (id: string) => void;
  onMoveWaypoint: (id: string, delta: -1 | 1) => void;
  onChangeDolly: (id: string, dolly: number) => void;
  onChangeX: (id: string, x: number) => void;
  onChangeY: (id: string, y: number) => void;
  onChangeZ: (id: string, z: number) => void;
  onChangeLookX: (id: string, v: number) => void;
  onChangeLookY: (id: string, v: number) => void;
  onChangeLookZ: (id: string, v: number) => void;
  onSelectWaypoint: (id: string | null) => void;
  onClearWaypoints: () => void;
  onToggleCloseLoop: (v: boolean) => void;
  onPlayCustom: () => void;
}

function SphereEditor({
  orbitCenterUi,
  waypoints,
  closeLoop,
  isCustomActive,
  activeTrajectoryId,
  builtInLabel,
  getActiveRig,
  rigToSphere,
  currentProgress,
  currentRig,
  playing,
  selectedWaypointId,
  onAddWaypoint,
  onDrawPath,
  onRemoveWaypoint,
  onMoveWaypoint,
  onChangeDolly,
  onChangeX,
  onChangeY,
  onChangeZ,
  onChangeLookX,
  onChangeLookY,
  onChangeLookZ,
  onSelectWaypoint,
  onClearWaypoints,
  onToggleCloseLoop,
  onPlayCustom,
}: SphereEditorProps) {
  const SVG_SIZE = 240;
  const PAD = 12;
  const cx = SVG_SIZE / 2;
  const cy = SVG_SIZE / 2;
  const radius = SVG_SIZE / 2 - PAD;

  // Draw mode state
  const [drawMode, setDrawMode] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const drawPointsRef = useRef<{ lat: number; lon: number }[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);

  /** Inverse projection: SVG (x, y) → (lat, lon) on the front hemisphere. */
  const unprojectSpherePoint = (sx: number, sy: number): { lat: number; lon: number } | null => {
    const nx = (sx - cx) / radius;
    const ny = (sy - cy) / radius;
    // Must be inside the disc
    const r2 = nx * nx + ny * ny;
    if (r2 > 1) return null;
    const lat = (Math.asin(-ny) * 180) / Math.PI;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    if (cosLat < 0.01) return { lat, lon: 0 };
    const sinLon = nx / cosLat;
    const clampedSinLon = Math.max(-1, Math.min(1, sinLon));
    const lon = (Math.asin(clampedSinLon) * 180) / Math.PI;
    return { lat, lon };
  };

  /** Convert a mouse event to SVG coordinates. */
  const getSvgPoint = (e: React.MouseEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const handleDrawStart = (e: React.MouseEvent) => {
    if (!drawMode) return;
    const pt = getSvgPoint(e);
    if (!pt) return;
    const ll = unprojectSpherePoint(pt.x, pt.y);
    if (!ll) return;
    drawPointsRef.current = [ll];
    setIsDrawing(true);
    onDrawPath(drawPointsRef.current);
  };

  const handleDrawMove = (e: React.MouseEvent) => {
    if (!drawMode || !isDrawing) return;
    const pt = getSvgPoint(e);
    if (!pt) return;
    const ll = unprojectSpherePoint(pt.x, pt.y);
    if (!ll) return;
    const last = drawPointsRef.current[drawPointsRef.current.length - 1];
    if (last) {
      const dLat = ll.lat - last.lat;
      const dLon = ll.lon - last.lon;
      if (Math.sqrt(dLat * dLat + dLon * dLon) < 5) return; // min 5° spacing
    }
    drawPointsRef.current = [...drawPointsRef.current, ll];
    onDrawPath(drawPointsRef.current);
  };

  const handleDrawEnd = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
  };

  // Map a normalized [-1, 1] canvas-space offset into a position inside the
  // SVG disc radius — shows where the orbit anchor (Headline) currently sits.
  const anchorX = cx + orbitCenterUi.nx * radius * 0.92;
  const anchorY = cy + orbitCenterUi.ny * radius * 0.92;

  const shapeForDepth = (
    z: number,
  ): { opacity: number; nodeRadius: number; stroke: string; front: boolean } => {
    const t = Math.max(-1, Math.min(1, z));
    const opacity = 0.22 + 0.78 * ((t + 1) / 2);
    const nodeRadius = 3.6 + 1.8 * ((t + 1) / 2);
    // Use CSS variables for theme-aware grayscales
    return {
      opacity,
      nodeRadius,
      stroke: t >= 0 ? 'var(--color-fg-dim)' : 'var(--color-border-medium)',
      front: t >= 0,
    };
  };

  const lons = useMemo(() => getRingLons(), []);

  const cellToWaypoint = useMemo(() => {
    const map = new Map<string, number>();
    waypoints.forEach((w, i) => map.set(`${w.lat}|${w.lon}`, i));
    return map;
  }, [waypoints]);

  const splineSegments: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    opacity: number;
  }[] = useMemo(() => {
    if (!activeTrajectoryId) return [];
    const samples: { x: number; y: number; z: number }[] = [];
    let prevLon: number | null = null;
    const pushProjected = (rig: CameraRig): void => {
      let { lat, lon } = rigToSphere(rig);
      if (prevLon != null) {
        while (lon - prevLon > 180) lon -= 360;
        while (lon - prevLon < -180) lon += 360;
      }
      prevLon = lon;
      samples.push(projectSpherePoint(lat, lon, cx, cy, radius));
    };
    if (isCustomActive) {
      const segments = Math.max(160, waypoints.length * 40);
      for (let i = 0; i <= segments; i++) {
        const u = i / segments;
        const rig = evaluateCustomTrajectory(waypoints, u, closeLoop);
        pushProjected(rig);
      }
    } else {
      const segments = 220;
      for (let i = 0; i <= segments; i++) {
        const u = i / segments;
        const rig = getActiveRig(u);
        if (!rig) continue;
        pushProjected(rig);
      }
    }
    const out: { x1: number; y1: number; x2: number; y2: number; opacity: number }[] = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy > radius * radius) continue;
      const avgZ = (a.z + b.z) / 2;
      if (avgZ < -0.98) continue;
      const t = Math.max(-1, Math.min(1, avgZ));
      const opacity = 0.18 + 0.82 * ((t + 1) / 2);
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, opacity });
    }
    return out;
  }, [
    activeTrajectoryId,
    isCustomActive,
    waypoints,
    closeLoop,
    cx,
    cy,
    radius,
    getActiveRig,
    rigToSphere,
  ]);

  const cameraOnSphere = useMemo(() => {
    let rig: CameraRig;
    if (!activeTrajectoryId) return null;
    if (playing || currentProgress > 0) {
      rig = currentRig;
    } else {
      const r0 = getActiveRig(0);
      if (!r0) return null;
      rig = r0;
    }
    const { lat, lon } = rigToSphere(rig);
    return projectSpherePoint(lat, lon, cx, cy, radius);
  }, [
    activeTrajectoryId,
    playing,
    currentProgress,
    currentRig,
    getActiveRig,
    rigToSphere,
    cx,
    cy,
    radius,
  ]);

  return (
    <div className="macos-card mb-4 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="subsection-title !mb-0">
            Sphere Custom
          </span>
          <span className="font-mono text-[10px] text-fg-muted">
            {SPHERE_LATITUDES.length} rings × {SPHERE_LONGITUDE_COUNT} nodes
          </span>
          {builtInLabel && activeTrajectoryId ? (
            <span
              className={[
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide',
                playing
                  ? 'border-accent-blue bg-accent-blue text-bg-deep'
                  : isCustomActive
                  ? 'border-accent-blue text-fg-bright'
                  : 'border-border-soft text-fg-dim',
              ].join(' ')}
              title="Currently selected trajectory path shown on the sphere"
            >
              path · {builtInLabel}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDrawMode(false)}
            className={[
              'rounded-macos border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
              !drawMode
                ? 'border-accent-blue bg-accent-blue text-bg-deep'
                : 'border-border-soft text-fg-dim hover:text-fg-bright',
            ].join(' ')}
          >
            Nodes
          </button>
          <button
            type="button"
            onClick={() => setDrawMode(true)}
            className={[
              'rounded-macos border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
              drawMode
                ? 'border-accent-blue bg-accent-blue text-bg-deep'
                : 'border-border-soft text-fg-dim hover:text-fg-bright',
            ].join(' ')}
          >
            Draw
          </button>
          <span className="font-mono text-[10px] text-fg-muted">
            {waypoints.length} wp
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="relative flex justify-center rounded-macos border border-border-soft bg-bg-input p-2">
          <svg
            ref={svgRef}
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            className={[
              'block',
              drawMode ? 'cursor-crosshair' : '',
            ].join(' ')}
            aria-label="Sphere trajectory editor"
            onMouseDown={handleDrawStart}
            onMouseMove={handleDrawMove}
            onMouseUp={handleDrawEnd}
            onMouseLeave={handleDrawEnd}
          >
            <circle
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke="var(--color-border-medium)"
              strokeWidth={1}
            />

            {SPHERE_LATITUDES.map((lat) => {
              const y = cy - Math.sin((lat * Math.PI) / 180) * radius;
              const rx = Math.cos((lat * Math.PI) / 180) * radius;
              const isEquator = lat === 0;
              const depthT = Math.sin((lat * Math.PI) / 180);
              const poleFade = isEquator
                ? 1
                : 0.75 + 0.25 * (1 - Math.abs(depthT));
              return (
                <ellipse
                  key={`lat-${lat}`}
                  cx={cx}
                  cy={y}
                  rx={rx}
                  ry={rx * 0.08 + 2}
                  fill="none"
                  stroke={isEquator ? 'var(--color-border-strong)' : 'var(--color-border-medium)'}
                  strokeDasharray={isEquator ? undefined : '2 3'}
                  strokeWidth={isEquator ? 1 : 0.8}
                  opacity={poleFade}
                />
              );
            })}

            {lons.map((lon, li) => {
              const samples = SPHERE_LATITUDES.length + 6;
              const pts: { x: number; y: number; z: number }[] = [];
              for (let i = 0; i < samples; i++) {
                const t = i / (samples - 1);
                const lat = -90 + t * 180;
                pts.push(projectSpherePoint(lat, lon, cx, cy, radius));
              }
              const isPrime = li === 0;
              const baseColor = isPrime ? 'var(--color-border-strong)' : 'var(--color-border-medium)';
              return (
                <g key={`lon-${li}`}>
                  {pts.slice(1).map((b, i) => {
                    const a = pts[i];
                    const avgZ = (a.z + b.z) / 2;
                    const s = shapeForDepth(avgZ);
                    return (
                      <line
                        key={i}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={baseColor}
                        strokeOpacity={
                          (isPrime ? 1 : 0.7) * (s.opacity * 0.75 + 0.18)
                        }
                        strokeDasharray="2 3"
                        strokeWidth={isPrime ? 1 : 0.7}
                      />
                    );
                  })}
                </g>
              );
            })}

            {splineSegments.length > 0 && (
              <g pointerEvents="none">
                {splineSegments.map((seg, i) => (
                  <line
                    key={i}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke="var(--color-accent-blue)"
                    strokeOpacity={seg.opacity * 0.95}
                    strokeWidth={0.8 + 0.9 * seg.opacity}
                    strokeDasharray={seg.opacity > 0.5 ? '4 3' : '3 4'}
                  />
                ))}
              </g>
            )}

            {SPHERE_LATITUDES.flatMap((lat) =>
              lons.map((lon) => {
                const p = projectSpherePoint(lat, lon, cx, cy, radius);
                const depth = shapeForDepth(p.z);
                const key = `${lat}|${lon}`;
                const wpIdx = cellToWaypoint.get(key);
                const hasWaypoint = wpIdx != null;
                const r = hasWaypoint
                  ? Math.max(6, depth.nodeRadius + 2.2)
                  : depth.nodeRadius;
                return (
                  <g
                    key={key}
                    onClick={() => {
                      if (drawMode || hasWaypoint) return;
                      onAddWaypoint(lat, lon);
                    }}
                    style={{
                      cursor: drawMode ? 'none' : hasWaypoint ? 'default' : 'pointer',
                      pointerEvents: drawMode ? 'none' : 'all',
                    }}
                    opacity={depth.opacity}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={hasWaypoint ? 'var(--color-accent-blue)' : 'transparent'}
                      stroke={
                        hasWaypoint
                          ? 'var(--color-accent-blue)'
                          : depth.front
                          ? 'var(--color-fg-dim)'
                          : depth.stroke
                      }
                      strokeWidth={hasWaypoint ? 1 : depth.front ? 1.2 : 1}
                    />
                    {hasWaypoint ? (
                      <>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={r + 2.6}
                          fill="none"
                          stroke="var(--color-accent-blue)"
                          strokeOpacity={0.28 + 0.5 * depth.opacity}
                          strokeWidth={0.8}
                        />
                        <text
                          x={p.x}
                          y={p.y + (depth.front ? 3 : 2.5)}
                          textAnchor="middle"
                          fontSize={depth.front ? '9' : '8'}
                          fontWeight="700"
                          fill="var(--color-bg-card)"
                        >
                          {(wpIdx ?? 0) + 1}
                        </text>
                      </>
                    ) : null}
                  </g>
                );
              }),
            )}

            {/* Orbit anchor crosshair */}
            <g pointerEvents="none" opacity={0.95}>
              <line
                x1={anchorX - 8}
                y1={anchorY}
                x2={anchorX - 3}
                y2={anchorY}
                stroke={orbitCenterUi.found ? 'var(--color-accent-blue)' : 'var(--color-fg-muted)'}
                strokeWidth={1.1}
              />
              <line
                x1={anchorX + 3}
                y1={anchorY}
                x2={anchorX + 8}
                y2={anchorY}
                stroke={orbitCenterUi.found ? 'var(--color-accent-blue)' : 'var(--color-fg-muted)'}
                strokeWidth={1.1}
              />
              <line
                x1={anchorX}
                y1={anchorY - 8}
                x2={anchorX}
                y2={anchorY - 3}
                stroke={orbitCenterUi.found ? 'var(--color-accent-blue)' : 'var(--color-fg-muted)'}
                strokeWidth={1.1}
              />
              <line
                x1={anchorX}
                y1={anchorY + 3}
                x2={anchorX}
                y2={anchorY + 8}
                stroke={orbitCenterUi.found ? 'var(--color-accent-blue)' : 'var(--color-fg-muted)'}
                strokeWidth={1.1}
              />
              <circle
                cx={anchorX}
                cy={anchorY}
                r={1.6}
                fill={orbitCenterUi.found ? 'var(--color-accent-blue)' : 'var(--color-fg-muted)'}
              />
            </g>

            {cameraOnSphere && cameraOnSphere.z >= -0.3 && (
              <g pointerEvents="none">
                <circle
                  cx={cameraOnSphere.x}
                  cy={cameraOnSphere.y}
                  r="10"
                  fill="none"
                  stroke="var(--color-accent-blue)"
                  strokeWidth="1.2"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={cameraOnSphere.x}
                  cy={cameraOnSphere.y}
                  r="2.6"
                  fill="var(--color-accent-blue)"
                />
              </g>
            )}
          </svg>
        </div>

        <div className="min-w-0 rounded-macos border border-border-soft bg-bg-input p-2.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="text-[10px] uppercase tracking-widest text-fg-muted">
                {drawMode
                  ? 'draw on the sphere above — drag to trace a camera path'
                  : 'click ring nodes above to add waypoints'}
              </div>
              <div
                className={[
                  'inline-flex max-w-full flex-wrap items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px]',
                    orbitCenterUi.found
                    ? 'border-accent-blue/60 text-fg-bright/90'
                    : 'border-border-soft text-fg-muted',
                ].join(' ')}
                title={orbitCenterUi.label}
              >
                <span className="font-semibold uppercase tracking-wider text-fg-muted">
                  orbit center
                </span>
                <span className="truncate">{orbitCenterUi.label}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClearWaypoints}
              disabled={waypoints.length === 0}
              className="text-[10px] uppercase tracking-wider text-fg-dim transition-colors hover:text-white disabled:opacity-40"
            >
              Clear All
            </button>
          </div>

          <div className="mb-2 max-h-[140px] space-y-1 overflow-y-auto pr-1">
            {waypoints.length === 0 ? (
              <div className="flex h-[80px] items-center justify-center rounded-macos border border-dashed border-border-medium px-3 text-center text-[10px] leading-relaxed text-fg-muted">
                Empty. Pick a few points on the sphere above (5 lat rings × 8 nodes each) to build a camera path. Plays alongside Handheld Shake.
              </div>
            ) : (
              waypoints.map((w, i) => {
                const isSelected = w.id === selectedWaypointId;
                const makeSlider = (
                  label: string,
                  value: number,
                  min: number,
                  max: number,
                  step: number,
                  decimals: number,
                  onChange: (v: number) => void,
                  hint?: string,
                ) => (
                  <label className="flex items-center gap-2 text-[10px] text-fg-dim">
                    <span className="w-10 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                      {label}
                    </span>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      step={step}
                      value={value}
                      onChange={(e) => {
                        onSelectWaypoint(w.id);
                        onChange(Number(e.target.value));
                      }}
                      className="slider flex-1"
                    />
                    <span className="w-10 shrink-0 text-right font-mono text-[10px] text-fg-bright">
                      {value.toFixed(decimals)}
                    </span>
                    {hint ? (
                      <span className="w-10 shrink-0 text-right font-mono text-[9px] text-fg-muted">
                        {hint}
                      </span>
                    ) : null}
                  </label>
                );
                return (
                  <div
                    key={w.id}
                    className={[
                      'rounded-macos border bg-bg-input px-2 py-1.5 transition-colors',
                      isSelected
                        ? 'border-accent-blue'
                        : 'border-border-soft hover:border-border-medium',
                    ].join(' ')}
                  >
                    <div
                      className="flex items-center gap-1.5 cursor-pointer"
                      onClick={() => onSelectWaypoint(isSelected ? null : w.id)}
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-blue text-[10px] font-bold text-bg-deep">
                        {i + 1}
                      </span>
                      <span className="font-mono text-[10px] text-fg-muted">
                        {w.lat > 0
                          ? `N${w.lat}`
                          : w.lat < 0
                          ? `S${-w.lat}`
                          : 'Eq'} · {w.lon.toFixed(0)}°
                      </span>
                      <label
                        className="ml-auto flex items-center gap-1 text-[10px] text-fg-dim"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span>zoom</span>
                        <input
                          type="range"
                          min={0.6}
                          max={1.7}
                          step={0.01}
                          value={w.dolly}
                          onChange={(e) => {
                            onSelectWaypoint(w.id);
                            onChangeDolly(w.id, Number(e.target.value));
                          }}
                          className="slider w-20"
                        />
                        <span className="w-10 shrink-0 text-right font-mono text-[10px] text-fg-bright">
                          {w.dolly.toFixed(2)}
                        </span>
                      </label>
                    </div>
                    {isSelected ? (
                      <div className="mt-2 space-y-1.5 border-t border-border-soft pt-2">
                        <div className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-fg-muted">
                          position offset
                        </div>
                        {makeSlider('X · ←→', w.x, -2, 2, 0.01, 2, (v) => onChangeX(w.id, v))}
                        {makeSlider('Y · ↑↓', w.y, -2, 2, 0.01, 2, (v) => onChangeY(w.id, v))}
                        {makeSlider('Z · depth', w.z, -2, 2, 0.01, 2, (v) => onChangeZ(w.id, v), '+fore/-back')}
                        <div className="mb-1 mt-2 text-[9px] font-semibold uppercase tracking-widest text-fg-muted">
                          look angles
                        </div>
                        {makeSlider('Pitch', w.lookX, -45, 45, 0.5, 1, (v) => onChangeLookX(w.id, v), '↑+ ↓-')}
                        {makeSlider('Yaw', w.lookY, -45, 45, 0.5, 1, (v) => onChangeLookY(w.id, v), '→+ ←-')}
                        {makeSlider('Roll', w.lookZ, -15, 15, 0.5, 1, (v) => onChangeLookZ(w.id, v), '+cw -ccw')}
                      </div>
                    ) : null}
                    <div className="mt-1 flex items-center justify-end gap-0.5 border-t border-transparent pt-1">
                      <button
                        type="button"
                        title="Move earlier"
                        disabled={i === 0}
                        onClick={(e) => { e.stopPropagation(); onMoveWaypoint(w.id, -1); }}
                        className="h-5 w-5 text-fg-dim transition-colors hover:text-fg-bright disabled:opacity-30"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        title="Move later"
                        disabled={i === waypoints.length - 1}
                        onClick={(e) => { e.stopPropagation(); onMoveWaypoint(w.id, 1); }}
                        className="h-5 w-5 text-fg-dim transition-colors hover:text-fg-bright disabled:opacity-30"
                      >
                        →
                      </button>
                      <button
                        type="button"
                        title="Remove waypoint"
                        onClick={(e) => { e.stopPropagation(); onRemoveWaypoint(w.id); }}
                        className="h-5 w-5 text-fg-dim transition-colors hover:text-fg-bright"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <button
            type="button"
            onClick={() => onToggleCloseLoop(!closeLoop)}
            className="mb-2 flex w-full items-center justify-between rounded-macos border border-border-soft bg-bg-input px-3 py-2 text-[11px] font-medium tracking-wide text-fg-dim transition-colors hover:border-border-medium hover:text-fg-bright"
          >
            <span>Loop</span>
            <span
              className={[
                'relative inline-block h-4 w-7 rounded-full transition-colors',
                closeLoop ? 'bg-accent-blue' : 'bg-border-medium',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 h-3 w-3 rounded-full transition-all',
                  closeLoop
                    ? 'left-[calc(100%-14px)] bg-white'
                    : 'left-0.5 bg-fg-muted',
                ].join(' ')}
              />
            </span>
          </button>

          <button
            type="button"
            onClick={onPlayCustom}
            disabled={waypoints.length === 0}
            className={[
              'btn h-10 w-full',
              isCustomActive && playing ? '!bg-accent-blue !text-bg-deep' : '',
            ].join(' ')}
          >
            {isCustomActive && playing
              ? 'Replay Sphere'
              : waypoints.length === 0
              ? 'Add waypoints to play'
              : 'Play This Sphere Path'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------- Walk Path Editor ------------- */

interface WalkEditorProps {
  waypoints: readonly WalkWaypoint[];
  closeLoop: boolean;
  isWalkActive: boolean;
  playing: boolean;
  currentProgress: number;
  selectedWaypointId: string | null;
  onSelectWaypoint: (id: string | null) => void;
  onAddWaypoint: (x: number, y: number, z: number) => void;
  onRemoveWaypoint: (id: string) => void;
  onMoveWaypoint: (id: string, delta: -1 | 1) => void;
  onChangeLook: (id: string, field: 'lookX' | 'lookY' | 'lookZ', value: number) => void;
  onChangeDolly: (id: string, dolly: number) => void;
  onChangePosition: (id: string, field: 'x' | 'y' | 'z', value: number) => void;
  onClearWaypoints: () => void;
  onToggleCloseLoop: (v: boolean) => void;
  onPlayWalk: () => void;
}

function WalkEditor({
  waypoints,
  closeLoop,
  isWalkActive,
  playing,
  currentProgress,
  selectedWaypointId,
  onSelectWaypoint,
  onAddWaypoint,
  onRemoveWaypoint,
  onMoveWaypoint,
  onChangeLook,
  onChangeDolly,
  onChangePosition,
  onClearWaypoints,
  onToggleCloseLoop,
  onPlayWalk,
}: WalkEditorProps) {
  const SVG_W = 260;
  const SVG_H = 200;
  const ISO_SCALE = 58; // px per unit in iso projection

  // Isometric projection: 3D (x, y, z) → 2D screen (sx, sy)
  // x = left/right, y = up/down, z = forward/back (into scene)
  const proj = (x: number, y: number, z: number) => {
    const sx = SVG_W / 2 + (x - z) * ISO_SCALE * 0.866;
    const sy = SVG_H / 2 + (x + z) * ISO_SCALE * 0.5 - y * ISO_SCALE;
    return { sx, sy };
  };

  // Cube corners: the virtual scene is a unit cube [-1,1]³
  const cubeCorners = [
    proj(-1, -1, -1), // 0 back-bottom-left
    proj(1, -1, -1),  // 1 back-bottom-right
    proj(1, 1, -1),   // 2 back-top-right
    proj(-1, 1, -1),  // 3 back-top-left
    proj(-1, -1, 1),  // 4 front-bottom-left
    proj(1, -1, 1),   // 5 front-bottom-right
    proj(1, 1, 1),    // 6 front-top-right
    proj(-1, 1, 1),   // 7 front-top-left
  ];

  // Cube edges (pairs of corner indices)
  const cubeEdges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // back face
    [4, 5], [5, 6], [6, 7], [7, 4], // front face
    [0, 4], [1, 5], [2, 6], [3, 7], // connecting edges
  ];

  // Spline path segments in 3D
  const splineSegments = useMemo(() => {
    if (waypoints.length < 2) return [];
    const out: { x1: number; y1: number; x2: number; y2: number; depth: number }[] = [];
    const segs = Math.max(120, waypoints.length * 30);
    let prev: { sx: number; sy: number; z: number } | null = null;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const rig = evaluateWalkTrajectory(waypoints, u, closeLoop);
      // Reconstruct approx 3D position from rig
      const px = rig.panX / 500;
      const py = -rig.panY / 500;
      const pz = rig.z / 900;
      const { sx, sy } = proj(px, py, pz);
      if (prev) {
        const avgZ = (prev.z + pz) / 2;
        out.push({ x1: prev.sx, y1: prev.sy, x2: sx, y2: sy, depth: avgZ });
      }
      prev = { sx, sy, z: pz };
    }
    return out;
  }, [waypoints, closeLoop]);

  // Current camera position
  const cameraPos = useMemo(() => {
    if (waypoints.length === 0 || !isWalkActive) return null;
    const rig = evaluateWalkTrajectory(waypoints, currentProgress, closeLoop);
    const px = rig.panX / 500;
    const py = -rig.panY / 500;
    const pz = rig.z / 900;
    const { sx, sy } = proj(px, py, pz);
    return { sx, sy, z: pz };
  }, [waypoints, currentProgress, closeLoop, isWalkActive]);

  return (
    <div className="macos-card mb-4 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="subsection-title !mb-0">
            {WALK_TRAJECTORY_LABEL}
          </span>
          <span className="font-mono text-[10px] text-fg-muted">
            3D walk-through · camera moves, text stays still
          </span>
          {isWalkActive && (
            <span
              className={[
                'inline-flex items-center rounded-macos border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                playing
                  ? 'border-accent-blue bg-accent-blue text-bg-deep'
                  : 'border-accent-blue text-fg-bright',
              ].join(' ')}
            >
              {playing ? 'walking' : 'paused'}
            </span>
          )}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-fg-muted">
          {waypoints.length} wp
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {/* 3D Isometric view — click to add waypoints (X-Z plane at Y=0) */}
        <div className="relative flex justify-center rounded-macos border border-border-soft bg-bg-input p-2">
          <svg
            width={SVG_W}
            height={SVG_H}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            className="block cursor-crosshair"
            onClick={(e) => {
              // Inverse iso projection: click → (x, z) at y=0
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = ((e.clientX - rect.left) / rect.width) * SVG_W - SVG_W / 2;
              const my = ((e.clientY - rect.top) / rect.height) * SVG_H - SVG_H / 2;
              // Inverse of: sx = (x - z) * ISO * 0.866, sy = (x + z) * ISO * 0.5
              const a = mx / (ISO_SCALE * 0.866);
              const b = my / (ISO_SCALE * 0.5);
              const nx = (a + b) / 2;
              const nz = (b - a) / 2;
              const clampedX = Math.max(-2, Math.min(2, nx));
              const clampedZ = Math.max(-2, Math.min(2, nz));
              onAddWaypoint(clampedX, 0, clampedZ);
            }}
          >
            {/* Cube frame — back edges dimmer, front edges brighter */}
            {cubeEdges.map(([a, b], i) => {
              const isBack = a < 4 && b < 4;
              return (
                <line
                  key={i}
                  x1={cubeCorners[a].sx}
                  y1={cubeCorners[a].sy}
                  x2={cubeCorners[b].sx}
                  y2={cubeCorners[b].sy}
                  stroke={isBack ? 'var(--color-border-medium)' : 'var(--color-border-strong)'}
                  strokeWidth={1}
                  strokeDasharray={isBack ? '3 3' : undefined}
                />
              );
            })}

            {/* Axis labels */}
            <text x={proj(1.15, 0, 0).sx} y={proj(1.15, 0, 0).sy + 4} fontSize="8" fill="var(--color-fg-muted)" textAnchor="middle">X</text>
            <text x={proj(0, 1.15, 0).sx} y={proj(0, 1.15, 0).sy} fontSize="8" fill="var(--color-fg-muted)" textAnchor="middle">Y</text>
            <text x={proj(0, 0, 1.15).sx} y={proj(0, 0, 1.15).sy + 4} fontSize="8" fill="var(--color-fg-muted)" textAnchor="middle">Z</text>

            {/* Path spline — depth affects opacity */}
            {splineSegments.length > 0 && (
              <g pointerEvents="none">
                {splineSegments.map((seg, i) => (
                  <line
                    key={i}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke="var(--color-accent-blue)"
                    strokeOpacity={0.3 + Math.max(0, Math.min(1, (seg.depth + 1) / 2)) * 0.5}
                    strokeWidth={1.2}
                    strokeDasharray="3 2"
                  />
                ))}
              </g>
            )}

            {/* Waypoint nodes in 3D */}
            {waypoints.map((w, i) => {
              const { sx, sy } = proj(w.x, w.y, w.z);
              const depthFactor = Math.max(0, Math.min(1, (w.z + 1) / 2)); // 0=back, 1=front
              const isSelected = w.id === selectedWaypointId;
              const r = (5 + depthFactor * 3) * (isSelected ? 1.4 : 1);
              const opacity = isSelected ? 1 : 0.4 + depthFactor * 0.6;
              const hasLook = w.lookX !== 0 || w.lookY !== 0;
              const arrowLen = 12;
              const ax = sx + (w.lookY / 45) * arrowLen;
              const ay = sy - (w.lookX / 45) * arrowLen;
              return (
                <g
                  key={w.id}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectWaypoint(w.id);
                  }}
                >
                  {isSelected && (
                    <circle cx={sx} cy={sy} r={r + 4} fill="none" stroke="var(--color-accent-blue)" strokeWidth={1} strokeDasharray="2 2" />
                  )}
                  {hasLook && (
                    <>
                      <line x1={sx} y1={sy} x2={ax} y2={ay} stroke="var(--color-accent-blue)" strokeWidth={1} strokeOpacity={opacity * 0.7} />
                      <circle cx={ax} cy={ay} r="1.5" fill="var(--color-accent-blue)" fillOpacity={opacity * 0.7} />
                    </>
                  )}
                  <circle cx={sx} cy={sy} r={r} fill={isSelected ? 'var(--color-accent-blue)' : 'var(--color-accent-blue)'} fillOpacity={opacity} stroke={isSelected ? 'var(--color-accent-blue)' : 'var(--color-accent-blue)'} strokeWidth={isSelected ? 2 : 1} strokeOpacity={opacity} />
                  <text x={sx} y={sy + 3} textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--color-bg-card)" fillOpacity={opacity}>
                    {i + 1}
                  </text>
                </g>
              );
            })}

            {/* Camera position indicator */}
            {cameraPos && (
              <g pointerEvents="none">
                <circle cx={cameraPos.sx} cy={cameraPos.sy} r="9" fill="none" stroke="var(--color-accent-blue)" strokeWidth={1.2} strokeDasharray="2 2" />
                <circle cx={cameraPos.sx} cy={cameraPos.sy} r="2.5" fill="var(--color-accent-blue)" />
              </g>
            )}
          </svg>
        </div>

        <div className="text-center text-[9px] leading-relaxed text-fg-muted">
          Click in the 3D view to place camera positions (X-Z plane).
          Use the Z slider below to push the camera forward / backward.
        </div>

        {/* Waypoint list with 3D position + look-direction controls */}
        <div className="min-w-0 rounded-macos border border-border-soft bg-bg-input p-2.5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-widest text-fg-muted">
              waypoints
            </div>
            <button
              type="button"
              onClick={onClearWaypoints}
              disabled={waypoints.length === 0}
              className="text-[10px] uppercase tracking-wider text-fg-dim transition-colors hover:text-white disabled:opacity-40"
            >
              Clear All
            </button>
          </div>

          <div className="mb-2 max-h-[240px] space-y-1.5 overflow-y-auto pr-1">
            {waypoints.length === 0 ? (
              <div className="flex h-[60px] items-center justify-center rounded-macos border border-dashed border-border-medium px-3 text-center text-[10px] leading-relaxed text-fg-muted">
                Click in the 3D view to place camera positions.
              </div>
            ) : (
              waypoints.map((w, i) => (
                <div
                  key={w.id}
                  className={[
                    'rounded-macos border px-2 py-1.5 cursor-pointer transition-colors',
                    w.id === selectedWaypointId
                      ? 'border-accent-blue bg-bg-input'
                      : 'border-border-soft bg-bg-input hover:border-border-medium',
                  ].join(' ')}
                  onClick={() => onSelectWaypoint(w.id)}
                >
                  <div className="mb-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-blue text-[10px] font-bold text-bg-deep">
                      {i + 1}
                    </span>
                    <span className="font-mono text-[10px] text-fg-muted">
                      ({w.x.toFixed(1)}, {w.y.toFixed(1)}, {w.z.toFixed(1)})
                    </span>
                    <div className="ml-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        title="Move earlier"
                        disabled={i === 0}
                        onClick={() => onMoveWaypoint(w.id, -1)}
                        className="h-5 w-5 text-fg-dim transition-colors hover:text-fg-bright disabled:opacity-30"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        title="Move later"
                        disabled={i === waypoints.length - 1}
                        onClick={() => onMoveWaypoint(w.id, 1)}
                        className="h-5 w-5 text-fg-dim transition-colors hover:text-fg-bright disabled:opacity-30"
                      >
                        →
                      </button>
                      <button
                        type="button"
                        title="Remove waypoint"
                        onClick={() => onRemoveWaypoint(w.id)}
                        className="h-5 w-5 text-fg-dim transition-colors hover:text-fg-bright"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  {/* 3D Position sliders: X (left/right), Y (up/down), Z (depth) */}
                  <div className="mb-1.5 grid grid-cols-3 gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <div>
                      <div className="mb-0.5 flex items-center justify-between text-[9px] text-fg-muted">
                        <span>X · ←→</span>
                        <span className="font-mono">{w.x.toFixed(2)}</span>
                      </div>
                      <input type="range" className="slider" min={-2} max={2} step={0.01} value={w.x}
                        onChange={(e) => { onSelectWaypoint(w.id); onChangePosition(w.id, 'x', Number(e.target.value)); }} />
                    </div>
                    <div>
                      <div className="mb-0.5 flex items-center justify-between text-[9px] text-fg-muted">
                        <span>Y · ↑↓</span>
                        <span className="font-mono">{w.y.toFixed(2)}</span>
                      </div>
                      <input type="range" className="slider" min={-2} max={2} step={0.01} value={w.y}
                        onChange={(e) => { onSelectWaypoint(w.id); onChangePosition(w.id, 'y', Number(e.target.value)); }} />
                    </div>
                    <div>
                      <div className="mb-0.5 flex items-center justify-between text-[9px] text-fg-muted">
                        <span>Z · depth</span>
                        <span className="font-mono">{w.z > 0 ? '→' : w.z < 0 ? '←' : '—'}{Math.abs(w.z).toFixed(2)}</span>
                      </div>
                      <input type="range" className="slider" min={-2} max={2} step={0.01} value={w.z}
                        onChange={(e) => { onSelectWaypoint(w.id); onChangePosition(w.id, 'z', Number(e.target.value)); }} />
                    </div>
                  </div>

                  {/* Look direction sliders */}
                  <div className="grid grid-cols-3 gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <div>
                      <div className="mb-0.5 flex items-center justify-between text-[9px] text-fg-muted">
                        <span>Pitch</span>
                        <span className="font-mono">{w.lookX > 0 ? '↑' : w.lookX < 0 ? '↓' : '—'}{Math.abs(w.lookX).toFixed(0)}°</span>
                      </div>
                      <input type="range" className="slider" min={-45} max={45} step={1} value={w.lookX}
                        onChange={(e) => { onSelectWaypoint(w.id); onChangeLook(w.id, 'lookX', Number(e.target.value)); }} />
                    </div>
                    <div>
                      <div className="mb-0.5 flex items-center justify-between text-[9px] text-fg-muted">
                        <span>Yaw</span>
                        <span className="font-mono">{w.lookY > 0 ? '→' : w.lookY < 0 ? '←' : '—'}{Math.abs(w.lookY).toFixed(0)}°</span>
                      </div>
                      <input type="range" className="slider" min={-45} max={45} step={1} value={w.lookY}
                        onChange={(e) => { onSelectWaypoint(w.id); onChangeLook(w.id, 'lookY', Number(e.target.value)); }} />
                    </div>
                    <div>
                      <div className="mb-0.5 flex items-center justify-between text-[9px] text-fg-muted">
                        <span>Roll</span>
                        <span className="font-mono">{w.lookZ.toFixed(0)}°</span>
                      </div>
                      <input type="range" className="slider" min={-15} max={15} step={1} value={w.lookZ}
                        onChange={(e) => { onSelectWaypoint(w.id); onChangeLook(w.id, 'lookZ', Number(e.target.value)); }} />
                    </div>
                  </div>

                  {/* Dolly slider */}
                  <div className="mt-1.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <span className="text-[9px] text-fg-muted">Zoom</span>
                    <input type="range" className="slider flex-1" min={0.6} max={1.7} step={0.01} value={w.dolly}
                      onChange={(e) => { onSelectWaypoint(w.id); onChangeDolly(w.id, Number(e.target.value)); }} />
                    <span className="font-mono text-[9px] text-fg-muted">{w.dolly.toFixed(2)}×</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <button
            type="button"
            onClick={() => onToggleCloseLoop(!closeLoop)}
            className="mb-2 flex w-full items-center justify-between rounded-macos border border-border-soft bg-bg-input px-3 py-2 text-[11px] font-medium tracking-wide text-fg-dim transition-colors hover:border-border-medium hover:text-fg-bright"
          >
            <span>Loop</span>
            <span
              className={[
                'relative inline-block h-4 w-7 rounded-full transition-colors',
                closeLoop ? 'bg-accent-blue' : 'bg-border-medium',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 h-3 w-3 rounded-full transition-all',
                  closeLoop
                    ? 'left-[calc(100%-14px)] bg-white'
                    : 'left-0.5 bg-fg-muted',
                ].join(' ')}
              />
            </span>
          </button>

          <button
            type="button"
            onClick={onPlayWalk}
            disabled={waypoints.length === 0}
            className={[
              'btn h-10 w-full',
              isWalkActive && playing ? '!bg-accent-blue !text-bg-deep' : '',
            ].join(' ')}
          >
            {isWalkActive && playing
              ? 'Replay Walk Path'
              : waypoints.length === 0
              ? 'Add waypoints to play'
              : 'Play Walk Path'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CameraMotionPanel;
