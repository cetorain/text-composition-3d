/**
 * True vector SVG export.
 *
 * Generates a standalone .svg file where every text layer is a `<text>` element
 * — no rasterization, no `<image>`, no base64.  The 3D rotations (rotateX /
 * rotateY / rotateZ) from both the camera rig and per-layer transforms are
 * approximated as 2D affine matrices, which keeps the visual result very close
 * to the CSS 3D preview while guaranteeing infinite-zoom sharpness.
 */

import type {
  TextLayer,
  CanvasSize,
  BackgroundColor,
  Align,
  CustomFont,
} from './types';
import { BACKGROUND_COLORS, FONT_WEIGHT_MAP } from './types';
import type { CameraRig } from './camera';

/* ---------- types ---------- */

export interface SvgExportConfig {
  layers: TextLayer[];
  canvasSize: CanvasSize;
  background: BackgroundColor;
  cameraRig: CameraRig;
  orbitCenterPx: { x: number; y: number };
  customFonts: CustomFont[];
  /**
   * When provided, each entry maps a layer index to its current animation
   * state (CSS transform + opacity) read from the live DOM.  The SVG will
   * bake these as inline transforms/opacity instead of emitting CSS animation
   * keyframes — producing a static SVG frozen at the current playback frame.
   */
  frozenAnimations?: Record<number, { transform: string; opacity: string }>;
}

/* ---------- math helpers ---------- */

const DEG = Math.PI / 180;

/**
 * Compute the top-left 2×2 of the rotation matrix R = Rx × Ry × Rz.
 * Returns [a, b, c, d] corresponding to SVG matrix(a b c d e f).
 *
 * For a point (x, y, 0) on the text plane:
 *   x' = a*x + c*y
 *   y' = b*x + d*y
 *
 * This is the affine approximation (no perspective foreshortening).
 * For moderate angles it is visually indistinguishable from the CSS 3D result.
 */
function rotation2DAffine(
  rotateX: number,
  rotateY: number,
  rotateZ: number,
): [number, number, number, number] {
  const crx = Math.cos(rotateX * DEG);
  const srx = Math.sin(rotateX * DEG);
  const cry = Math.cos(rotateY * DEG);
  const sry = Math.sin(rotateY * DEG);
  const crz = Math.cos(rotateZ * DEG);
  const srz = Math.sin(rotateZ * DEG);

  // R = Rx · Ry · Rz  (CSS applies right-to-left: Rz first, then Ry, then Rx)
  // R[0][0] = cry·crz
  // R[0][1] = -cry·srz
  // R[1][0] = crx·srz + srx·sry·crz
  // R[1][1] = crx·crz - srx·sry·srz
  const a = cry * crz;
  const c = -cry * srz;
  const b = crx * srz + srx * sry * crz;
  const d = crx * crz - srx * sry * srz;
  return [a, b, c, d];
}

/* ---------- font resolution ---------- */

const BUILT_IN_FONT_MAP: Record<string, string> = {
  __system_sans: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  __system_serif: 'Georgia, Times New Roman, Times, serif',
  __system_mono: 'SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace',
};

function resolveFontFamily(
  stored: string,
  customFonts: CustomFont[],
): { family: string; customFont: CustomFont | null } {
  if (!stored) {
    return {
      family: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      customFont: null,
    };
  }
  if (BUILT_IN_FONT_MAP[stored]) {
    return { family: BUILT_IN_FONT_MAP[stored], customFont: null };
  }
  const f = customFonts.find((x) => x.id === stored);
  if (f) return { family: `'${f.family}', sans-serif`, customFont: f };
  return {
    family: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    customFont: null,
  };
}

/** Fetch a blob: URL and convert to a base64 data URL for @font-face embedding. */
async function blobToDataUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}

/* ---------- XML helpers ---------- */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textAnchorForAlign(align: Align): string {
  return align === 'Left' ? 'start' : align === 'Right' ? 'end' : 'middle';
}

/* ---------- CSS → SVG transform conversion ---------- */

/**
 * Convert a CSS computed transform string (e.g. "matrix(0.8, 0, 0, 0.8, 0, 0)")
 * to an SVG transform string (e.g. "matrix(0.8 0 0 0.8 0 0)").
 * Returns '' for "none" or unrecognised input.
 */
