import type {
  Align,
  AnimationType,
  BackgroundColor,
  BackgroundFit,
  BackgroundImage,
  CanvasSize,
  CustomFont,
  FontWeight,
  TextLayer,
} from '../types';
import type { CameraPlayerState, SphereWaypoint, WalkWaypoint } from '../camera';
import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import {
  ALIGN_MAP,
  BACKGROUND_COLORS,
  CANVAS_PRESETS,
  FONT_WEIGHT_MAP,
  GRAYSCALE_COLORS,
} from '../types';
import { LayerList } from './LayerList';
import { SegmentedControl } from './SegmentedControl';
import { Slider } from './Slider';
import { FontManager } from './FontManager';
import { CameraMotionPanel } from './CameraMotionPanel';

interface ControlPanelProps {
  layers: TextLayer[];
  selectedId: string | null;
  canvasSize: CanvasSize;
  background: BackgroundColor;
  backgroundImage: BackgroundImage | null;
  backgroundFit: BackgroundFit;
  backgroundOpacity: number;
  customFonts: CustomFont[];
  onSelect: (id: string) => void;
  onAddLayer: () => void;
  onImportSvgLayer: (file: File) => void;
  onDeleteLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onMoveLayerUp: (id: string) => void;
  onMoveLayerDown: (id: string) => void;
  onRenameLayer: (id: string, name: string) => void;
  onUpdateLayer: <K extends keyof TextLayer>(
    id: string,
    key: K,
    value: TextLayer[K],
  ) => void;
  onUpdateTransform: (id: string, patch: Partial<TextLayer['transform']>) => void;
  onSetAnimation: (id: string, anim: AnimationType) => void;
  onTogglePauseLayer: (id: string) => void;
  onResetTransform: (id: string) => void;
  onChangeCanvasSize: (size: CanvasSize) => void;
  onChangeBackground: (bg: BackgroundColor) => void;
  onAddFont: (font: CustomFont) => void;
  onRemoveFont: (id: string) => void;
  onUploadBackgroundImage: (file: File) => void;
  onRemoveBackgroundImage: () => void;
  onChangeBackgroundFit: (fit: BackgroundFit) => void;
  onChangeBackgroundOpacity: (opacity: number) => void;
  pausedLayerIds: Set<string>;
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

export const ControlPanel: React.FC<ControlPanelProps> = (props) => {
  const {
    layers,
    selectedId,
    canvasSize,
    background,
    backgroundImage,
    backgroundFit,
    backgroundOpacity,
    customFonts,
    onSelect,
    onAddLayer,
    onImportSvgLayer,
    onDeleteLayer,
    onDuplicateLayer,
    onMoveLayerUp,
    onMoveLayerDown,
    onRenameLayer,
    onUpdateLayer,
    onUpdateTransform,
    onSetAnimation,
    onTogglePauseLayer,
    onResetTransform,
    onChangeCanvasSize,
    onChangeBackground,
    onAddFont,
    onRemoveFont,
    onUploadBackgroundImage,
    onRemoveBackgroundImage,
    onChangeBackgroundFit,
    onChangeBackgroundOpacity,
    pausedLayerIds,
    orbitCenterUi,
    handheld,
    camera,
  } = props;

  const selected = layers.find((l) => l.id === selectedId) ?? layers[0] ?? null;

  return (
    <aside className="flex h-full min-h-0 w-[380px] shrink-0 flex-col border-r border-border-soft bg-bg-panel">
      {/* Scrollable inner panel — macOS sidebar with grouped cards */}
      <div className="thin-scroll flex-1 min-h-0 space-y-3 overflow-y-auto p-3">
        <LayerList
          layers={layers}
          selectedId={selectedId}
          onSelect={onSelect}
          onAdd={onAddLayer}
          onImportSvg={onImportSvgLayer}
          onDelete={onDeleteLayer}
          onDuplicate={onDuplicateLayer}
          onMoveUp={onMoveLayerUp}
          onMoveDown={onMoveLayerDown}
          onRename={onRenameLayer}
        />

        <CameraMotionPanel handheld={handheld} camera={camera} orbitCenterUi={orbitCenterUi} />

        {selected && (
          <TextEditor
            selected={selected}
            onUpdateLayer={onUpdateLayer}
            customFonts={customFonts}
            onAddFont={onAddFont}
            onRemoveFont={onRemoveFont}
          />
        )}

        {selected && (
          <Transform3DEditor
            selected={selected}
            onUpdateTransform={onUpdateTransform}
            onResetTransform={onResetTransform}
          />
        )}

        {selected && (
          <MotionPanel
            selected={selected}
            paused={pausedLayerIds.has(selected.id)}
            onSetAnimation={onSetAnimation}
            onTogglePauseLayer={onTogglePauseLayer}
          />
        )}

        <GlobalSettingsPanel
          canvasSize={canvasSize}
          background={background}
          backgroundImage={backgroundImage}
          backgroundFit={backgroundFit}
          backgroundOpacity={backgroundOpacity}
          onChangeCanvasSize={onChangeCanvasSize}
          onChangeBackground={onChangeBackground}
          onUploadBackgroundImage={onUploadBackgroundImage}
          onRemoveBackgroundImage={onRemoveBackgroundImage}
          onChangeBackgroundFit={onChangeBackgroundFit}
          onChangeBackgroundOpacity={onChangeBackgroundOpacity}
        />

        <div className="macos-card p-3 text-[10px] leading-relaxed text-fg-muted">
          <p className="section-title">Rendering Rules</p>
          <p>Line breaks strictly follow Enter key presses in the text box.</p>
          <p>No auto-wrapping is applied; over-long lines will be clipped.</p>
          <p className="mt-2">
            Animations run per-layer. Press <span className="text-fg-bright">Pause</span>{' '}
            on each layer to freeze it. Export always captures the static frame.
          </p>
        </div>
      </div>
    </aside>
  );
};

/* ---------------- Subpanels ---------------- */

const BUILT_IN_FONT_OPTIONS: { label: string; value: string; family: string }[] = [
  {
    label: 'Default (Inter)',
    value: '',
    family:
      "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    label: 'System Sans',
    value: '__system_sans',
    family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    label: 'System Serif',
    value: '__system_serif',
    family: "Georgia, 'Times New Roman', Times, serif",
  },
  {
    label: 'System Mono',
    value: '__system_mono',
    family: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
  },
];

const TextEditor: React.FC<{
  selected: TextLayer;
  onUpdateLayer: ControlPanelProps['onUpdateLayer'];
  customFonts: CustomFont[];
  onAddFont: (font: CustomFont) => void;
  onRemoveFont: (id: string) => void;
}> = ({ selected, onUpdateLayer, customFonts, onAddFont, onRemoveFont }) => {
  const id = selected.id;
  const weightOptions: readonly FontWeight[] = ['Normal', 'Medium', 'Bold'] as const;
  const alignOptions: readonly Align[] = ['Left', 'Center', 'Right'] as const;

  const fontOptions = [
    ...BUILT_IN_FONT_OPTIONS,
    ...customFonts.map<{ label: string; value: string; family: string }>((f) => ({
      label: f.sourceName,
      value: f.id,
      family: `'${f.family}', sans-serif`,
    })),
  ];

  const selectedFont =
    fontOptions.find((f) => f.value === selected.fontFamily) ?? fontOptions[0];

  // -------- SVG layer editor --------
  if (selected.svgContent && selected.svgWidth && selected.svgHeight) {
    const scale = selected.svgScale ?? 1;
    const pct = Math.round(scale * 100);
    const dispW = Math.round(selected.svgWidth * scale);
    const dispH = Math.round(selected.svgHeight * scale);
    return (
      <section className="macos-card p-3">
        <h3 className="subsection-title">SVG Content</h3>

        <div className="mb-4 rounded-macos border border-border-soft bg-bg-input p-2.5">
          <div className="mb-2 flex items-center justify-between text-[10px] text-fg-muted">
            <span>Preview · native size</span>
            <span className="font-mono">
              {selected.svgWidth} × {selected.svgHeight}
            </span>
          </div>
          <div
            className="flex max-h-36 items-center justify-center overflow-hidden rounded bg-bg-card"
            dangerouslySetInnerHTML={{
              __html: (() => {
                const fit = Math.min(1, 180 / Math.max(selected.svgWidth ?? 200, selected.svgHeight ?? 200));
                const pw = Math.round((selected.svgWidth ?? 200) * fit);
                const ph = Math.round((selected.svgHeight ?? 200) * fit);
                return (selected.svgContent ?? '')
                  .replace(/(<svg[^>]*?)\swidth=["'][^"']*["']/i, `$1 width="${pw}"`)
                  .replace(/(<svg[^>]*?)\sheight=["'][^"']*["']/i, `$1 height="${ph}"`);
              })(),
            }}
          />
        </div>

        <div className="mb-4">
          <div className="field-label">
            <span>Scale</span>
            <span className="field-value">
              {pct}% · ×{scale.toFixed(2)}
            </span>
          </div>
          <div className="mb-1">
            <input
              type="range"
              className="slider"
              min={0.1}
              max={5}
              step={0.01}
              value={scale}
              onChange={(e) =>
                onUpdateLayer(id, 'svgScale', clamp(Number(e.target.value), 0.1, 5))
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.01}
              value={Number(scale.toFixed(2))}
              onChange={(e) =>
                onUpdateLayer(id, 'svgScale', clamp(Number(e.target.value), 0.1, 5))
              }
              className="input-base flex-1"
            />
            <div className="flex items-center gap-1">
              {[0.25, 0.5, 1, 2, 4].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onUpdateLayer(id, 'svgScale', preset)}
                  className={[
                    'btn h-8 px-2 !text-[10px]',
                    Math.abs(scale - preset) < 0.001 ? 'btn-primary' : '',
                  ].join(' ')}
                  title={`Set scale to ${preset}×`}
                >
                  {preset < 1 ? `${preset * 100 | 0}%` : `${preset}×`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <div className="field-label">
              <span>Scaled Width</span>
              <span className="field-value">{dispW}px</span>
            </div>
            <div className="rounded-macos border border-border-soft bg-bg-input px-2.5 py-1.5 font-mono text-[11px] text-fg-dim">
              {selected.svgWidth} × {scale.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="field-label">
              <span>Scaled Height</span>
              <span className="field-value">{dispH}px</span>
            </div>
            <div className="rounded-macos border border-border-soft bg-bg-input px-2.5 py-1.5 font-mono text-[11px] text-fg-dim">
              {selected.svgHeight} × {scale.toFixed(2)}
            </div>
          </div>
        </div>

        <Slider
          label="Vertical Offset"
          value={selected.verticalOffset}
          min={-1000}
          max={1000}
          step={1}
          suffix="px"
          onChange={(v) => onUpdateLayer(id, 'verticalOffset', v)}
        />
        <Slider
          label="Horizontal Offset"
          value={selected.horizontalOffset}
          min={-1000}
          max={1000}
          step={1}
          suffix="px"
          onChange={(v) => onUpdateLayer(id, 'horizontalOffset', v)}
        />
      </section>
    );
  }

  // -------- Text layer editor (existing) --------
  return (
    <section className="macos-card p-3">
      <h3 className="subsection-title">Text Content</h3>

      <div className="mb-4">
        <div className="field-label">
          <span>Text</span>
          <span className="field-value">{selected.text.length} chars</span>
        </div>
        <textarea
          value={selected.text}
          onChange={(e) => onUpdateLayer(id, 'text', e.target.value)}
          rows={4}
          className="input-base resize-y leading-relaxed"
          placeholder="Type your text. Press Enter for a new line."
          spellCheck={false}
          style={{ whiteSpace: 'pre' }}
        />
      </div>

      <div className="mb-4">
        <FontManager
          fonts={customFonts}
          onAdd={onAddFont}
          onRemove={onRemoveFont}
        />
      </div>

      <div className="mb-4">
        <div className="field-label">
          <span>Font Family</span>
          <span className="field-value">
            {customFonts.length > 0 ? `${customFonts.length} loaded` : 'built-in'}
          </span>
        </div>
        <select
          value={selectedFont.value}
          onChange={(e) => onUpdateLayer(id, 'fontFamily', e.target.value)}
          className="input-base pr-2"
          style={{ fontFamily: selectedFont.family }}
        >
          {fontOptions.map((opt) => (
            <option key={opt.value} value={opt.value} style={{ fontFamily: opt.family }}>
              {opt.label}
            </option>
          ))}
        </select>
        <div
          className="mt-1.5 truncate rounded-macos border border-border-soft bg-bg-input px-2.5 py-1.5 text-[14px] text-fg-bright"
          style={{ fontFamily: selectedFont.family }}
        >
          Poster Typography Aa Bb Cc 123
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <div className="field-label">
            <span>Font Size</span>
            <span className="field-value">{selected.fontSize}px</span>
          </div>
          <input
            type="number"
            min={6}
            max={400}
            value={selected.fontSize}
            onChange={(e) =>
              onUpdateLayer(id, 'fontSize', clamp(Number(e.target.value), 6, 400))
            }
            className="input-base"
          />
        </div>
        <div>
          <div className="field-label">
            <span>Font Weight</span>
            <span className="field-value">{FONT_WEIGHT_MAP[selected.fontWeight]}</span>
          </div>
          <SegmentedControl
            value={selected.fontWeight}
            options={weightOptions}
            onChange={(v) => onUpdateLayer(id, 'fontWeight', v)}
          />
        </div>
      </div>

      <div className="mb-4">
        <div className="field-label">
          <span>Horizontal Align</span>
          <span className="field-value">{ALIGN_MAP[selected.align]}</span>
        </div>
        <SegmentedControl
          value={selected.align}
          options={alignOptions}
          onChange={(v) => onUpdateLayer(id, 'align', v)}
        />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <div className="field-label">
            <span>Letter Spacing</span>
            <span className="field-value">{selected.letterSpacing}px</span>
          </div>
          <div className="mb-1">
            <input
              type="range"
              className="slider"
              min={-10}
              max={80}
              step={1}
              value={selected.letterSpacing}
              onChange={(e) => onUpdateLayer(id, 'letterSpacing', Number(e.target.value))}
            />
          </div>
          <input
            type="number"
            min={-20}
            max={200}
            step={1}
            value={selected.letterSpacing}
            onChange={(e) =>
              onUpdateLayer(
                id,
                'letterSpacing',
                clamp(Number(e.target.value), -20, 200),
              )
            }
            className="input-base"
          />
        </div>
        <div>
          <div className="field-label">
            <span>Line Height</span>
            <span className="field-value">×{selected.lineHeight.toFixed(2)}</span>
          </div>
          <div className="mb-1">
            <input
              type="range"
              className="slider"
              min={0.8}
              max={3}
              step={0.05}
              value={selected.lineHeight}
              onChange={(e) =>
                onUpdateLayer(id, 'lineHeight', Number(e.target.value))
              }
            />
          </div>
          <input
            type="number"
            min={0.5}
            max={6}
            step={0.05}
            value={selected.lineHeight}
            onChange={(e) =>
              onUpdateLayer(id, 'lineHeight', clamp(Number(e.target.value), 0.5, 6))
            }
            className="input-base"
          />
        </div>
      </div>

      <div className="mb-4">
        <div className="field-label">
          <span>Color</span>
          <span className="field-value font-mono">{selected.color}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {GRAYSCALE_COLORS.map((c) => {
            const active = c.toLowerCase() === selected.color.toLowerCase();
            return (
              <button
                key={c}
                type="button"
                onClick={() => onUpdateLayer(id, 'color', c)}
                className={[
                  'h-7 w-7 rounded-macos border transition-all',
                  active
                    ? 'border-accent-blue ring-2 ring-accent-blue/30'
                    : 'border-border-soft hover:border-border-medium',
                ].join(' ')}
                style={{ background: c }}
                title={c}
              />
            );
          })}
        </div>
      </div>

      <Slider
        label="Vertical Offset"
        value={selected.verticalOffset}
        min={-1000}
        max={1000}
        step={1}
        suffix="px"
        onChange={(v) => onUpdateLayer(id, 'verticalOffset', v)}
      />
      <Slider
        label="Horizontal Offset"
        value={selected.horizontalOffset}
        min={-1000}
        max={1000}
        step={1}
        suffix="px"
        onChange={(v) => onUpdateLayer(id, 'horizontalOffset', v)}
      />
    </section>
  );
};

const Transform3DEditor: React.FC<{
  selected: TextLayer;
  onUpdateTransform: ControlPanelProps['onUpdateTransform'];
  onResetTransform: (id: string) => void;
}> = ({ selected, onUpdateTransform, onResetTransform }) => {
  const t = selected.transform;
  const patch = (p: Partial<TextLayer['transform']>) =>
    onUpdateTransform(selected.id, p);

  return (
    <section className="macos-card p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="subsection-title !mb-0">3D Transform</h3>
        <button
          type="button"
          onClick={() => onResetTransform(selected.id)}
          className="btn h-7 px-2.5 text-[10px]"
          title="Reset Current Layer 3D"
        >
          Reset 3D
        </button>
      </div>

      <Slider
        label="Rotate X"
        value={t.rotateX}
        min={-60}
        max={60}
        step={1}
        suffix="°"
        onChange={(v) => patch({ rotateX: v })}
      />
      <Slider
        label="Rotate Y"
        value={t.rotateY}
        min={-60}
        max={60}
        step={1}
        suffix="°"
        onChange={(v) => patch({ rotateY: v })}
      />
      <Slider
        label="Rotate Z"
        value={t.rotateZ}
        min={-45}
        max={45}
        step={1}
        suffix="°"
        onChange={(v) => patch({ rotateZ: v })}
      />
      <Slider
        label="Perspective"
        value={t.perspective}
        min={300}
        max={1500}
        step={10}
        suffix="px"
        onChange={(v) => patch({ perspective: v })}
      />
    </section>
  );
};

const MotionPanel: React.FC<{
  selected: TextLayer;
  paused: boolean;
  onSetAnimation: (id: string, anim: AnimationType) => void;
  onTogglePauseLayer: (id: string) => void;
}> = ({ selected, paused, onSetAnimation, onTogglePauseLayer }) => {
  const buttons: { anim: Exclude<AnimationType, 'none'>; label: string }[] = [
    { anim: 'expand', label: 'Expand' },
    { anim: 'contract', label: 'Contract' },
    { anim: 'pulse', label: 'Pulse' },
    { anim: 'sway', label: 'Sway' },
    { anim: 'float', label: 'Float' },
    { anim: 'shake', label: 'Shake' },
  ];

  const active = selected.animation !== 'none';

  return (
    <section className="macos-card p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="subsection-title !mb-0">Motion & Shape</h3>
        {active && (
          <span
            className={[
              'chip',
              paused ? '!text-fg-muted' : '!border-accent-blue !text-fg-bright',
            ].join(' ')}
          >
            {paused ? 'Paused' : 'Playing'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {buttons.map((b) => {
          const isCurrent = selected.animation === b.anim && !paused;
          return (
            <button
              key={b.anim}
              type="button"
              onClick={() => onSetAnimation(selected.id, b.anim)}
              className={[
                'btn h-10 text-[11px]',
                isCurrent ? 'btn-primary' : '',
              ].join(' ')}
              title={
                selected.animation === b.anim
                  ? 'Re-play this animation on the current layer'
                  : `Play ${b.label} on this layer only`
              }
            >
              {b.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => onTogglePauseLayer(selected.id)}
          disabled={!active}
          className="btn h-10 flex-1"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={() => onSetAnimation(selected.id, 'none')}
          disabled={!active && !paused}
          className="btn h-10 flex-1"
        >
          Stop Animation
        </button>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-fg-muted">
        Motions run independently on each layer. Switching layers lets you set
        another motion on a different layer.
      </p>
    </section>
  );
};

function NumberField({
  label,
  value,
  onChange,
  onFocus,
  onBlur,
  placeholder,
  readOnly = false,
}: {
  label: string;
  value: string | number;
  onChange: (raw: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-widest text-fg-muted">
        <span>{label}</span>
        <span className="font-mono normal-case tracking-normal text-fg-dim">
          {value}
        </span>
      </span>
      {readOnly ? (
        <div className="input-base cursor-default font-mono text-fg-bright opacity-80">
          {value}
        </div>
      ) : (
        <input
          type="text"
          inputMode="numeric"
          pattern="\d*"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className="input-base font-mono"
        />
      )}
    </label>
  );
}

function parseDigitsToInt(raw: string): number | null {
  // Only accept digits. Leading zeros are fine. Returns null for empty.
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function CustomSizeEditor({
  initialW,
  initialH,
  min,
  max,
  onApply,
}: {
  initialW: number;
  initialH: number;
  min: number;
  max: number;
  onApply: (width: number, height: number) => void;
}) {
  // Use string state so users can type multi-digit numbers without React
  // coercing intermediate values (e.g. empty or leading zeros) into numbers
  // that overwrite their keystrokes.
  const [w, setW] = useState<string>(String(initialW));
  const [h, setH] = useState<string>(String(initialH));
  const [lock, setLock] = useState(false);
  const [editing, setEditing] = useState<null | 'w' | 'h'>(null);
  const baseRatioRef = useRef<number>(initialW / initialH);
  const lastAppliedRef = useRef<{ w: number; h: number }>({
    w: initialW,
    h: initialH,
  });

  // Sync editor inputs to a NEW external size only when it's actually different
  // from the last thing we applied, AND the user is not in the middle of typing.
  useEffect(() => {
    if (editing != null) return;
    if (
      initialW !== lastAppliedRef.current.w ||
      initialH !== lastAppliedRef.current.h
    ) {
      lastAppliedRef.current = { w: initialW, h: initialH };
      baseRatioRef.current = initialW / initialH;
      setW(String(initialW));
      setH(String(initialH));
    }
  }, [editing, initialH, initialW]);

  const commitNumber = (raw: string) => {
    const n = parseDigitsToInt(raw);
    if (n == null) return raw;
    return String(clamp(n, min, max));
  };

  const onWChange = (raw: string) => {
    const filtered = raw.replace(/[^\d]/g, '');
    setW(filtered);
    if (lock) {
      const wn = parseDigitsToInt(filtered);
      const ratio = baseRatioRef.current;
      if (wn != null && Number.isFinite(ratio) && ratio > 0) {
        setH(String(Math.round(clamp(wn / ratio, min, max))));
      }
    }
  };

  const onHChange = (raw: string) => {
    const filtered = raw.replace(/[^\d]/g, '');
    setH(filtered);
    if (lock) {
      const hn = parseDigitsToInt(filtered);
      const ratio = baseRatioRef.current;
      if (hn != null && Number.isFinite(ratio) && ratio > 0) {
        setW(String(Math.round(clamp(hn * ratio, min, max))));
      }
    }
  };

  const onWBlur = () => {
    setW(commitNumber(w));
    setEditing((e) => (e === 'w' ? null : e));
    // Update the base aspect when user commits one side; we recompute ratio
    // based on current numeric values so Lock uses the most recently
    // committed intent rather than forever clinging to initial preset ratio.
    const wn = parseDigitsToInt(w);
    const hn = parseDigitsToInt(h);
    if (wn != null && hn != null && hn > 0) baseRatioRef.current = wn / hn;
  };

  const onHBlur = () => {
    setH(commitNumber(h));
    setEditing((e) => (e === 'h' ? null : e));
    const wn = parseDigitsToInt(w);
    const hn = parseDigitsToInt(h);
    if (wn != null && hn != null && hn > 0) baseRatioRef.current = wn / hn;
  };

  const apply = () => {
    const committedW = commitNumber(w);
    const committedH = commitNumber(h);
    setW(committedW);
    setH(committedH);
    const finalW = clamp(parseInt(committedW || String(min), 10) || min, min, max);
    const finalH = clamp(parseInt(committedH || String(min), 10) || min, min, max);
    lastAppliedRef.current = { w: finalW, h: finalH };
    baseRatioRef.current = finalW / finalH;
    onApply(finalW, finalH);
  };

  return (
    <div className="macos-card p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="subsection-title !mb-0">Set Size (px)</span>
        <label className="flex cursor-pointer items-center gap-1.5 text-[10px] tracking-wide text-fg-dim">
          <input
            type="checkbox"
            className="h-3 w-3 accent-accent-blue"
            checked={lock}
            onChange={(e) => setLock(e.target.checked)}
          />
          Lock Aspect
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Width"
          value={w}
          onChange={onWChange}
          onFocus={() => setEditing('w')}
          onBlur={onWBlur}
          placeholder={`${min}–${max}`}
        />
        <NumberField
          label="Height"
          value={h}
          onChange={onHChange}
          onFocus={() => setEditing('h')}
          onBlur={onHBlur}
          placeholder={`${min}–${max}`}
        />
      </div>
      <button
        type="button"
        onClick={apply}
        className="btn mt-2 w-full h-9"
      >
        Apply Custom Size
      </button>
      <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
        Input accepts positive integers only. Values outside {min}–{max} will be
        clamped automatically when you apply.
      </p>
    </div>
  );
}

const GlobalSettingsPanel: React.FC<{
  canvasSize: CanvasSize;
  background: BackgroundColor;
  backgroundImage: BackgroundImage | null;
  backgroundFit: BackgroundFit;
  backgroundOpacity: number;
  onChangeCanvasSize: (s: CanvasSize) => void;
  onChangeBackground: (bg: BackgroundColor) => void;
  onUploadBackgroundImage: (file: File) => void;
  onRemoveBackgroundImage: () => void;
  onChangeBackgroundFit: (fit: BackgroundFit) => void;
  onChangeBackgroundOpacity: (opacity: number) => void;
}> = ({
  canvasSize,
  background,
  backgroundImage,
  backgroundFit,
  backgroundOpacity,
  onChangeCanvasSize,
  onChangeBackground,
  onUploadBackgroundImage,
  onRemoveBackgroundImage,
  onChangeBackgroundFit,
  onChangeBackgroundOpacity,
}) => {
  const bgOptions: readonly BackgroundColor[] = ['Black', 'Dark Gray', 'White'] as const;

  const CUSTOM_MIN = 200;
  const CUSTOM_MAX = 4000;

  return (
    <section className="macos-card p-3">
      <h3 className="section-title">Global Settings</h3>

      <div className="mb-4">
        <div className="field-label">
          <span>Canvas Size Presets</span>
          <span className="field-value">
            {canvasSize.width}×{canvasSize.height}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {CANVAS_PRESETS.map((p) => {
            const active = p.id === canvasSize.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChangeCanvasSize(p)}
                className={[
                  'flex flex-col items-start rounded-macos border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-accent-blue bg-bg-card-hover'
                    : 'border-border-soft bg-bg-input hover:border-border-medium',
                ].join(' ')}
              >
                <span className="text-[10px] font-medium text-fg-bright">{p.label}</span>
                <span className="mt-0.5 font-mono text-[10px] text-fg-muted">
                  {p.width}×{p.height}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-4">
        <CustomSizeEditor
          initialW={canvasSize.width}
          initialH={canvasSize.height}
          min={CUSTOM_MIN}
          max={CUSTOM_MAX}
          onApply={(w, h) =>
            onChangeCanvasSize({
              id: 'custom',
              label: `Custom ${w}×${h}`,
              width: w,
              height: h,
            })
          }
        />
      </div>

      <div>
        <div className="field-label">
          <span>Background</span>
          <span className="field-value">{background}</span>
        </div>
        <div className="flex gap-2">
          {bgOptions.map((opt) => {
            const active = opt === background;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChangeBackground(opt)}
                className={[
                  'flex items-center gap-2 rounded-macos border px-3 py-2 text-[11px] transition-colors',
                  active
                    ? 'border-accent-blue bg-bg-card-hover text-fg-bright'
                    : 'border-border-soft bg-bg-input text-fg-dim hover:border-border-medium hover:text-fg-bright',
                ].join(' ')}
              >
                <span
                  className="h-4 w-4 rounded-macos border border-border-soft"
                  style={{ background: BACKGROUND_COLORS[opt] }}
                />
                {opt}
              </button>
            );
          })}
        </div>
      </div>

      <BackgroundImagePicker
        backgroundImage={backgroundImage}
        fit={backgroundFit}
        opacity={backgroundOpacity}
        onUpload={onUploadBackgroundImage}
        onRemove={onRemoveBackgroundImage}
        onChangeFit={onChangeBackgroundFit}
        onChangeOpacity={onChangeBackgroundOpacity}
      />
    </section>
  );
};

const FIT_OPTIONS: readonly BackgroundFit[] = [
  'Cover',
  'Contain',
  'Fill',
  'Tile',
  'Center',
] as const;

function BackgroundImagePicker({
  backgroundImage,
  fit,
  opacity,
  onUpload,
  onRemove,
  onChangeFit,
  onChangeOpacity,
}: {
  backgroundImage: BackgroundImage | null;
  fit: BackgroundFit;
  opacity: number;
  onUpload: (file: File) => void;
  onRemove: () => void;
  onChangeFit: (fit: BackgroundFit) => void;
  onChangeOpacity: (opacity: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file) onUpload(file);
  };
  return (
    <div className="mt-4">
      <div className="field-label">
        <span>Background Image</span>
        <span className="field-value">
          {backgroundImage ? 'Uploaded' : 'None'}
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onFiles(e.target.files)}
      />

      {backgroundImage ? (
        <div className="rounded-macos border border-border-soft bg-bg-input p-2">
          <div className="mb-2 flex items-center gap-2">
            <div
              className="h-12 w-16 shrink-0 overflow-hidden rounded-macos border border-border-soft bg-black"
              style={{
                backgroundImage: `url(${backgroundImage.url})`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                backgroundSize: 'cover',
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium text-fg-bright">
                {backgroundImage.sourceName}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-fg-muted">
                {backgroundImage.width}×{backgroundImage.height} px
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="btn h-8"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="btn h-8"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-macos border border-dashed px-3 py-4 text-[11px] transition-colors',
            'border-border-medium bg-bg-input text-fg-dim hover:border-accent-blue hover:text-fg-bright hover:bg-bg-card',
          ].join(' ')}
        >
          <span className="text-base leading-none">+</span>
          Upload Local Image
        </button>
      )}

      {backgroundImage && (
        <>
          <div className="mt-3">
            <div className="field-label">
              <span>Fit</span>
              <span className="field-value">{fit}</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {FIT_OPTIONS.map((opt) => {
                const active = fit === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => onChangeFit(opt)}
                    className={[
                      'h-8 rounded-macos border text-[10px] font-medium tracking-wide transition-colors',
                      active
                        ? 'border-accent-blue bg-accent-blue text-bg-deep'
                        : 'border-border-soft bg-bg-input text-fg-dim hover:border-border-medium hover:text-fg-bright',
                    ].join(' ')}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-3">
            <div className="field-label">
              <span>Opacity</span>
              <span className="field-value">
                {Math.round(opacity * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={opacity}
                onChange={(e) =>
                  onChangeOpacity(clamp(Number(e.target.value), 0, 1))
                }
                className="slider flex-1"
              />
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(opacity * 100)}
                onChange={(e) =>
                  onChangeOpacity(
                    clamp(Number(e.target.value) / 100, 0, 1),
                  )
                }
                className="input-base !w-16 !px-2 !py-1.5 text-right font-mono text-[11px]"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}
