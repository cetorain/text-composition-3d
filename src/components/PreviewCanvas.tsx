import React, { forwardRef, useMemo } from 'react';
import type {
  Align,
  AnimationType,
  BackgroundColor,
  BackgroundFit,
  BackgroundImageSettings,
  CanvasSize,
  CustomFont,
  TextLayer,
} from '../types';
import type { CameraRig } from '../camera';
import {
  ALIGN_MAP,
  BACKGROUND_COLORS,
  FONT_WEIGHT_MAP,
} from '../types';

interface PreviewCanvasProps {
  layers: TextLayer[];
  canvasSize: CanvasSize;
  background: BackgroundColor;
  backgroundSettings: BackgroundImageSettings;
  customFonts: CustomFont[];
  pausedLayerIds: Set<string>;
  cameraRig: CameraRig;
  /**
   * Absolute pixel position (within the canvas frame) that camera rotations
   * and dolly zoom should revolve around. The default headline anchor lives
   * here, so camera motion always orbits *around the headline text*, even
   * when the user moves it to any corner of the canvas via h/v offsets.
   */
  orbitCenterPx: { x: number; y: number };
}

const FIT_STYLE: Record<
  BackgroundFit,
  Pick<React.CSSProperties, 'backgroundSize' | 'backgroundRepeat' | 'backgroundPosition'>