function cssTransformToSvg(css: string): string {
  if (!css || css === 'none') return '';
  // CSS 2D matrix: matrix(a, b, c, d, e, f) → SVG: matrix(a b c d e f)
  const m = css.match(/matrix\(([^)]+)\)/);
  if (m) {
    const v = m[1].split(',').map((s) => s.trim());
    return `matrix(${v.join(' ')})`;
  }
  // CSS 3D matrix3d: extract 2D affine part
  const m3 = css.match(/matrix3d\(([^)]+)\)/);
  if (m3) {
    const v = m3[1].split(',').map((s) => s.trim());
    if (v.length >= 14) {
      return `matrix(${v[0]} ${v[1]} ${v[4]} ${v[5]} ${v[12]} ${v[13]})`;
    }
  }
  return '';
}

/* ---------- animation CSS ---------- */

const ANIM_CSS: Record<string, string> = {
  expand: `
@keyframes svg-expand{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
.anim-svg-expand{animation:svg-expand 1.6s ease-out infinite;transform-box:fill-box;transform-origin:center}`,
  contract: `
@keyframes svg-contract{from{opacity:0;transform:scale(1.2)}to{opacity:1;transform:scale(1)}}
.anim-svg-contract{animation:svg-contract 1.6s ease-out infinite;transform-box:fill-box;transform-origin:center}`,
  pulse: `
@keyframes svg-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.anim-svg-pulse{animation:svg-pulse 2.2s ease-in-out infinite}`,
  sway: `
@keyframes svg-sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
.anim-svg-sway{animation:svg-sway 3s ease-in-out infinite;transform-box:fill-box;transform-origin:center}`,
  float: `
@keyframes svg-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.anim-svg-float{animation:svg-float 3.2s ease-in-out infinite;transform-box:fill-box;transform-origin:center}`,
  shake: `
@keyframes svg-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.anim-svg-shake{animation:svg-shake .7s ease-in-out infinite;transform-box:fill-box;transform-origin:center}`,
};

/* ---------- SVG generation ---------- */

