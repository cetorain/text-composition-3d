export type FontWeight = 'Normal' | 'Medium' | 'Bold';

export type Align = 'Left' | 'Center' | 'Right';

export type CanvasSize = {
  id: string;
  label: string;
  width: number;
  height: number;
};

export type BackgroundColor = 'Black' | 'Dark Gray' | 'White';

export type BackgroundFit = 'Cover' | 'Contain' | 'Fill' | 'Tile' | 'Center';

export type AnimationType =
  | 'none'
  | 'expand'
  | 'contract'
  | 'pulse'
  | 'sway'
  | 'float'
  | 'shake';

export interface TextTransform3D {
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  perspective: number;
}

export interface CustomFont {
  id: string;
  family: string; // CSS font-family name (unique)
  sourceName: string; // original file name
  url: string; // blob: URL
  format: string; // woff2 / woff / otf / ttf
}

export interface BackgroundImage {
  id: string;
  sourceName: string; // original file name
  url: string; // blob: URL
  width: number; // natural width px
  height: number; // natural height px
}

export interface BackgroundImageSettings {
  image: BackgroundImage | null;
  opacity: number; // 0..1
  fit: BackgroundFit;
}

export interface TextLayer {
  id: string;
  name: string;
  text: string;
  fontFamily: string; // CSS font-family value. '' = default stack.
  fontSize: number;
  fontWeight: FontWeight;
  color: string; // hex, grayscale only
  align: Align;
  letterSpacing: number; // CSS letter-spacing in px (e.g. -2..40)
  lineHeight: number; // CSS line-height, unitless multiplier (e.g. 0.9..3)
  verticalOffset: number; // pixels within canvas
  horizontalOffset: number;
  transform: TextTransform3D;
  animation: AnimationType;
  animationKey: number; // bumps to restart animation if re-clicked
}

export const CANVAS_PRESETS: CanvasSize[] = [
  { id: 'portrait', label: 'Portrait 70×100', width: 700, height: 1000 },
  { id: 'square', label: 'Square 1:1', width: 1000, height: 1000 },
  { id: 'landscape', label: 'Landscape 10:7', width: 1000, height: 700 },
];

export const BACKGROUND_COLORS: Record<BackgroundColor, string> = {
  Black: '#0a0a0a',
  'Dark Gray': '#1a1a1a',
  White: '#ffffff',
};

export const GRAYSCALE_COLORS = [
  '#ffffff',
  '#e5e5e5',
  '#bbbbbb',
  '#8a8a8a',
  '#555555',
  '#2a2a2a',
  '#0a0a0a',
];

export const FONT_WEIGHT_MAP: Record<FontWeight, number> = {
  Normal: 400,
  Medium: 500,
  Bold: 700,
};

export const ALIGN_MAP: Record<Align, string> = {
  Left: 'left',
  Center: 'center',
  Right: 'right',
};

export const DEFAULT_FONT_FAMILY = ''; // empty = system default (Inter + stack)

export const DEFAULT_LETTER_SPACING = 0; // px
export const DEFAULT_LINE_HEIGHT = 1.15; // unitless multiplier

export function createInitialLayers(): TextLayer[] {
  return [
    {
      id: genId(),
      name: 'Headline',
      text: 'ejnav\n/\n[09.26]\nsearching the present',
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: 120,
      fontWeight: 'Bold',
      color: '#ffffff',
      align: 'Left',
      letterSpacing: DEFAULT_LETTER_SPACING,
      lineHeight: DEFAULT_LINE_HEIGHT,
      verticalOffset: -500,
      horizontalOffset: 0,
      transform: {
        rotateX: 18,
        rotateY: -22,
        rotateZ: 0,
        perspective: 800,
      },
      animation: 'none',
      animationKey: 0,
    },
    {
      id: genId(),
      name: 'Caption',
      text: 'DESIGN TOOL · V1.0\nSTUDIO EDIT 2026',
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: 18,
      fontWeight: 'Normal',
      color: '#bbbbbb',
      align: 'Center',
      letterSpacing: 2,
      lineHeight: 1.4,
      verticalOffset: 340,
      horizontalOffset: 0,
      transform: {
        rotateX: 8,
        rotateY: 12,
        rotateZ: 0,
        perspective: 700,
      },
      animation: 'none',
      animationKey: 0,
    },
    {
      id: genId(),
      name: 'Footer',
      text: 'all right reserve @ ejnav',
      fontFamily: DEFAULT_FONT_FAMILY,
      fontSize: 14,
      fontWeight: 'Normal',
      color: '#8a8a8a',
      align: 'Left',
      letterSpacing: 1,
      lineHeight: DEFAULT_LINE_HEIGHT,
      verticalOffset: 460,
      horizontalOffset: 0,
      transform: {
        rotateX: 0,
        rotateY: 0,
        rotateZ: 0,
        perspective: 800,
      },
      animation: 'none',
      animationKey: 0,
    },
  ];
}

export function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}