> = {
  Cover: {
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
  Contain: {
    backgroundSize: 'contain',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
  Fill: {
    backgroundSize: '100% 100%',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
  Tile: {
    backgroundSize: 'auto',
    backgroundRepeat: 'repeat',
    backgroundPosition: 'top left',
  },
  Center: {
    backgroundSize: 'auto',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
};

const BUILT_IN_FONT_MAP: Record<string, string> = {
  __system_sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  __system_serif: "Georgia, 'Times New Roman', Times, serif",
  __system_mono:
    "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
};

function resolveFontFamily(
  stored: string,
  customFonts: CustomFont[],
): string {
  if (!stored) {
    return "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  }
  if (BUILT_IN_FONT_MAP[stored]) return BUILT_IN_FONT_MAP[stored];
  const f = customFonts.find((x) => x.id === stored);
  if (f) return `'${f.family}', sans-serif`;
  return "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
}

/**
 * The actual poster canvas. Its DOM size is exactly canvasSize.width x height,
 * and it is visually scaled down to fit the stage using CSS transform: scale().
 *
 * It is forward-ref'd so the App can pass it to html-to-image for PNG export.
 *
 * Camera motion lives INSIDE the frame: the canvas rectangle stays rock solid,
 * and only the poster content (layers) moves / rotates / zooms within it.
 */
export const PreviewCanvas = forwardRef<HTMLDivElement, PreviewCanvasProps>(
  (
    {
      layers,
      canvasSize,
      background,
      backgroundSettings,
      customFonts,
      pausedLayerIds,
      cameraRig,
      orbitCenterPx,
    },
    ref,
  ) => {
    const bg = BACKGROUND_COLORS[background];
    const fitStyle = FIT_STYLE[backgroundSettings.fit];
    const bgImageLayer = backgroundSettings.image
      ? {
          backgroundImage: `url(${backgroundSettings.image.url})`,
          ...fitStyle,
          opacity: backgroundSettings.opacity,
        }
      : null;

    const innerPerspectiveStyle: React.CSSProperties = useMemo(
      () => {
        const camActive =
          cameraRig.orbitX !== 0 ||
          cameraRig.orbitY !== 0 ||
          cameraRig.orbitZ !== 0 ||
          cameraRig.dolly !== 1 ||
          cameraRig.panX !== 0 ||
          cameraRig.panY !== 0 ||
          cameraRig.z !== 0;
        return {
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          // Only set perspective when camera is active. Perspective forces
          // 3D rendering context which rasterizes child SVGs into GPU
          // textures. When at rest, omitting it keeps SVGs as pure vector.
          ...(camActive
            ? {
                perspective: `${cameraRig.perspective}px`,
                perspectiveOrigin: `${orbitCenterPx.x}px ${orbitCenterPx.y}px`,
              }
            : {}),
        };
      },
      [cameraRig.perspective, cameraRig.orbitX, cameraRig.orbitY, cameraRig.orbitZ, cameraRig.dolly, cameraRig.panX, cameraRig.panY, cameraRig.z, orbitCenterPx.x, orbitCenterPx.y],
    );

    const innerStageStyle: React.CSSProperties = useMemo(() => {
      const camActive =
        cameraRig.orbitX !== 0 ||
        cameraRig.orbitY !== 0 ||
        cameraRig.orbitZ !== 0 ||
        cameraRig.dolly !== 1 ||
        cameraRig.panX !== 0 ||
        cameraRig.panY !== 0 ||
        cameraRig.z !== 0;
      const transform = `translate3d(${cameraRig.panX}px, ${cameraRig.panY}px, ${cameraRig.z}px) rotateX(${cameraRig.orbitX}deg) rotateY(${cameraRig.orbitY}deg) rotateZ(${cameraRig.orbitZ}deg) scale(${cameraRig.dolly})`;
      return {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        // Only set transform / preserve-3d when the camera is actually
        // active. When at rest, omitting these properties prevents the
        // browser from creating a GPU compositing layer that would
        // rasterize inline SVGs into a fixed-size texture (the main
        // cause of SVG blurriness in preview).
        ...(camActive
          ? {
              transform,
              transformOrigin: `${orbitCenterPx.x}px ${orbitCenterPx.y}px`,
              transformStyle: 'preserve-3d' as const,
            }
          : {}),
      };
    }, [
      cameraRig.dolly,
      cameraRig.orbitX,
      cameraRig.orbitY,
      cameraRig.orbitZ,
      cameraRig.panX,
      cameraRig.panY,
      cameraRig.z,
      orbitCenterPx.x,
      orbitCenterPx.y,
    ]);

    return (
      <div
        ref={ref}
        data-canvas-root
        style={{
          width: canvasSize.width,
          height: canvasSize.height,
          background: bg,
          position: 'relative',
          overflow: 'hidden',
          transformOrigin: 'top left',
        }}
      >
        {bgImageLayer && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              ...bgImageLayer,
            }}
          />
        )}
        <div data-perspective-wrapper style={innerPerspectiveStyle}>
          <div data-stage-wrapper style={innerStageStyle}>
            {layers.map((layer) => (
              <LayerView
                key={layer.id}
                layer={layer}
                canvasHeight={canvasSize.height}
                customFonts={customFonts}
                paused={pausedLayerIds.has(layer.id)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  },
);
PreviewCanvas.displayName = 'PreviewCanvas';

/* ---------- Individual layer ---------- */

const animClass: Record<Exclude<AnimationType, 'none'>, string> = {
  expand: 'anim-expand',
  contract: 'anim-contract',
  pulse: 'anim-pulse',
  sway: 'anim-sway',
  float: 'anim-float',
  shake: 'anim-shake',
};

const LayerView: React.FC<{
  layer: TextLayer;
  canvasHeight: number;
  customFonts: CustomFont[];
  paused: boolean;
}> = ({ layer, canvasHeight, customFonts, paused }) => {
  const { transform } = layer;

  const hasLayerRotation =
    transform.rotateX !== 0 || transform.rotateY !== 0 || transform.rotateZ !== 0;

  const outerStyle: React.CSSProperties = useMemo(
    () => ({
      position: 'absolute',
      inset: 0,
      display: 'flex',
      justifyContent: mapJustify(layer.align),
      alignItems: 'center',
      pointerEvents: 'none',
      // Only set perspective when the layer has 3D rotation. Perspective
      // forces a 3D rendering context that rasterizes inline SVGs.
      ...(hasLayerRotation
        ? {
            perspective: `${transform.perspective}px`,
            perspectiveOrigin: 'center center',
          }
        : {}),
    }),
    [layer.align, transform.perspective, hasLayerRotation],
  );

  // vertical center is at 50% of canvas height; offset is in pixels
  const topPx = canvasHeight / 2 + layer.verticalOffset;
  const leftPx = '50%';
  const translateXBase =
    layer.align === 'Center' ? '-50%' : layer.align === 'Left' ? '0%' : '-100%';

  const innerTransform = `rotateX(${transform.rotateX}deg) rotateY(${transform.rotateY}deg) rotateZ(${transform.rotateZ}deg)`;

  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: leftPx,
    width: 'auto',
    maxWidth: 'none',
    transform: `translate(${translateXBase}, 0px) translateX(${layer.horizontalOffset}px)`,
    marginTop: topPx,
    transformStyle: 'preserve-3d',
    '--base-scale': 1,
    '--sway-base-z': `${transform.rotateZ}deg`,
  } as React.CSSProperties;

  const animationCls =
    layer.animation !== 'none' && !paused ? animClass[layer.animation] : '';

  // --- SVG layer rendering ---
  if (layer.svgContent && layer.svgWidth && layer.svgHeight) {
    const scale = layer.svgScale ?? 1;
    const scaledW = Math.max(1, Math.round(layer.svgWidth * scale));
    const scaledH = Math.max(1, Math.round(layer.svgHeight * scale));
    // CRISP VECTOR ZOOM: replace the width/height attributes in the SVG
    // string with the scaled dimensions. The viewBox stays the same, so the
    // browser re-renders the vector content at the target resolution.
    const scaledSvgContent = layer.svgContent
      .replace(/(<svg[^>]*?)\swidth=["'][^"']*["']/i, `$1 width="${scaledW}"`)
      .replace(/(<svg[^>]*?)\sheight=["'][^"']*["']/i, `$1 height="${scaledH}"`);
    // Only apply 3D transform / preserve-3d when the layer has actual
    // rotation. When rotation is 0, omitting transform entirely prevents
    // GPU compositing, keeping the inline SVG as pure vector DOM (sharp at
    // any zoom). When rotation is active, the GPU will rasterize, but
    // that's the unavoidable tradeoff of CSS 3D.
    const hasRotation =
      transform.rotateX !== 0 || transform.rotateY !== 0 || transform.rotateZ !== 0;
    const svgBlockStyle: React.CSSProperties = {
      width: scaledW,
      height: scaledH,
      display: 'block',
      overflow: 'visible',
      ...(hasRotation
        ? {
            transform: innerTransform,
            transformStyle: 'preserve-3d' as const,
            transformOrigin: 'center center',
          }
        : {}),
    };
    // Adjust marginTop so the visual center stays at the same canvas
    // position despite the height change from intrinsic → scaled.
    const svgWrapperStyle: React.CSSProperties = {
      ...wrapperStyle,
      marginTop: topPx - (scaledH - layer.svgHeight) / 2,
    };
    return (
      <div style={outerStyle}>
        <div style={svgWrapperStyle}>
          <span
            key={layer.animationKey}
            className={animationCls}
            style={{
              display: 'inline-block',
              ...(hasRotation ? { transformStyle: 'preserve-3d' as const } : {}),
              animationPlayState: paused ? 'paused' : 'running',
              overflow: 'visible',
            }}
          >
            <div
              style={svgBlockStyle}
              data-svg-wrapper
              data-svg-scale={scale}
              dangerouslySetInnerHTML={{ __html: scaledSvgContent }}
            />
          </span>
        </div>
      </div>
    );
  }

  // --- Text layer rendering ---
  const fontFamily = resolveFontFamily(layer.fontFamily, customFonts);

  const textBlockStyle: React.CSSProperties = {
    color: layer.color,
    fontFamily,
    fontSize: layer.fontSize,
    fontWeight: FONT_WEIGHT_MAP[layer.fontWeight],
    lineHeight: layer.lineHeight,
    letterSpacing: `${layer.letterSpacing}px`,
    textAlign: ALIGN_MAP[layer.align] as React.CSSProperties['textAlign'],
    whiteSpace: 'pre', // strict — no auto wrap, only explicit \n
    overflow: 'visible',
    display: 'inline-block',
    maxWidth: 'none',
    width: layer.align === 'Center' ? 'auto' : undefined,
    ...(hasLayerRotation
      ? {
          transform: innerTransform,
          transformStyle: 'preserve-3d' as const,
          transformOrigin: 'center center',
        }
      : {}),
  };

  return (
    <div style={outerStyle}>
      <div style={wrapperStyle}>
        <span
          key={layer.animationKey}
          className={animationCls}
          style={{
            display: 'inline-block',
            ...(hasLayerRotation ? { transformStyle: 'preserve-3d' as const } : {}),
            animationPlayState: paused ? 'paused' : 'running',
          }}
        >
          <span style={textBlockStyle}>{renderText(layer.text)}</span>
        </span>
      </div>
    </div>
  );
};

/**
 * Splits user's text on \n and renders each line.
 * Any line that is too long will exceed the canvas instead of wrapping —
 * the white-space: pre rule + overflow: visible parent ensures that.
 */
function renderText(text: string): React.ReactNode {
  const parts = text.split('\n');
  return parts.map((line, idx) => (
    <React.Fragment key={idx}>
      {line.length === 0 ? '\u200B' : line}
      {idx < parts.length - 1 && <br />}
    </React.Fragment>
  ));
}

function mapJustify(align: Align): React.CSSProperties['justifyContent'] {
  switch (align) {
    case 'Left':
      return 'flex-start';
    case 'Right':
      return 'flex-end';
    case 'Center':
    default:
      return 'center';
  }
}