export async function generateSvg(config: SvgExportConfig): Promise<string> {
  const { layers, canvasSize, background, cameraRig, orbitCenterPx, customFonts, frozenAnimations } = config;
  const W = canvasSize.width;
  const H = canvasSize.height;
  const bg = BACKGROUND_COLORS[background];

  /* ---- Embed custom fonts ---- */
  const usedFontIds = new Set<string>();
  for (const layer of layers) {
    if (layer.fontFamily) usedFontIds.add(layer.fontFamily);
  }
  let fontFaces = '';
  for (const font of customFonts) {
    if (!usedFontIds.has(font.id)) continue;
    const dataUrl = await blobToDataUrl(font.url);
    if (dataUrl) {
      fontFaces += `@font-face{font-family:'${escapeXml(font.family)}';src:url('${dataUrl}')format('${font.format}');}`;
    }
  }

  /* ---- Camera transform (affine approximation) ---- */
  const [ca, cb, cc, cd] = rotation2DAffine(
    cameraRig.orbitX,
    cameraRig.orbitY,
    cameraRig.orbitZ,
  );
  const dolly = cameraRig.dolly;
  const { x: ocx, y: ocy } = orbitCenterPx;
  // Camera: translate to orbit center → apply rotation+dolly+pan → translate back
  const camTransform =
    `translate(${ocx} ${ocy}) ` +
    `matrix(${ca * dolly} ${cb * dolly} ${cc * dolly} ${cd * dolly} ${cameraRig.panX} ${cameraRig.panY}) ` +
    `translate(${-ocx} ${-ocy})`;

  /* ---- Build layer elements ---- */
  const layerSvgs: string[] = [];
  const usedAnims = new Set<string>();
  const hasFrozen = !!frozenAnimations;

  // Check if camera is at rest (no transform needed)
  const camAtRest =
    cameraRig.orbitX === 0 &&
    cameraRig.orbitY === 0 &&
    cameraRig.orbitZ === 0 &&
    cameraRig.dolly === 1 &&
    cameraRig.panX === 0 &&
    cameraRig.panY === 0 &&
    cameraRig.z === 0;

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    // --- SVG layer (imported SVG) ---
    if (layer.svgContent) {
      const scale = layer.svgScale ?? 1;
      const sw = (layer.svgWidth ?? 200) * scale;
      const sh = (layer.svgHeight ?? 200) * scale;
      const cx = W / 2 + layer.horizontalOffset;
      const cy = H / 2 + layer.verticalOffset;
      const [la, lb, lc, ld] = rotation2DAffine(
        layer.transform.rotateX,
        layer.transform.rotateY,
        layer.transform.rotateZ,
      );
      const hasRot = la !== 1 || lb !== 0 || lc !== 0 || ld !== 1;
      // Keep the <svg> tag intact — preserve viewBox & namespaces.
      // Use nested <svg> with x/y for positioning, width/height for scaling.
      // Strip only the XML declaration.
      let svgStr = layer.svgContent
        .replace(/<\?xml[^>]*\?>/g, '')
        .trim();
      // Replace width/height in the opening <svg> tag with scaled values
      svgStr = svgStr
        .replace(/(<svg[^>]*?)\swidth=["'][^"']*["']/i, `$1 width="${sw}"`)
        .replace(/(<svg[^>]*?)\sheight=["'][^"']*["']/i, `$1 height="${sh}"`);
      // Add x/y attributes to position the nested SVG (top-left corner)
      const offsetX = cx - sw / 2;
      const offsetY = cy - sh / 2;
      if (hasRot) {
        // With rotation: wrap in <g> with transform
        const xf = `translate(${cx} ${cy}) matrix(${la} ${lb} ${lc} ${ld} 0 0) translate(${-sw / 2} ${-sh / 2})`;
        layerSvgs.push(`<g transform="${xf}">${svgStr}</g>`);
      } else {
        // No rotation: use nested <svg> with x/y for crisp vector positioning
        svgStr = svgStr.replace(
          /<svg/,
          `<svg x="${offsetX}" y="${offsetY}"`,
        );
        layerSvgs.push(svgStr);
      }
      continue;
    }

    // --- Text layer ---
    const { family, customFont } = resolveFontFamily(layer.fontFamily, customFonts);
    _void(customFont); // customFont already embedded via @font-face above
    const anchor = textAnchorForAlign(layer.align);
    const weight = FONT_WEIGHT_MAP[layer.fontWeight];
    const lines = layer.text.split('\n');
    const lineHeightPx = layer.fontSize * layer.lineHeight;

    // Per-layer 3D rotation → 2D affine
    const [la, lb, lc, ld] = rotation2DAffine(
      layer.transform.rotateX,
      layer.transform.rotateY,
      layer.transform.rotateZ,
    );
    const layerMatrix = `matrix(${la} ${lb} ${lc} ${ld} 0 0)`;

    // Animation: use frozen state if available, otherwise CSS animation class
    let animCls = '';
    let frozenTransform = '';
    let frozenOpacity = '';
    if (hasFrozen && frozenAnimations![layerIdx]) {
      const f = frozenAnimations![layerIdx];
      frozenTransform = cssTransformToSvg(f.transform);
      frozenOpacity = f.opacity;
    } else if (layer.animation !== 'none') {
      animCls = `anim-svg-${layer.animation}`;
      usedAnims.add(layer.animation);
    }

    // Position: text baseline of first line
    const cx = W / 2 + layer.horizontalOffset;
    const topY = H / 2 + layer.verticalOffset;
    const firstBaseline = topY + layer.fontSize * 0.85; // approximate ascender

    // Build <tspan> for each line
    const tspans = lines
      .map((line, i) => {
        const dy = i === 0 ? 0 : lineHeightPx;
        const text = line.length === 0 ? '\u200B' : line;
        return `<tspan x="${cx}" dy="${dy}">${escapeXml(text)}</tspan>`;
      })
      .join('');

    const animStyle = animCls ? ` class="${animCls}"` : '';
    const opacityAttr = frozenOpacity && frozenOpacity !== '1' ? ` opacity="${frozenOpacity}"` : '';

    // Wrap with frozen animation transform if present
    let openTag = `<g transform="${layerMatrix}"${animStyle}${opacityAttr}>`;
    let closeTag = `</g>`;
    if (frozenTransform) {
      openTag = `<g transform="${frozenTransform}"${opacityAttr}><g transform="${layerMatrix}"${animStyle}>`;
      closeTag = `</g></g>`;
    }

    layerSvgs.push(
      openTag +
        `<text x="${cx}" y="${firstBaseline}" text-anchor="${anchor}" ` +
        `font-family="${escapeXml(family)}" font-size="${layer.fontSize}" ` +
        `font-weight="${weight}" fill="${layer.color}" ` +
        `letter-spacing="${layer.letterSpacing}px">` +
        `${tspans}</text>` +
        closeTag,
    );
  }

  /* ---- Collect animation styles ---- */
  let animStyles = '';
  for (const anim of usedAnims) {
    if (ANIM_CSS[anim]) animStyles += ANIM_CSS[anim];
  }

  /* ---- Assemble SVG ---- */
  const layerContent = layerSvgs.map((s) => `  ${s}`).join('\n');
  const innerSvg = camAtRest
    ? layerContent
    : `<g transform="${camTransform}">\n${layerContent}\n</g>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${fontFaces}${animStyles}</style>
<rect width="${W}" height="${H}" fill="${bg}"/>
${innerSvg}
</svg>`;

  return svg;
}

/* ---------- download helper ---------- */

export function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// silence unused var
function _void(_: unknown): void { _; }
