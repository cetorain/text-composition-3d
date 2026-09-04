import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toPng, toCanvas } from 'html-to-image';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { useCameraPlayer, CUSTOM_TRAJECTORY_ID, WALK_TRAJECTORY_ID, composeRigs, DEFAULT_CAMERA, evaluateCustomTrajectory, evaluateWalkTrajectory, evaluateHandheld } from './camera';
import { generateSvg, downloadSvg } from './svgExport';

/** CSS animation durations in ms (must match index.css). */
const ANIM_DURATIONS: Record<string, number> = {
  expand: 1600,
  contract: 1600,
  pulse: 2200,
  sway: 3000,
  float: 3200,
  shake: 700,
};

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b > 0) { [a, b] = [b, a % b]; }
  return a || 1;
}

function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

/** Convert blob: or other url to a data URL so html-to-image can rasterize it. */
async function backgroundImageToDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => resolve(String(fr.result ?? url));
      fr.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}
import type { CameraRig, HandheldSettings, SphereWaypoint, WalkWaypoint } from './camera';
import { ControlPanel } from './components/ControlPanel';
import { FontFaceStyle } from './components/FontManager';
import { PreviewCanvas } from './components/PreviewCanvas';
import type {
  AnimationType,
  BackgroundColor,
  BackgroundFit,
  BackgroundImage,
  BackgroundImageSettings,
  CanvasSize,
  CustomFont,
  TextLayer,
} from './types';
import {
  BACKGROUND_COLORS,
  CANVAS_PRESETS,
  DEFAULT_FONT_FAMILY,
  DEFAULT_LETTER_SPACING,
  DEFAULT_LINE_HEIGHT,
  createInitialLayers,
  genId,
} from './types';

/* ---------- Undo history (document-level) ---------- */

interface HistorySnapshot {
  layers: TextLayer[];
  canvasSize: CanvasSize;
  background: BackgroundColor;
  backgroundImage: BackgroundImage | null;
  backgroundFit: BackgroundFit;
  backgroundOpacity: number;
  customFonts: CustomFont[];
  pausedLayerIds: Set<string>;
  customWaypoints: SphereWaypoint[];
  customCloseLoop: boolean;
  walkWaypoints: WalkWaypoint[];
  walkCloseLoop: boolean;
  selectedId: string | null;
  // Legacy single-track camera state (preserved for cross-version loads)
  cameraTrajectoryId: string | null;
  cameraPlaying: boolean;
  cameraProgress: number;
  // Dual-track camera state (source of truth for new snapshots)
  cameraSpherePlaying?: boolean;
  cameraSphereProgress?: number;
  cameraWalkPlaying?: boolean;
  cameraWalkProgress?: number;
  handheldEnabled: boolean;
  handheldPlaying: boolean;
  handheldTimeMs: number;
  handheldSettings: HandheldSettings;
}

const MAX_HISTORY = 60;

function cloneSnapshot(s: HistorySnapshot): HistorySnapshot {
  return {
    layers: s.layers.map((l) => ({
      ...l,
      transform: { ...l.transform },
    })),
    canvasSize: s.canvasSize,
    background: s.background,
    backgroundImage: s.backgroundImage ? { ...s.backgroundImage } : null,
    backgroundFit: s.backgroundFit,
    backgroundOpacity: s.backgroundOpacity,
    customFonts: s.customFonts.map((f) => ({ ...f })),
    pausedLayerIds: new Set(s.pausedLayerIds),
    customWaypoints: s.customWaypoints.map((w) => ({ ...w })),
    customCloseLoop: s.customCloseLoop,
    walkWaypoints: s.walkWaypoints.map((w) => ({ ...w })),
    walkCloseLoop: s.walkCloseLoop,
    selectedId: s.selectedId,
    cameraTrajectoryId: s.cameraTrajectoryId,
    cameraPlaying: s.cameraPlaying,
    cameraProgress: s.cameraProgress,
    handheldEnabled: s.handheldEnabled,
    handheldPlaying: s.handheldPlaying,
    handheldTimeMs: s.handheldTimeMs,
    handheldSettings: { ...s.handheldSettings },
  };
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
    return saved === 'light' ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* noop */ }
  }, [theme]);

  const [layers, setLayers] = useState<TextLayer[]>(() => createInitialLayers());
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const initial = createInitialLayers();
    return initial[0]?.id ?? null;
  });
  const [canvasSize, setCanvasSize] = useState<CanvasSize>(CANVAS_PRESETS[0]);
  const [background, setBackground] = useState<BackgroundColor>('Black');
  const [backgroundImage, setBackgroundImage] = useState<BackgroundImage | null>(null);
  const [backgroundFit, setBackgroundFit] = useState<BackgroundFit>('Cover');
  const [backgroundOpacity, setBackgroundOpacity] = useState(1); // 0..1
  const bgSettings: BackgroundImageSettings = useMemo(
    () => ({
      image: backgroundImage,
      opacity: backgroundOpacity,
      fit: backgroundFit,
    }),
    [backgroundFit, backgroundImage, backgroundOpacity],
  );
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [pausedLayerIds, setPausedLayerIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [videoExporting, setVideoExporting] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);

  const camera = useCameraPlayer();
  const cameraRig: CameraRig = camera.state.rig;

  /* ---------- Undo helpers ---------- */

  const undoStackRef = useRef<HistorySnapshot[]>([]);
  const restoringRef = useRef(false);
  const [undoCount, setUndoCount] = useState(0);
  const canUndo = undoCount > 0;

  const takeSnapshot = useCallback((): HistorySnapshot => {
    return cloneSnapshot({
      layers,
      canvasSize,
      background,
      backgroundImage,
      backgroundFit,
      backgroundOpacity,
      customFonts,
      pausedLayerIds,
      customWaypoints: camera.state.customWaypoints,
      customCloseLoop: camera.state.customCloseLoop,
      walkWaypoints: camera.state.walkWaypoints,
      walkCloseLoop: camera.state.walkCloseLoop,
      selectedId,
      // Legacy fields for backward compat of old HistorySnapshots on disk
      cameraTrajectoryId: camera.state.trajectoryId,
      cameraPlaying: camera.state.playing,
      cameraProgress: camera.state.progress,
      // Dual-track: these are the source of truth going forward.
      cameraSpherePlaying: camera.state.spherePlaying,
      cameraSphereProgress: camera.state.sphereProgress,
      cameraWalkPlaying: camera.state.walkPlaying,
      cameraWalkProgress: camera.state.walkProgress,
      handheldEnabled: camera.state.handheldEnabled,
      handheldPlaying: camera.state.handheldPlaying,
      handheldTimeMs: camera.state.handheldTimeMs,
      handheldSettings: { ...camera.state.handheldSettings },
    });
  }, [
    layers,
    canvasSize,
    background,
    backgroundImage,
    backgroundFit,
    backgroundOpacity,
    customFonts,
    pausedLayerIds,
    camera.state.customWaypoints,
    camera.state.customCloseLoop,
    camera.state.walkWaypoints,
    camera.state.walkCloseLoop,
    camera.state.trajectoryId,
    camera.state.playing,
    camera.state.progress,
    camera.state.spherePlaying,
    camera.state.sphereProgress,
    camera.state.walkPlaying,
    camera.state.walkProgress,
    camera.state.handheldEnabled,
    camera.state.handheldPlaying,
    camera.state.handheldTimeMs,
    camera.state.handheldSettings,
    selectedId,
  ]);

  /**
   * Call BEFORE applying a user-triggered document mutation (ExperienceRecall
   * rule: save pre-state *before* the action so Undo can return to the exact
   * previous view). No-ops while restoring to avoid stacking.
   */
  const pushUndo = useCallback(() => {
    if (restoringRef.current) return;
    const snap = takeSnapshot();
    undoStackRef.current.push(snap);
    if (undoStackRef.current.length > MAX_HISTORY) {
      undoStackRef.current.splice(0, undoStackRef.current.length - MAX_HISTORY);
    }
    setUndoCount(undoStackRef.current.length);
  }, [takeSnapshot]);

  const applySnapshot = useCallback((s: HistorySnapshot) => {
    restoringRef.current = true;
    try {
      setLayers(s.layers);
      setSelectedId(
        s.selectedId && s.layers.some((l) => l.id === s.selectedId)
          ? s.selectedId
          : s.layers[0]?.id ?? null,
      );
      setCanvasSize(s.canvasSize);
      setBackground(s.background);
      setBackgroundImage((prev) => {
        if (prev && prev.url !== s.backgroundImage?.url) {
          // Don't revoke blobs from former states: they may still be in
          // history so the user can re-undo back to them. We instead let
          // unmount cleanup handle final revocation.
        }
        return s.backgroundImage;
      });
      setBackgroundFit(s.backgroundFit);
      setBackgroundOpacity(s.backgroundOpacity);
      setCustomFonts(s.customFonts);
      setPausedLayerIds(s.pausedLayerIds);
      camera.setCustomWaypoints(s.customWaypoints);
      camera.setCustomCloseLoop(s.customCloseLoop);
      camera.setWalkWaypoints(s.walkWaypoints);
      camera.setWalkCloseLoop(s.walkCloseLoop);
      // Pass legacy 9 args first (for the function signature), then the new
      // dual-track fields as source of truth.
      camera.restorePlayerSnapshot(
        s.cameraTrajectoryId,
        s.cameraPlaying,
        s.cameraProgress,
        s.handheldEnabled,
        s.handheldPlaying,
        s.handheldTimeMs,
        s.handheldSettings,
        s.walkWaypoints,
        s.walkCloseLoop,
        // Dual-track override fields (priority 1)
        s.cameraSpherePlaying,
        s.cameraSphereProgress,
        s.cameraWalkPlaying,
        s.cameraWalkProgress,
      );
    } finally {
      // Defer so any setState listeners triggered in the same microtask
      // batch are covered by the guard.
      Promise.resolve().then(() => {
        restoringRef.current = false;
      });
    }
  }, [camera]);

  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setUndoCount(undoStackRef.current.length);
    applySnapshot(prev);
  }, [applySnapshot]);

  /* ---------- Layout: fit canvas into stage ---------- */
  useEffect(() => {
    const compute = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const padX = 64;
      const padY = 180; // leave room for bottom buttons
      const availW = Math.max(320, rect.width - padX);
      const availH = Math.max(320, rect.height - padY);
      const s = Math.min(availW / canvasSize.width, availH / canvasSize.height, 1);
      setScale(s > 0 ? s : 0.1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (stageRef.current) ro.observe(stageRef.current);
    window.addEventListener('resize', compute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [canvasSize]);

  /* ---------- Font cleanup on unmount ---------- */
  useEffect(() => {
    return () => {
      customFonts.forEach((f) => {
        try {
          URL.revokeObjectURL(f.url);
        } catch {
          /* noop */
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Layer actions ---------- */
  const addLayer = useCallback(() => {
    pushUndo();
    const newLayer: TextLayer = {
      id: genId(),
      name: `Layer ${layers.length + 1}`,
      text: 'NEW TEXT',
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: 72,
      fontWeight: 'Bold',
      color: '#ffffff',
      align: 'Center',
      letterSpacing: DEFAULT_LETTER_SPACING,
      lineHeight: DEFAULT_LINE_HEIGHT,
      verticalOffset: 0,
      horizontalOffset: 0,
      transform: { rotateX: 0, rotateY: 0, rotateZ: 0, perspective: 900 },
      animation: 'none',
      animationKey: 0,
    };
    setLayers((prev) => [...prev, newLayer]);
    setSelectedId(newLayer.id);
  }, [layers.length, pushUndo]);

  /** Parse an SVG file into its content string + intrinsic size (with sensible defaults) */
  const parseSvgFile = useCallback(
    async (file: File): Promise<{ svg: string; width: number; height: number }> => {
      const text = await file.text();
      let w = 200;
      let h = 200;
      try {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const parseErr = doc.querySelector('parsererror');
        if (parseErr) throw new Error('SVG parse error');
        const root = doc.querySelector('svg') as SVGSVGElement | null;
        if (root) {
          // Try width/height attributes → viewBox → fall back to defaults
          const vb = root.getAttribute('viewBox')?.trim() || '';
          let vbW = 0;
          let vbH = 0;
          if (vb) {
            const parts = vb.split(/[\s,]+/).map(Number);
            if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
              vbW = parts[2];
              vbH = parts[3];
            }
          }
          const attrW = root.getAttribute('width');
          const attrH = root.getAttribute('height');
          const toPx = (s: string | null): number | null => {
            if (!s) return null;
            const n = parseFloat(s);
            if (Number.isNaN(n)) return null;
            if (s.endsWith('mm')) return n * 3.78;
            if (s.endsWith('cm')) return n * 37.8;
            if (s.endsWith('in')) return n * 96;
            if (s.endsWith('pt')) return n * 1.333;
            if (s.endsWith('pc')) return n * 16;
            return n;
          };
          const wPx = toPx(attrW);
          const hPx = toPx(attrH);
          if (wPx && hPx) {
            w = wPx;
            h = hPx;
          } else if (vbW && vbH) {
            // viewBox with no explicit size → assume 1 user-unit = 1px
            w = vbW;
            h = vbH;
          } else if (wPx && vbH) {
            w = wPx;
            h = (wPx / vbW) * vbH;
          } else if (hPx && vbW) {
            h = hPx;
            w = (hPx / vbH) * vbW;
          }
          // Ensure a minimum sensible size so the SVG is visible on import
          const maxSide = Math.max(w, h, 1);
          if (maxSide < 40) {
            const f = 80 / maxSide;
            w = Math.round(w * f);
            h = Math.round(h * f);
          } else if (maxSide > 800) {
            // Auto-scale import default so huge SVGs don't overflow canvas
            const f = 300 / maxSide;
            w = Math.round(w * f);
            h = Math.round(h * f);
          }
          // Normalize the injected <svg> so its DOM size matches the intrinsic
          // size (viewBox-based pixels) exactly. The user-facing zoom is then
          // applied by the renderer via transform:scale(svgScale) with a
          // center origin, which gives a true "zoom in/out" feel instead of
          // resizing from the top-left corner (which looked like a "move").
          //
          // We also make sure width/height are expressed as plain numbers (no
          // unit strings like "100%" or "48mm") so when the renderer places
          // the SVG into a sized wrapper it fills 1:1 without surprises.
          const cloned = root.cloneNode(true) as SVGSVGElement;
          // Guarantee a viewBox exists so rendering is always deterministic.
          if (!cloned.getAttribute('viewBox')) {
            cloned.setAttribute('viewBox', `0 0 ${w} ${h}`);
          }
          cloned.setAttribute('width', `${w}`);
          cloned.setAttribute('height', `${h}`);
          cloned.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          // Let authors keep their own fill/stroke — we avoid injecting
          // currentColor so brand/gradient SVGs stay visually identical
          // to the source file after import.
          const serializer = new XMLSerializer();
          const svgString = serializer.serializeToString(cloned);
          return { svg: svgString, width: w, height: h };
        }
      } catch (e) {
        console.warn('[importSvg] parse failed, falling back:', e);
      }
      return { svg: text, width: w, height: h };
    },
    [],
  );

  const importSvgLayer = useCallback(
    async (file: File) => {
      if (!file || !file.type.includes('svg') && !file.name.toLowerCase().endsWith('.svg')) return;
      let parsed;
      try {
        parsed = await parseSvgFile(file);
      } catch (e) {
        console.error('[importSvg] failed:', e);
        return;
      }
      pushUndo();
      const baseName = file.name.replace(/\.svg$/i, '') || 'SVG';
      const newLayer: TextLayer = {
        id: genId(),
        name: baseName,
        text: '',
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: 36,
        fontWeight: 'Normal',
        color: '#ffffff',
        align: 'Center',
        letterSpacing: DEFAULT_LETTER_SPACING,
        lineHeight: DEFAULT_LINE_HEIGHT,
        verticalOffset: 0,
        horizontalOffset: 0,
        transform: { rotateX: 0, rotateY: 0, rotateZ: 0, perspective: 900 },
        animation: 'none',
        animationKey: 0,
        svgContent: parsed.svg,
        svgWidth: parsed.width,
        svgHeight: parsed.height,
        svgScale: 1,
      };
      setLayers((prev) => [...prev, newLayer]);
      setSelectedId(newLayer.id);
    },
    [parseSvgFile, pushUndo],
  );

  const deleteLayer = useCallback((id: string) => {
    pushUndo();
    setLayers((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((l) => l.id !== id);
    });
    setPausedLayerIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelectedId((cur) => {
      if (cur !== id) return cur;
      return layers.find((l) => l.id !== id)?.id ?? null;
    });
  }, [layers, pushUndo]);

  const duplicateLayer = useCallback((id: string) => {
    pushUndo();
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1) return prev;
      const src = prev[idx];
      const copy: TextLayer = {
        ...src,
        id: genId(),
        name: `${src.name} Copy`,
        animation: 'none',
        animationKey: 0,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, [pushUndo]);

  const moveLayerUp = useCallback((id: string) => {
    pushUndo();
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx === prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }, [pushUndo]);

  const moveLayerDown = useCallback((id: string) => {
    pushUndo();
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx === 0) return prev;
      const next = [...prev];
      [next[idx], next[idx - 1]] = [next[idx - 1], next[idx]];
      return next;
    });
  }, [pushUndo]);

  const renameLayer = useCallback((id: string, name: string) => {
    pushUndo();
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, name: name.trim() || l.name } : l)),
    );
  }, [pushUndo]);

  const updateLayer = useCallback(
    <K extends keyof TextLayer>(id: string, key: K, value: TextLayer[K]) => {
      pushUndo();
      setLayers((prev) =>
        prev.map((l) => (l.id === id ? { ...l, [key]: value } : l)),
      );
    },
    [pushUndo],
  );

  const updateTransform = useCallback(
    (id: string, patch: Partial<TextLayer['transform']>) => {
      pushUndo();
      setLayers((prev) =>
        prev.map((l) =>
          l.id === id ? { ...l, transform: { ...l.transform, ...patch } } : l,
        ),
      );
    },
    [pushUndo],
  );

  const resetTransform = useCallback((id: string) => {
    pushUndo();
    setLayers((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              transform: { rotateX: 0, rotateY: 0, rotateZ: 0, perspective: 900 },
            }
          : l,
      ),
    );
  }, [pushUndo]);

  /* ---------- Fonts ---------- */
  const addFont = useCallback((font: CustomFont) => {
    pushUndo();
    setCustomFonts((prev) => {
      // Avoid re-adding exact same file/name combo
      if (prev.some((f) => f.sourceName === font.sourceName && f.url === font.url)) {
        // Nothing actually changes — roll back the guard snapshot so canUndo
        // doesn't incorrectly become true.
        undoStackRef.current.pop();
        setUndoCount(undoStackRef.current.length);
        return prev;
      }
      return [...prev, font];
    });
  }, [pushUndo]);

  const removeFont = useCallback((id: string) => {
    pushUndo();
    setCustomFonts((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) {
        // NOTE: don't revokeObjectURL(target.url) here — the URL may still be
        // referenced by history snapshots and we want Undo → Restore Font to
        // keep working. Final revocation happens on app unmount.
        // Any layer using this font reverts to default
        setLayers((ls) =>
          ls.map((l) =>
            l.fontFamily === target.id ? { ...l, fontFamily: DEFAULT_FONT_FAMILY } : l,
          ),
        );
      }
      return prev.filter((f) => f.id !== id);
    });
  }, [pushUndo]);

  /* ---------- Background image ---------- */
  const setBackgroundImageFromFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    try {
      const dims = await new Promise<{ width: number; height: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 0, height: 0 });
        img.src = url;
      });
      const img: BackgroundImage = {
        id: genId(),
        sourceName: file.name,
        url,
        width: dims.width,
        height: dims.height,
      };
      pushUndo();
      setBackgroundImage(() => {
        // Don't revoke previous URL — history may need to restore it.
        return img;
      });
    } catch {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
    }
  }, [pushUndo]);

  const removeBackgroundImage = useCallback(() => {
    pushUndo();
    setBackgroundImage((prev) => {
      if (prev) {
        // Keep URL alive in history for undo-back-to-it scenario.
      }
      return null;
    });
  }, [pushUndo]);

  /* ---------- Cleanup blobs on unmount ---------- */
  useEffect(() => {
    return () => {
      if (backgroundImage) {
        try {
          URL.revokeObjectURL(backgroundImage.url);
        } catch {
          /* noop */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Animation (per layer, independent) ---------- */

  /**
   * Set the animation on this specific layer only.
   * Other layers keep whatever motion they already have.
   * Clicking the same motion again re-triggers it from the start.
   */
  const setLayerAnimation = useCallback((id: string, anim: AnimationType) => {
    pushUndo();
    setLayers((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const sameAsBefore = l.animation === anim && anim !== 'none';
        return {
          ...l,
          animation: anim,
          animationKey: sameAsBefore ? l.animationKey + 1 : l.animationKey,
        };
      }),
    );
    if (anim !== 'none') {
      setPausedLayerIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [pushUndo]);

  const togglePauseLayer = useCallback((id: string) => {
    pushUndo();
    setPausedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [pushUndo]);

  // NOTE: stopAllAnimations kept for future controls; currently unused but
  // retained inline (not declared) to keep TS noUnusedLocals clean.

  const pauseAllAnimations = useCallback(() => {
    pushUndo();
    // Freeze every CSS layer animation currently running.
    setPausedLayerIds((prev) => {
      const next = new Set(prev);
      layers.forEach((l) => {
        if (l.animation !== 'none') next.add(l.id);
      });
      return next;
    });
    // Freeze camera motion (preset trajectories AND custom sphere paths),
    // but preserve elapsed + progress so Resume All continues exactly
    // where it was instead of rewinding.
    camera.softPause();
  }, [camera, layers, pushUndo]);

  const resumeAllAnimations = useCallback(() => {
    pushUndo();
    setPausedLayerIds(new Set());
    camera.softResume();
  }, [camera, pushUndo]);

  /* ---------- Document-wide canvas/background props (undoable setters) ---------- */

  const onChangeCanvasSizeUndoable = useCallback(
    (next: CanvasSize) => {
      pushUndo();
      setCanvasSize(next);
    },
    [pushUndo],
  );

  const onChangeBackgroundUndoable = useCallback(
    (next: BackgroundColor) => {
      pushUndo();
      setBackground(next);
    },
    [pushUndo],
  );

  const onChangeBackgroundFitUndoable = useCallback(
    (next: BackgroundFit) => {
      pushUndo();
      setBackgroundFit(next);
    },
    [pushUndo],
  );

  const onChangeBackgroundOpacityUndoable = useCallback(
    (next: number) => {
      pushUndo();
      setBackgroundOpacity(next);
    },
    [pushUndo],
  );

  /* ---------- Camera sphere custom waypoint setters (also undoable) ---------- */

  const setCustomWaypointsUndoable = useCallback(
    (waypoints: SphereWaypoint[]) => {
      pushUndo();
      camera.setCustomWaypoints(waypoints);
    },
    [camera, pushUndo],
  );

  const setCustomCloseLoopUndoable = useCallback(
    (closed: boolean) => {
      pushUndo();
      camera.setCustomCloseLoop(closed);
    },
    [camera, pushUndo],
  );

  // DUAL-TRACK: Sphere Custom + Walk Path can run simultaneously now, so
  // "has trajectory" means "has waypoints on either track".
  const hasSphere = camera.state.customWaypoints.length > 0;
  const hasWalk = camera.state.walkWaypoints.length > 0;
  const sphereRunning = hasSphere && camera.state.spherePlaying;
  const walkRunning = hasWalk && camera.state.walkPlaying;
  const handheldActive = camera.state.handheldEnabled;
  const handheldRunning = handheldActive && camera.state.handheldPlaying;
  const animatedCount = useMemo(() => {
    let c = layers.filter((l) => l.animation !== 'none').length;
    if (hasSphere) c += 1;
    if (hasWalk) c += 1;
    if (handheldActive) c += 1; // Handheld Shake counts as its own motion layer
    return c;
  }, [layers, hasSphere, hasWalk, handheldActive]);

  /**
   * Orbit anchor for camera motion. No matter where the headline text lives on
   * the canvas, the custom sphere camera trajectory (and every other preset
   * trajectory that uses the same rig fields) revolves around its center point
   * instead of always the dead center of the canvas. Headline is identified
   * by the first layer whose name contains "Headline"; if the user renames or
   * deletes it we gracefully fall back to the first layer and finally canvas
   * center.
   */
  const orbitCenterPx = useMemo(() => {
    const cx = canvasSize.width / 2;
    const cy = canvasSize.height / 2;
    const headline =
      layers.find((l) => /headline/i.test(l.name)) ?? layers[0] ?? null;
    if (!headline) return { x: cx, y: cy, label: 'Canvas center', found: false };
    // PreviewCanvas positions text layers using:
    //   left = 50% + horizontalOffset (plus align-based translate compensation
    //          for the *text block*, not the anchor — the anchor remains at 50%
    //          horizontally anyway because the wrapper is 100% wide with
    //          justifyContent matching align — but the wrapper itself also
    //          carries a horizontalOffset translate on top of the align base
    //          translation — so the layer's vertical/horizontalOffset move the
    //          *entire* layer around). However the VISUAL rotation anchor for
    //          the text block is exactly:
    //            x = canvas.width/2 + horizontalOffset  (regardless of align,
    //                because align translates the text block inside, not the
    //                wrapper center)
    //            y = canvas.height/2 + verticalOffset + marginTop offset used
    //                in PreviewCanvas (= verticalOffset, since marginTop:
    //                topPx = height/2 + verticalOffset positions the text
    //                block vertically starting around there; we want the
    //                *rotational center* of the multi-line block, which is
    //                approximated well by that topPx plus half a single line
    //                height guess; however users reported they only care
    //                "headline wherever headline is" so the simple offsetX/Y
    //                mapping is plenty accurate enough for the 3D pivot feel
    //                and matches PreviewCanvas semantics where the wrapper
    //                gets rotated around its inner stage transform-origin.
    return {
      x: cx + headline.horizontalOffset,
      y: cy + headline.verticalOffset,
      label: `${headline.name} · hOff ${headline.horizontalOffset} · vOff ${headline.verticalOffset}`,
      found: true,
    };
  }, [canvasSize, layers]);

  // Normalized offset used inside the sphere SVG disc to mark the orbit
  // anchor *relative* to the canvas center. Range maps so a horizontal
  // movement of +-half the canvas width +- moves the crosshair from the
  // disc edge to edge — it's a visual aid, not geometry.
  const orbitCenterUi = useMemo(() => {
    const cx = canvasSize.width / 2;
    const cy = canvasSize.height / 2;
    const nx = cx === 0 ? 0 : Math.max(-1, Math.min(1, (orbitCenterPx.x - cx) / cx));
    const ny = cy === 0 ? 0 : Math.max(-1, Math.min(1, (orbitCenterPx.y - cy) / cy));
    return { nx, ny, label: orbitCenterPx.label, found: orbitCenterPx.found };
  }, [canvasSize, orbitCenterPx]);
  const runningCount = useMemo(() => {
    const layerRunning = layers.filter(
      (l) => l.animation !== 'none' && !pausedLayerIds.has(l.id),
    ).length;
    // Both tracks count independently when running.
    const trackRunning = (sphereRunning ? 1 : 0) + (walkRunning ? 1 : 0);
    return layerRunning + trackRunning + (handheldRunning ? 1 : 0);
  }, [layers, pausedLayerIds, sphereRunning, walkRunning, handheldRunning]);
  const pausedCount = useMemo(() => {
    const layerPaused = layers.filter(
      (l) => l.animation !== 'none' && pausedLayerIds.has(l.id),
    ).length;
    // Per-track paused = has waypoints but NOT playing for that track.
    const camPaused =
      (hasSphere && !sphereRunning ? 1 : 0) +
      (hasWalk && !walkRunning ? 1 : 0);
    const hhPaused = handheldActive && !handheldRunning ? 1 : 0;
    return layerPaused + camPaused + hhPaused;
  }, [layers, pausedLayerIds, hasSphere, hasWalk, sphereRunning, walkRunning, handheldActive, handheldRunning]);
  const layerPausedCount = useMemo(
    () =>
      layers.filter((l) => l.animation !== 'none' && pausedLayerIds.has(l.id))
        .length,
    [layers, pausedLayerIds],
  );
  const layerRunningCount = useMemo(
    () =>
      layers.filter(
        (l) => l.animation !== 'none' && !pausedLayerIds.has(l.id),
      ).length,
    [layers, pausedLayerIds],
  );

  /* ---------- Export PNG ---------- */

  /**
   * Replace url(blob:http...) backgrounds with url(data:...) inline so that
   * html-to-image can actually decode them. Returns a restore function.
   */
  const injectDataUrlBackgrounds = async (root: HTMLElement): Promise<() => void> => {
    const candidates: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>('[aria-hidden], [style*="background"]'))];
    const restored: Array<{ el: HTMLElement; originalBgImg: string; originalSrc?: string }> = [];

    const processStyle = (el: HTMLElement) => {
      const bi = el.style.backgroundImage || '';
      const match = bi.match(/url\(["']?(.+?)["']?\)/i);
      if (match) {
        restored.push({ el, originalBgImg: bi });
      }
    };
    candidates.forEach(processStyle);
    // Also check <img> elements
    const imgs = root.querySelectorAll('img');
    imgs.forEach((img) => {
      if (img.src) {
        restored.push({
          el: img as unknown as HTMLElement,
          originalBgImg: '',
          originalSrc: img.src,
        });
      }
    });

    for (const entry of restored) {
      if (entry.originalSrc) {
        try {
          const data = await backgroundImageToDataUrl(entry.originalSrc);
          (entry.el as unknown as HTMLImageElement).src = data;
        } catch { /* noop */ }
      } else if (entry.originalBgImg) {
        const match = entry.originalBgImg.match(/url\(["']?(.+?)["']?\)/i);
        if (!match) continue;
        try {
          const data = await backgroundImageToDataUrl(match[1]);
          entry.el.style.backgroundImage = `url("${data}")`;
        } catch { /* noop */ }
      }
    }

    return () => {
      for (const entry of restored) {
        if (entry.originalSrc) {
          (entry.el as unknown as HTMLImageElement).src = entry.originalSrc;
        } else if (entry.originalBgImg) {
          entry.el.style.backgroundImage = entry.originalBgImg;
        }
      }
    };
  };

  const downloadPNG = useCallback(async () => {
    const node = canvasRef.current;
    if (!node) return;
    try {
      setExporting(true);

      // ---- Freeze at current playback frame ----
      // 1. Pause camera (don't stop/reset — keep current rig)
      const wasSphere = camera.state.spherePlaying;
      const wasWalk = camera.state.walkPlaying;
      const wasHH = camera.state.handheldPlaying;
      try { camera.softPause(); } catch { /* noop */ }
      try { camera.pauseHandheld(); } catch { /* noop */ }

      // 2. Freeze CSS animations: read computed transform/opacity, remove
      //    animation class, apply values as inline styles so the browser
      //    stops animating and the frozen visual state persists.
      const animatedEls = node.querySelectorAll('[class*="anim-"]');
      const frozen: Array<{ el: Element; cls: string }> = [];
      animatedEls.forEach((el) => {
        const computed = window.getComputedStyle(el);
        const he = el as HTMLElement;
        frozen.push({ el, cls: el.className });
        el.className = el.className.replace(/\b(?:anim-\w+)\b/g, '').trim();
        he.style.transform = computed.transform;
        he.style.opacity = computed.opacity;
      });

      await new Promise((r) => setTimeout(r, 80));

      const restoreBg = await injectDataUrlBackgrounds(node);

      const w = canvasSize.width;
      const h = canvasSize.height;
      const bg = BACKGROUND_COLORS[background];
      const dataUrl = await toPng(node, {
        width: w,
        height: h,
        style: {
          transform: 'none',
          width: `${w}px`,
          height: `${h}px`,
          transformOrigin: 'top left',
        },
        cacheBust: true,
        pixelRatio: 1,
        backgroundColor: bg,
      });

      restoreBg();

      // ---- Restore animations ----
      frozen.forEach(({ el, cls }) => {
        el.className = cls;
        (el as HTMLElement).style.transform = '';
        (el as HTMLElement).style.opacity = '';
      });

      // ---- Resume camera ----
      try {
        if (wasHH) camera.resumeHandheld();
        if (wasSphere || wasWalk) camera.softResume();
      } catch { /* noop */ }

      const a = document.createElement('a');
      const ts = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const name = `poster-${canvasSize.id}-${ts.getFullYear()}${pad(
        ts.getMonth() + 1,
      )}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(
        ts.getSeconds(),
      )}.png`;
      a.href = dataUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error('PNG export failed', e);
      alert('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }, [camera, canvasSize, layers, background]);

  /* ---------- Export SVG (true vector) ---------- */
  const [svgExporting, setSvgExporting] = useState(false);
  const downloadSVG = useCallback(async () => {
    setSvgExporting(true);
    try {
      // ---- Freeze at current playback frame ----
      // Pause camera to freeze rig at current position
      const wasSphere = camera.state.spherePlaying;
      const wasWalk = camera.state.walkPlaying;
      const wasHH = camera.state.handheldPlaying;
      // Capture the rig BEFORE pausing (state is async, this is the
      // last-known-good value from the most recent animation tick)
      const frozenRig = { ...camera.state.rig };

      try { camera.softPause(); } catch { /* noop */ }
      try { camera.pauseHandheld(); } catch { /* noop */ }

      // Wait one frame for DOM to settle
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => setTimeout(r, 50));

      // Read current animation state from DOM (computed transform + opacity)
      const node = canvasRef.current;
      const frozenAnims: Record<number, { transform: string; opacity: string }> = {};
      if (node) {
        const stageWrapper = node.querySelector('[data-stage-wrapper]');
        if (stageWrapper) {
          const layerEls = stageWrapper.children;
          layers.forEach((layer, i) => {
            if (layer.animation === 'none') return;
            const layerEl = layerEls[i];
            if (!layerEl) return;
            const animEl = layerEl.querySelector('[class*="anim-"]');
            if (!animEl) return;
            const computed = window.getComputedStyle(animEl);
            frozenAnims[i] = {
              transform: computed.transform,
              opacity: computed.opacity,
            };
          });
        }
      }

      const orbitCenterPx = { x: canvasSize.width / 2, y: canvasSize.height / 2 };
      const svg = await generateSvg({
        layers,
        canvasSize,
        background,
        cameraRig: frozenRig,
        orbitCenterPx,
        customFonts,
        frozenAnimations: frozenAnims,
      });

      // ---- Resume camera ----
      try {
        if (wasHH) camera.resumeHandheld();
        if (wasSphere || wasWalk) camera.softResume();
      } catch { /* noop */ }

      const ts = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const filename =
        `poster-${canvasSize.id}-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
        `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.svg`;
      downloadSvg(svg, filename);
    } catch (err) {
      console.error('SVG export failed:', err);
    } finally {
      setSvgExporting(false);
    }
  }, [camera, canvasSize, layers, background, customFonts]);

  /* ---------- Auto-compute video loop duration ---------- */
  const autoLoopDuration = useMemo(() => {
    const durations: number[] = [];

    // Layer text animations
    for (const layer of layers) {
      if (layer.animation === 'none') continue;
      if (pausedLayerIds.has(layer.id)) continue;
      const dur = ANIM_DURATIONS[layer.animation];
      if (dur) durations.push(dur);
    }

    // Camera tracks — independent. When both run we take the LONGEST so both
    // tracks can be shown in a single exported loop.
    if (sphereRunning) {
      const n = camera.state.customWaypoints.length;
      durations.push(n <= 1 ? 1000 : Math.max(3000, n * 1600));
    }
    if (walkRunning) {
      const n = camera.state.walkWaypoints.length;
      durations.push(n <= 1 ? 1000 : Math.max(3000, n * 1800));
    }

    // Handheld is continuous noise — no fixed loop, but if it's the only
    // active motion, give it a reasonable duration
    const handheldActive = camera.state.handheldEnabled && camera.state.handheldPlaying;

    if (durations.length === 0) {
      return handheldActive ? 5000 : 3000;
    }

    // LCM of all active durations = perfect loop
    let result = durations[0];
    for (let i = 1; i < durations.length; i++) {
      result = lcm(result, durations[i]);
    }

    // Cap at 15s — if LCM too large, fall back to the longest individual duration
    if (result > 15000) {
      result = Math.max(...durations);
    }

    return Math.max(3000, result);
  }, [layers, pausedLayerIds, camera.state]);

  /* ---------- Download MP4 — High-FPS screen capture + fallback ---------- */
  const downloadMP4 = useCallback(async () => {
    const rootNode = canvasRef.current;
    if (!rootNode) return;

    const CW = canvasSize.width;
    const CH = canvasSize.height;
    const BG_COLOR = BACKGROUND_COLORS[background] ?? '#000000';
    const durationMs = Math.max(500, Math.round(autoLoopDuration));

    // Helper: choose best supported codec.
    // Prefer MP4/H.264 — hardware-accelerated, smoother high-FPS encoding,
    // and matches the user's request for MP4 output. Fall back to WebM only
    // if MP4 is unsupported (older browsers).
    const pickCodec = (): string => {
      for (const c of [
        'video/mp4;codecs=h264',
        'video/mp4;codecs=avc1',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ]) {
        try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* noop */ }
      }
      return '';
    };

    // Helper: download blob as file
    const downloadBlob = (blob: Blob, mime: string) => {
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      a.href = url;
      a.download =
        `poster-${canvasSize.id}-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
        `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { document.body.removeChild(a); } catch { /* noop */ }
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
      }, 4000);
    };

    // Helper: preload bg image as HTMLImageElement
    const preloadBg = async (): Promise<HTMLImageElement | null> => {
      try {
        if (!backgroundImage?.url) return null;
        const dataUrl = await backgroundImageToDataUrl(backgroundImage.url);
        if (!dataUrl) return null;
        return await new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = dataUrl;
          setTimeout(() => resolve(img.complete && img.naturalWidth > 0 ? img : null), 8000);
        });
      } catch { return null; }
    };

    // Helper: compute drawImage rect for bg image fit
    const computeFitRect = (iw: number, ih: number) => {
      const ir = iw / ih;
      const cr = CW / CH;
      let dw = CW, dh = CH;
      if (backgroundFit === 'Cover') {
        if (ir > cr) { dh = CH; dw = CH * ir; } else { dw = CW; dh = CW / ir; }
      } else if (backgroundFit === 'Contain') {
        if (ir > cr) { dw = CW; dh = CW / ir; } else { dh = CH; dw = CH * ir; }
      }
      return { dx: (CW - dw) / 2, dy: (CH - dh) / 2, dw, dh };
    };

    // When WebCodecs is available, we ALWAYS use offline rendering (Path 2
    // with WebCodecs encoding) for the smoothest result — no real-time
    // capture dependency, precise 30fps timestamps, H.264 hardware encoding.
    // getDisplayMedia (real-time screen capture) is only used as a fallback
    // for browsers without WebCodecs.
    const useWebCodecs = typeof VideoEncoder !== 'undefined';

    // ==================================================================
    // PATH 1: High-FPS screen capture via getDisplayMedia (60fps native)
    // (skipped when WebCodecs available — offline rendering is smoother)
    // =================================================================
    if (!useWebCodecs) {
    let displayStream: MediaStream | null = null;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        // Request 60fps + browser tab surface for the highest-fidelity capture.
        video: {
          displaySurface: 'browser',
          frameRate: { ideal: 60, max: 60 },
        } as MediaTrackConstraints,
        audio: false,
        // @ts-expect-error preferCurrentTab is Chrome 104+ only
        preferCurrentTab: true,
      });
    } catch { /* user denied or unsupported — fall through to html-to-image */ }

    if (displayStream) {
      try {
        setVideoExporting(true);
        setVideoProgress(0);

        // Create video element to read display stream
        const video = document.createElement('video');
        video.srcObject = displayStream;
        video.muted = true;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Display stream timeout')), 10000);
          video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
          video.onerror = () => { clearTimeout(timer); reject(new Error('Video error')); };
        });
        await video.play();

        // Scroll canvas into view to ensure it's visible
        rootNode.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        await new Promise<void>(r => setTimeout(r, 300));

        // Get canvas position in viewport (for cropping from display stream)
        const rect = rootNode.getBoundingClientRect();
        const scaleX = video.videoWidth / window.innerWidth;
        const scaleY = video.videoHeight / window.innerHeight;
        const srcX = Math.max(0, rect.left * scaleX);
        const srcY = Math.max(0, rect.top * scaleY);
        const srcW = Math.min(video.videoWidth - srcX, rect.width * scaleX);
        const srcH = Math.min(video.videoHeight - srcY, rect.height * scaleY);

        // Recording canvas
        const recCanvas = document.createElement('canvas');
        recCanvas.width = CW;
        recCanvas.height = CH;
        const rctx = recCanvas.getContext('2d');
        if (!rctx) throw new Error('Cannot create 2D context');

        // Preload bg image
        const bgImg = await preloadBg();

        // Paint background layer (color + image) — drawn under the captured content
        const paintBg = () => {
          rctx!.fillStyle = BG_COLOR;
          rctx!.fillRect(0, 0, CW, CH);
          if (bgImg && bgImg.naturalWidth > 0) {
            const { dx, dy, dw, dh } = computeFitRect(bgImg.naturalWidth, bgImg.naturalHeight);
            rctx!.save();
            rctx!.globalAlpha = Math.max(0, Math.min(1, backgroundOpacity));
            rctx!.drawImage(bgImg, dx, dy, dw, dh);
            rctx!.restore();
          }
        };

        // MediaRecorder
        const mimeType = pickCodec();
        if (!mimeType) throw new Error('MediaRecorder not supported');
        // 60fps capture for smooth motion; H.264 hardware encoding keeps up.
        const recStream = recCanvas.captureStream(60);
        const recorder = new MediaRecorder(recStream, {
          mimeType,
          videoBitsPerSecond: 24_000_000,
        });
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => { try { if (e.data?.size > 0) chunks.push(e.data); } catch { /* noop */ } };
        const recorderDone = new Promise<Blob | null>((resolve) => {
          recorder.onstop = () => { try { resolve(new Blob(chunks, { type: mimeType })); } catch { resolve(null); } }
        });

        // Start recording — animation runs in real-time, we just capture it
        recorder.start(100);
        const startTime = performance.now();

        // Frame-accurate draw loop.
        //
        // requestVideoFrameCallback fires EXACTLY once per unique delivered
        // frame from the display stream — not on every display refresh like
        // rAF. This eliminates duplicate frames: if the source delivers 60
        // unique fps, we paint 60 unique frames; if it delivers 30, we paint
        // 30 (no padding with duplicates). Combined with captureStream(60),
        // the output matches the live preview 1:1.
        const hasRVFC = typeof (video as any).requestVideoFrameCallback === 'function';
        let lastProgressBucket = -1;

        await new Promise<void>((resolve) => {
          const drawFrame = () => {
            const elapsed = performance.now() - startTime;
            if (elapsed >= durationMs) { resolve(); return; }

            // Paint bg first, then draw the unique captured frame on top
            paintBg();
            try { rctx!.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, CW, CH); } catch { /* noop */ }

            // Throttle progress updates to ~10Hz
            const pct = Math.min(100, (elapsed / durationMs) * 100);
            const bucket = Math.floor(pct / 5);
            if (bucket !== lastProgressBucket) {
              lastProgressBucket = bucket;
              setVideoProgress(pct);
            }

            // Schedule next paint: prefer requestVideoFrameCallback (1 paint
            // per unique source frame), fall back to rAF if unsupported.
            if (hasRVFC) {
              (video as any).requestVideoFrameCallback(drawFrame);
            } else {
              requestAnimationFrame(drawFrame);
            }
          };
          if (hasRVFC) {
            (video as any).requestVideoFrameCallback(drawFrame);
          } else {
            requestAnimationFrame(drawFrame);
          }
        });

        // Give last frame time to encode
        await new Promise<void>(r => setTimeout(r, 300));
        try { recorder.stop(); } catch { /* noop */ }

        // Stop display stream
        displayStream.getTracks().forEach(t => { try { t.stop(); } catch { /* noop */ } });

        const blob = await recorderDone;
        if (!blob || blob.size === 0) throw new Error('No video data recorded');

        downloadBlob(blob, mimeType);
        setVideoExporting(false);
        setVideoProgress(0);
        return; // ✅ Success — don't fall through to html-to-image
      } catch (e) {
        console.error('[mp4] screen capture failed:', e);
        try { displayStream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
        setVideoExporting(false);
        setVideoProgress(0);
        // Fall through to html-to-image fallback
      }
    }
    } // end if (!useWebCodecs) — getDisplayMedia skipped when WebCodecs available

    // ==================================================================
    // PATH 2: Offline rendering — WebCodecs (primary) or MediaRecorder
    // ==================================================================
    const FPS = 30;                      // target frame rate for offline render
    const FRAME_MS = 1000 / FPS;
    const BITRATE = 16_000_000;           // 16 Mbps — higher for 30fps
    const KEY_FRAMES_EVERY = FPS * 2;     // keyframe every 2 seconds (Chrome-only)
    const PREFERRED_CODECS = [
      'video/mp4;codecs=h264',            // prefer MP4/H.264 (hw-accelerated)
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];

    type RestoreEntry = { el: HTMLElement; prop: string; value: string };
    const restores: RestoreEntry[] = [];
    const restore = () => {
      for (let i = restores.length - 1; i >= 0; i--) {
        const { el, prop, value } = restores[i];
        try {
          if (value === '') el.style.removeProperty(prop);
          else el.style.setProperty(prop, value);
        } catch { /* noop */ }
      }
      restores.length = 0;
    };
    const saveStyle = (el: HTMLElement, cssProp: string) => {
      restores.push({ el, prop: cssProp, value: el.style.getPropertyValue(cssProp) });
    };

    let restoreBgUrls: null | (() => void) = null;
    let camRestart: null | { sphere: boolean; walk: boolean; handheld: boolean } = null;

    // Fully-isolated per-frame rasterizer. NEVER throws — returns null on fail.
    //
    // CRITICAL RULE: we never override `transform` on the target element.
    // Camera rigs (orbitX/Y/Z, panX/Y, dolly, z) are written into
    // perspectiveDiv/stageDiv inline styles by applyRigToDom(). html-to-image
    // serializes the current DOM state as-is, which preserves:
    //   (a) parent perspective property
    //   (b) child stage CSS 3D transforms (including handheld + sphere/walk)
    //   (c) all layer text / colors / CSS animation phase
    // → This is what produces WYSIWYG frames that match the live preview.
    const rasterizeRoot = (targetEl: HTMLElement, cw: number, ch: number): Promise<HTMLCanvasElement | null> =>
      new Promise((resolve) => {
        const opts: any = {
          width: cw,
          height: ch,
          cacheBust: true,
          pixelRatio: 1,
          skipFonts: true,       // skip cross-origin CSS rules (Google Fonts) → no SecurityError
          includeQueryParams: true,
          // backgroundColor intentionally NOT passed here — we want the
          // canvas-root node's own inline `background: bgColor` to shine
          // through for the color part, while we handle the bg-image via
          // preloaded HTMLImageElement (faster than re-serializing per frame).
        };
        toCanvas(targetEl, opts)
          .then((c) => resolve(c))
          .catch((e) => {
            try { console.warn('[mp4] frame raster skipped:', e?.message || e); } catch { /* noop */ }
            resolve(null);
          });
      });

    // Preloads a data URL image into HTMLImageElement (drawImage-able in 2D ctx).
    const preloadImage = (dataUrl: string): Promise<HTMLImageElement | null> =>
      new Promise((resolve) => {
        try {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.onabort = () => resolve(null);
          img.src = dataUrl;
          setTimeout(() => resolve(img.complete && img.naturalWidth > 0 ? img : null), 8000);
        } catch { resolve(null); }
      });

    // Compute drawImage rectangle for bg image given the fit mode.
    const computeImageRect = (iw: number, ih: number) => {
      const ir = iw / ih;
      const cr = CW / CH;
      let dw = CW, dh = CH;
      if (backgroundFit === 'Cover') {
        if (ir > cr) { dh = CH; dw = CH * ir; } else { dw = CW; dh = CW / ir; }
      } else if (backgroundFit === 'Contain') {
        if (ir > cr) { dw = CW; dh = CW / ir; } else { dh = CH; dw = CH * ir; }
      }
      return { dx: (CW - dw) / 2, dy: (CH - dh) / 2, dw, dh };
    };

    try {
      setVideoExporting(true);
      setVideoProgress(0);

      // ==== Recording canvas (always painted directly, never via html-to-image) ====
      const recCanvas = document.createElement('canvas');
      recCanvas.width = CW;
      recCanvas.height = CH;
      const rctx = recCanvas.getContext('2d');
      if (!rctx) throw new Error('Cannot create 2D context for recording canvas.');

      // ==== Stage element (3D text) — rasterize only this, not the whole poster ====
      let perspectiveDiv = rootNode.querySelector<HTMLElement>('[data-perspective-wrapper]');
      let stageDiv = rootNode.querySelector<HTMLElement>('[data-stage-wrapper]');
      if (!perspectiveDiv || !stageDiv) {
        // Structural fallback: last child with grandchildren = perspective wrapper
        const kids = Array.from(rootNode.children);
        for (let i = kids.length - 1; i >= 0 && !perspectiveDiv; i--) {
          const k = kids[i] as HTMLElement;
          if (k?.tagName === 'DIV' && k.children && k.children.length > 0) perspectiveDiv = k;
        }
        if (perspectiveDiv && perspectiveDiv.children.length > 0) {
          stageDiv = perspectiveDiv.children[0] as HTMLElement;
        }
      }
      if (!perspectiveDiv || !stageDiv) throw new Error('Cannot locate 3D stage element.');

      // ------------------------------------------------------------------
      // BACKGROUND-SKIP PREPARATION (html-to-image speed + layered compose)
      //
      // We want html-to-image to only serialize the 3D content (perspective
      // + stage + text) and NOT waste time on the user's background image
      // layer. We also don't want the canvas-root's inline background color
      // in the raster — we'll paint bg (color + user image) ourselves on
      // the recorder canvas with fast 2D fillRect/drawImage.
      // ------------------------------------------------------------------
      // 1) Hide bg image layer: find the aria-hidden absolute bg div
      const bgImageLayerEl = rootNode.querySelector<HTMLElement>('[aria-hidden][style*="backgroundImage"], [aria-hidden][style*="background-image"]')
        ?? rootNode.querySelector<HTMLElement>('[aria-hidden]');
      if (bgImageLayerEl) saveStyle(bgImageLayerEl, 'visibility');
      try { if (bgImageLayerEl) bgImageLayerEl.style.visibility = 'hidden'; } catch { /* noop */ }
      // 2) Make rootNode's background transparent (so raster output has alpha)
      saveStyle(rootNode, 'background');
      try { rootNode.style.background = 'transparent'; } catch { /* noop */ }

      // Save then lock perspective/stage styles
      saveStyle(perspectiveDiv, 'perspective');
      saveStyle(perspectiveDiv, 'perspective-origin');
      saveStyle(stageDiv, 'transform-origin');
      saveStyle(stageDiv, 'transform');
      try {
        const cp = window.getComputedStyle(perspectiveDiv);
        const cs = window.getComputedStyle(stageDiv);
        const cv = cp.perspective;
        if (cv && cv !== '0px' && cv !== 'none') perspectiveDiv.style.perspective = cv;
        const cpo = cp.perspectiveOrigin;
        if (cpo) perspectiveDiv.style.perspectiveOrigin = cpo;
        const cso = cs.transformOrigin;
        if (cso) stageDiv.style.transformOrigin = cso;
      } catch { /* noop */ }

      // ==== Pause & remember live motion state ====
      // DUAL-TRACK: remember each track independently so we can restart the
      // correct ones after export.
      const wasSpherePlaying = !!camera.state.spherePlaying;
      const wasWalkPlaying = !!camera.state.walkPlaying;
      const wasHandheldPlaying = !!camera.state.handheldPlaying;
      try { if (wasSpherePlaying) camera.pause(CUSTOM_TRAJECTORY_ID); } catch { /* noop */ }
      try { if (wasWalkPlaying) camera.pause(WALK_TRAJECTORY_ID); } catch { /* noop */ }
      try { camera.pauseHandheld(); } catch { /* noop */ }
      camRestart = { sphere: wasSpherePlaying, walk: wasWalkPlaying, handheld: wasHandheldPlaying };

      // ==== Freeze layer CSS animations (drive per-frame via -delay) ====
      const ANIM_DURATIONS_MAP: Record<string, number> = {
        'anim-expand': 1600,
        'anim-contract': 1600,
        'anim-pulse': 2200,
        'anim-sway': 3000,
        'anim-float': 3200,
        'anim-shake': 700,
      };
      const animNodes: Array<{ el: HTMLElement; durationMs: number }> = [];
      rootNode.querySelectorAll<HTMLElement>('[class*="anim-"]').forEach((el) => {
        const classes = Array.from(el.classList);
        for (const cls of classes) {
          const dur = ANIM_DURATIONS_MAP[cls];
          if (dur) {
            saveStyle(el, 'animation-play-state');
            saveStyle(el, 'animation-delay');
            try { el.style.animationPlayState = 'paused'; } catch { /* noop */ }
            animNodes.push({ el, durationMs: dur });
            break;
          }
        }
      });

      // ==== Convert + preload background image as HTMLImageElement (skips html-to-image per-frame bg) ====
      let bgImg: HTMLImageElement | null = null;
      try {
        if (backgroundImage && backgroundImage.url) {
          const dataUrl = await backgroundImageToDataUrl(backgroundImage.url);
          if (dataUrl) bgImg = await preloadImage(dataUrl);
        }
      } catch { bgImg = null; }

      // ==== Collect trajectory info ====
      const trajId = camera.state.trajectoryId;
      const sphereWps = (camera.state.customWaypoints || []).slice();
      const sphereLoop = !!camera.state.customCloseLoop;
      const walkWps = (camera.state.walkWaypoints || []).slice();
      const walkLoop = !!camera.state.walkCloseLoop;
      const handheldOn = !!camera.state.handheldEnabled;
      const handheldSettings = {
        strength: Number(camera.state.handheldSettings?.strength ?? 0),
        frequency: Number(camera.state.handheldSettings?.frequency ?? 50),
      };
      const freqMult = handheldSettings.frequency / 50;

      let trajDurationMs = 0;
      if (trajId === CUSTOM_TRAJECTORY_ID && sphereWps.length > 1) {
        trajDurationMs = Math.max(3000, sphereWps.length * 1600);
      } else if (trajId === WALK_TRAJECTORY_ID && walkWps.length > 1) {
        trajDurationMs = Math.max(3000, walkWps.length * 1800);
      }
      const durationMs = Math.max(500, Math.round(autoLoopDuration));
      const totalFrames = Math.max(1, Math.round(durationMs / FRAME_MS));

      // ==== Frame builders (camera + anim phase) ====
      const buildFrameRig = (tMs: number): CameraRig => {
        let base = DEFAULT_CAMERA;
        try {
          if (trajId === CUSTOM_TRAJECTORY_ID && sphereWps.length >= 1) {
            const u = sphereWps.length === 1 ? 0 : (trajDurationMs > 0
              ? (((tMs % trajDurationMs) + trajDurationMs) % trajDurationMs) / trajDurationMs
              : 0);
            base = evaluateCustomTrajectory(sphereWps, u, sphereLoop);
          } else if (trajId === WALK_TRAJECTORY_ID && walkWps.length >= 1) {
            const u = walkWps.length === 1 ? 0 : (trajDurationMs > 0
              ? (((tMs % trajDurationMs) + trajDurationMs) % trajDurationMs) / trajDurationMs
              : 0);
            base = evaluateWalkTrajectory(walkWps, u, walkLoop);
          }
        } catch { base = DEFAULT_CAMERA; }

        let hhRig: CameraRig;
        if (handheldOn) {
          try { hhRig = evaluateHandheld(tMs * freqMult, handheldSettings); }
          catch { hhRig = { ...DEFAULT_CAMERA }; }
        } else {
          hhRig = { ...DEFAULT_CAMERA };
        }

        try { return composeRigs(base, hhRig); }
        catch { return base; }
      };

      const applyRigToDom = (rig: CameraRig) => {
        try {
          stageDiv!.style.transform =
            `translate3d(${rig.panX}px, ${rig.panY}px, ${rig.z}px)` +
            ` rotateX(${rig.orbitX}deg) rotateY(${rig.orbitY}deg) rotateZ(${rig.orbitZ}deg)` +
            ` scale(${rig.dolly})`;
          perspectiveDiv!.style.perspective = `${rig.perspective}px`;
        } catch { /* noop */ }
      };

      const applyAnimPhase = (tMs: number) => {
        for (let i = 0; i < animNodes.length; i++) {
          const n = animNodes[i];
          try {
            const phase = (((tMs % n.durationMs) + n.durationMs) % n.durationMs);
            n.el.style.animationDelay = `-${(phase / 1000).toFixed(5)}s`;
          } catch { /* noop */ }
        }
      };

      // ==== Background layer painter (no html-to-image, pure drawImage/fillRect) ====
      const paintBackground = () => {
        // 1) Solid bg color first
        rctx!.fillStyle = BG_COLOR;
        rctx!.fillRect(0, 0, CW, CH);
        // 2) User uploaded background image
        if (bgImg && bgImg.naturalWidth > 0) {
          const { dx, dy, dw, dh } = computeImageRect(
            bgImg.naturalWidth, bgImg.naturalHeight,
          );
          rctx!.save();
          rctx!.globalAlpha = Math.max(0, Math.min(1, backgroundOpacity));
          try { rctx!.drawImage(bgImg, dx, dy, dw, dh); } catch { /* noop */ }
          rctx!.restore();
        }
      };

      // ==== Encoding setup ====
      // WebCodecs: H.264 hardware encoding with precise per-frame timestamps.
      //   Each frame is rendered offline (as fast as html-to-image allows),
      //   then encoded with an exact 1/30s timestamp. The output plays at
      //   exactly 30fps regardless of render speed — no dropped frames,
      //   no duplicates, matches the live preview.
      // MediaRecorder: real-time stream capture (fallback, no WebCodecs).
      let encoder: VideoEncoder | null = null;
      let muxer: Muxer<ArrayBufferTarget> | null = null;
      let muxerTarget: ArrayBufferTarget | null = null;
      let recorder: MediaRecorder | null = null;
      let recorderDone: Promise<Blob | null> | null = null;
      let chosenMime = '';

      if (useWebCodecs) {
        // ---- WebCodecs: pick best supported H.264 codec ----
        const wcCodecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'vp09.00.10.08'];
        let chosenWcCodec = '';
        for (const c of wcCodecs) {
          try {
            const s = await VideoEncoder.isConfigSupported({
              codec: c, width: CW, height: CH, bitrate: BITRATE, framerate: FPS,
            } as any);
            if (s?.supported) { chosenWcCodec = c; break; }
          } catch { /* noop */ }
        }
        if (!chosenWcCodec) throw new Error('No supported WebCodecs codec.');

        muxerTarget = new ArrayBufferTarget();
        muxer = new Muxer({
          target: muxerTarget,
          fastStart: 'in-memory',
          video: { codec: chosenWcCodec.startsWith('avc') ? 'avc' : 'vp9', width: CW, height: CH },
        });
        encoder = new VideoEncoder({
          output: (chunk, metadata) => { try { muxer!.addVideoChunk(chunk, metadata); } catch { /* noop */ } },
          error: (e) => { try { console.error('[mp4] WebCodecs encoder error:', e); } catch { /* noop */ } },
        });
        await encoder.configure({
          codec: chosenWcCodec, width: CW, height: CH, bitrate: BITRATE, framerate: FPS,
        } as any);
      } else {
        // ---- MediaRecorder fallback ----
        for (const c of PREFERRED_CODECS) {
          try { if (MediaRecorder.isTypeSupported(c)) { chosenMime = c; break; } }
          catch { /* noop */ }
        }
        if (!chosenMime) throw new Error('MediaRecorder unsupported in this browser.');

        const supportsKeyFrameInterval = (() => {
          try {
            const t = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,keyframeInterval=36');
            return !!t;
          } catch { return false; }
        })();

        let stream: MediaStream | null = null;
        try {
          stream = recCanvas.captureStream
            ? recCanvas.captureStream(FPS)
            : ((recCanvas as any).mozCaptureStream
              ? (recCanvas as any).mozCaptureStream(FPS)
              : null);
        } catch { stream = null; }
        if (!stream) throw new Error('captureStream not supported.');

        const recorderOpts: any = { mimeType: chosenMime, videoBitsPerSecond: BITRATE };
        if (supportsKeyFrameInterval) recorderOpts.videoKeyFrameInterval = KEY_FRAMES_EVERY;
        recorder = new MediaRecorder(stream, recorderOpts);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => {
          try { if (e.data?.size > 0) chunks.push(e.data); } catch { /* noop */ }
        };
        recorderDone = new Promise<Blob | null>((resolve) => {
          recorder!.onstop = () => {
            try { resolve(new Blob(chunks, { type: chosenMime })); }
            catch { resolve(null); }
          };
        });
        try { recorder.start(120); }
        catch (e) { throw new Error('Recorder failed to start: ' + (e as Error)?.message); }
      }

      // ==== Helpers ====
      const waitMs = (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.max(1, Math.round(ms))));
      const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
      const paintStage = (stage: HTMLCanvasElement) => {
        try { rctx!.drawImage(stage, 0, 0); } catch { /* noop */ }
      };
      // Encode current recCanvas as one video frame at timestamp tMs (microseconds).
      const encodeFrame = (tMs: number, keyFrame: boolean) => {
        if (!encoder) return;
        try {
          const vf = new VideoFrame(recCanvas, {
            timestamp: Math.round(tMs * 1000),
            duration: Math.round(1_000_000 / FPS),
          });
          encoder.encode(vf, { keyFrame });
          vf.close();
        } catch { /* noop */ }
      };

      // Paint frame 0 background immediately (never a grey frame)
      paintBackground();

      // ==== Frame 0 (pre-render before loop) ====
      let lastStage: HTMLCanvasElement | null = null;
      try {
        applyRigToDom(buildFrameRig(0));
        applyAnimPhase(0);
        if (useWebCodecs) await nextFrame(); else await waitMs(10);
        const s = await rasterizeRoot(rootNode, CW, CH);
        if (s) { lastStage = s; paintStage(s); }
      } catch (e) {
        try { console.warn('[mp4] frame 0 failed:', e); } catch { /* noop */ }
      }
      encodeFrame(0, true);

      // ==== Main frame loop ====
      //
      // WebCodecs path: NO real-time pacing — render as fast as html-to-image
      //   allows. Each frame gets a precise 1/30s timestamp, so the output
      //   plays at exactly 30fps regardless of render speed. This is what
      //   makes the exported video match the live preview's smoothness.
      // MediaRecorder path: paced at FRAME_MS for real-time captureStream.
      let progressNextReport = 0;
      for (let fi = 1; fi < totalFrames; fi++) {
        if (useWebCodecs) await nextFrame(); else await waitMs(FRAME_MS);
        const tMs = fi * FRAME_MS;

        if (tMs >= progressNextReport) {
          progressNextReport = tMs + 100;
          try { setVideoProgress(Math.min(100, (tMs / durationMs) * 100)); } catch { /* noop */ }
        }

        let rendered: HTMLCanvasElement | null = null;
        try {
          applyRigToDom(buildFrameRig(tMs));
          applyAnimPhase(tMs);
          rendered = await rasterizeRoot(rootNode, CW, CH);
        } catch { /* ignore — frame loop must continue */ }

        paintBackground();
        if (rendered) { lastStage = rendered; paintStage(rendered); }
        else if (lastStage) { paintStage(lastStage); }

        encodeFrame(tMs, fi % (FPS * 2) === 0);

        // Backpressure: drain encoder queue if too deep
        if (encoder && encoder.encodeQueueSize > 10) {
          await new Promise<void>(r => {
            const check = () => encoder!.encodeQueueSize < 5 ? r() : setTimeout(check, 1);
            check();
          });
        }
      }

      // ==== Teardown + download ====
      if (encoder) {
        await encoder.flush();
        muxer!.finalize();
        const buf = muxerTarget!.buffer;
        if (!buf || buf.byteLength === 0) throw new Error('WebCodecs produced no data.');
        downloadBlob(new Blob([buf], { type: 'video/mp4' }), 'video/mp4');
      } else {
        await waitMs(FRAME_MS + 12);
        try { recorder!.stop(); } catch { /* noop */ }
        const blob = await recorderDone!;
        if (!blob || blob.size === 0) throw new Error('Recorder produced no data.');
        downloadBlob(blob, chosenMime);
      }
    } catch (e) {
      console.error('[mp4] export failed:', e);
      try { alert('Video export failed. Please refresh and try again.'); } catch { /* noop */ }
    } finally {
      // Always: progress off first so React rerenders without our inline DOM mods
      try { setVideoExporting(false); } catch { /* noop */ }
      try { setVideoProgress(0); } catch { /* noop */ }
      try { restore(); } catch { /* noop */ }
      if (restoreBgUrls) {
        try { restoreBgUrls(); } catch { /* noop */ }
        restoreBgUrls = null;
      }
      if (camRestart) {
        try {
          if (camRestart.handheld) camera.resumeHandheld();
          if (camRestart.sphere) camera.play(CUSTOM_TRAJECTORY_ID);
          if (camRestart.walk) camera.play(WALK_TRAJECTORY_ID);
        } catch { /* noop */ }
        camRestart = null;
      }
    }
  }, [canvasSize, autoLoopDuration, background, camera, backgroundImage, backgroundFit, backgroundOpacity]);

  /* ---------- Reset current 3D via preview bottom button ---------- */
  const resetSelectedTransform = useCallback(() => {
    if (selectedId) resetTransform(selectedId);
  }, [selectedId, resetTransform]);

  const canvasTransform = useMemo(() => `scale(${scale})`, [scale]);

  // Since camera motion now lives *inside* the canvas frame, the outer canvas
  // rectangle (with the poster background) never moves. We keep the stage
  // wrapper sizing static — no padding for pan/dolly — so the canvas always
  // occupies a stable area.
  const canvasOffset = useMemo(() => {
    const w = canvasSize.width * scale;
    const h = canvasSize.height * scale;
    return { width: w, height: h };
  }, [canvasSize, scale]);

  // Expose undoable wrappers for camera waypoint editors without changing the
  // player hook's own interface. The `camera` prop passed to ControlPanel is
  // a shallow shadow that replaces these two methods only.
  const cameraShadow = useMemo(() => {
    // Wrap Handheld UI entry points (toggle/intensity/frequency) with undo so
    // the user can Ctrl/⌘Z them back. Sphere Custom already had undo entries.
    const toggleHandheldUndoable = () => {
      pushUndo();
      camera.toggleHandheld();
    };
    const setHandheldIntensityUndoable = (v: number) => {
      pushUndo();
      camera.setHandheldIntensity(v);
    };
    const setHandheldFrequencyUndoable = (v: number) => {
      pushUndo();
      camera.setHandheldFrequency(v);
    };
    const setHandheldEnabledUndoable = (v: boolean) => {
      pushUndo();
      camera.setHandheldEnabled(v);
    };
    // Wrap Walk Path waypoint edits with undo.
    const setWalkWaypointsUndoable = (wps: WalkWaypoint[]) => {
      pushUndo();
      camera.setWalkWaypoints(wps);
    };
    const setWalkCloseLoopUndoable = (closed: boolean) => {
      pushUndo();
      camera.setWalkCloseLoop(closed);
    };
    return {
      ...camera,
      setCustomWaypoints: setCustomWaypointsUndoable,
      setCustomCloseLoop: setCustomCloseLoopUndoable,
      setWalkWaypoints: setWalkWaypointsUndoable,
      setWalkCloseLoop: setWalkCloseLoopUndoable,
      selectWalkWaypoint: camera.selectWalkWaypoint,
      selectSphereWaypoint: camera.selectSphereWaypoint,
      toggleHandheld: toggleHandheldUndoable,
      setHandheldEnabled: setHandheldEnabledUndoable,
      setHandheldIntensity: setHandheldIntensityUndoable,
      setHandheldFrequency: setHandheldFrequencyUndoable,
    };
  }, [
    camera,
    setCustomWaypointsUndoable,
    setCustomCloseLoopUndoable,
    pushUndo,
  ]);

  /* ---------- Ctrl/Cmd + Z shortcut ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        // Avoid fighting with browser text-field undo in inputs — let the
        // browser handle it when the active element is an editable field.
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        const editable =
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          !!((document.activeElement as HTMLElement | null)?.isContentEditable);
        if (editable) return;
        if (canUndo) {
          e.preventDefault();
          undo();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canUndo, undo]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-deep text-fg-bright">
      {/* Inject @font-face rules from uploaded fonts so html-to-image can see them */}
      <FontFaceStyle fonts={customFonts} />

      {/* Header — macOS title bar style */}
      <header className="z-20 flex h-14 shrink-0 items-center justify-between border-b border-border-soft bg-bg-panel px-6">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[13px] font-semibold tracking-wide text-fg-bright">
              Text Composition in 3D Space
            </div>
            <div className="text-[10px] tracking-wide text-fg-muted">
              PURE CSS 3D · STATIC EXPORT
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] tracking-widest text-fg-muted">
          <span className="chip">
            {canvasSize.width}×{canvasSize.height}
          </span>
          <span className="chip hidden sm:inline">
            Scale {(scale * 100).toFixed(0)}%
          </span>
          <span className="chip hidden md:inline">{layers.length} Layers</span>
          {customFonts.length > 0 && (
            <span className="chip hidden lg:inline">
              {customFonts.length} Font{customFonts.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <ControlPanel
          layers={layers}
          selectedId={selectedId}
          canvasSize={canvasSize}
          background={background}
          backgroundImage={backgroundImage}
          backgroundFit={backgroundFit}
          backgroundOpacity={backgroundOpacity}
          customFonts={customFonts}
          pausedLayerIds={pausedLayerIds}
          orbitCenterUi={orbitCenterUi}
          onSelect={setSelectedId}
          onAddLayer={addLayer}
          onImportSvgLayer={importSvgLayer}
          onDeleteLayer={deleteLayer}
          onDuplicateLayer={duplicateLayer}
          onMoveLayerUp={moveLayerUp}
          onMoveLayerDown={moveLayerDown}
          onRenameLayer={renameLayer}
          onUpdateLayer={updateLayer}
          onUpdateTransform={updateTransform}
          onSetAnimation={setLayerAnimation}
          onTogglePauseLayer={togglePauseLayer}
          onResetTransform={resetTransform}
          onChangeCanvasSize={onChangeCanvasSizeUndoable}
          onChangeBackground={onChangeBackgroundUndoable}
          onAddFont={addFont}
          onRemoveFont={removeFont}
          onUploadBackgroundImage={setBackgroundImageFromFile}
          onRemoveBackgroundImage={removeBackgroundImage}
          onChangeBackgroundFit={onChangeBackgroundFitUndoable}
          onChangeBackgroundOpacity={onChangeBackgroundOpacityUndoable}
          handheld={camera.hh}
          camera={cameraShadow}
        />

        {/* Preview stage — stays fixed while left side scrolls */}
        <main
          ref={stageRef}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-bg-card"
        >

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8">
            <div
              style={{
                width: canvasOffset.width,
                height: canvasOffset.height,
                position: 'relative',
              }}
            >
              <div style={{ transform: canvasTransform, transformOrigin: 'top left' }}>
                <PreviewCanvas
                  ref={canvasRef}
                  layers={layers}
                  canvasSize={canvasSize}
                  background={background}
                  backgroundSettings={bgSettings}
                  customFonts={customFonts}
                  pausedLayerIds={pausedLayerIds}
                  cameraRig={cameraRig}
                  orbitCenterPx={{ x: orbitCenterPx.x, y: orbitCenterPx.y }}
                />
              </div>
            </div>
          </div>

          {/* Bottom action bar — macOS toolbar style */}
          <div className="border-t border-border-soft bg-bg-panel px-6 py-4">
            <div className="mx-auto flex max-w-5xl flex-nowrap items-center justify-center gap-2 overflow-x-auto">
              <button
                type="button"
                onClick={undo}
                disabled={!canUndo}
                title={canUndo ? 'Undo last change · Ctrl/Cmd + Z' : 'No changes to undo'}
                className="btn h-10 px-4 disabled:cursor-not-allowed"
              >
                <span className="mr-1 text-base leading-none">↶</span>
                Undo
                <span className="ml-2 text-[10px] text-fg-muted">Ctrl/⌘Z</span>
              </button>
              <button
                type="button"
                onClick={downloadPNG}
                disabled={exporting || videoExporting || svgExporting}
                className="btn btn-primary h-10 px-5"
              >
                {exporting ? 'Exporting…' : 'Download PNG'}
              </button>
              <button
                type="button"
                onClick={downloadSVG}
                disabled={exporting || videoExporting || svgExporting}
                className="btn btn-primary h-10 px-5"
                title="Export true vector SVG — infinite zoom, always sharp"
              >
                {svgExporting ? 'Exporting…' : 'Download SVG'}
              </button>
              <button
                type="button"
                onClick={downloadMP4}
                disabled={exporting || videoExporting || svgExporting}
                className="btn btn-primary h-10 px-5"
                title={`Auto loop: ${(autoLoopDuration / 1000).toFixed(1)}s`}
              >
                {videoExporting
                  ? `Recording… ${videoProgress.toFixed(0)}%`
                  : `Download MP4 · ${(autoLoopDuration / 1000).toFixed(1)}s`}
              </button>
              <button type="button" onClick={addLayer} className="btn h-10">
                Add Text Layer
              </button>
              <button
                type="button"
                onClick={resetSelectedTransform}
                disabled={!selectedId}
                className="btn h-10"
              >
                Reset Current Layer 3D
              </button>
              <button
                type="button"
                onClick={
                  pausedCount > 0 ? resumeAllAnimations : pauseAllAnimations
                }
                disabled={animatedCount === 0}
                className={[
                  'btn h-10',
                  pausedCount > 0
                    ? '!border-accent-blue !bg-accent-blue/20 !text-fg-bright'
                    : runningCount > 0
                    ? '!border-border-medium !bg-bg-card-hover !text-fg-bright'
                    : '',
                ].join(' ')}
                title={
                  animatedCount === 0
                    ? '先在左侧任意层选一个 Motion，或在 Camera Motion 里启动一条轨迹（预设或 Sphere Custom 都行），这里才会变成可点'
                    : pausedCount > 0
                    ? `同时恢复文字层动效和摄像机视角运动（已暂停 ${pausedCount} 项）`
                    : `冻结所有正在跑的：文字层动效 + Camera 视角运动（共 ${animatedCount} 项），不会清除动效/轨迹，可恢复继续`
                }
              >
                <span className="mr-1 text-[12px] leading-none">
                  {pausedCount > 0 ? '▶' : '❚❚'}
                </span>
                <span className="tracking-wider">
                  {pausedCount > 0 ? 'Resume All Motion' : 'Pause All Motion'}
                </span>
                <span
                  className={[
                    'ml-2 inline-flex items-center gap-1 rounded-macos px-1.5 py-0.5 font-mono text-[10px]',
                    pausedCount > 0
                      ? 'bg-accent-blue/20 text-fg-bright'
                      : runningCount > 0
                      ? 'bg-bg-card-hover text-fg-bright'
                      : 'bg-bg-input text-fg-muted',
                  ].join(' ')}
                >
                  {layerRunningCount > 0 ? `▶ T${layerRunningCount}` : null}
                  {sphereRunning ? ` · ▶ Sphere` : null}
                  {walkRunning ? ` · ▶ Walk` : null}
                  {handheldRunning ? ` · ▶ H` : null}
                  {(layerRunningCount > 0 || sphereRunning || walkRunning || handheldRunning) &&
                  (layerPausedCount > 0 ||
                    (hasSphere && !camera.state.spherePlaying) ||
                    (hasWalk && !camera.state.walkPlaying) ||
                    (handheldActive && !camera.state.handheldPlaying))
                    ? ' · '
                    : null}
                  {layerPausedCount > 0 ? `❚❚ T${layerPausedCount}` : null}
                  {hasSphere && !camera.state.spherePlaying
                    ? layerPausedCount > 0 || (hasWalk && !camera.state.walkPlaying)
                      ? ' · ❚❚ Sphere'
                      : '❚❚ Sphere'
                    : null}
                  {hasWalk && !camera.state.walkPlaying
                    ? layerPausedCount + (hasSphere && !camera.state.spherePlaying ? 1 : 0) > 0
                      ? ' · ❚❚ Walk'
                      : '❚❚ Walk'
                    : null}
                  {handheldActive && !camera.state.handheldPlaying
                    ? layerPausedCount + (hasSphere && !camera.state.spherePlaying ? 1 : 0) + (hasWalk && !camera.state.walkPlaying ? 1 : 0) > 0
                      ? ' · ❚❚ H'
                      : '❚❚ H'
                    : null}
                  {runningCount === 0 && pausedCount === 0
                    ? animatedCount > 0
                      ? 'idle · ready'
                      : 'no motion yet'
                    : null}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
                className="btn h-10 px-4"
                title={theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
              >
                <span className="mr-1 text-[12px] leading-none">
                  {theme === 'dark' ? '☀' : '☾'}
                </span>
                {theme === 'dark' ? 'Dark' : 'Light'}
              </button>
            </div>
            <p className="mt-3 text-center text-[10px] tracking-widest text-fg-muted">
              EXPORT RENDERS THE CURRENT STATIC FRAME · TEXT, HANDHELD SHAKE, AND
              SPHERE CUSTOM ARE GLOBALLY FROZEN BY PAUSE
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
