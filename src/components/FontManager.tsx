import { useCallback, useRef } from 'react';
import type { CustomFont } from '../types';

interface FontManagerProps {
  fonts: CustomFont[];
  onAdd: (font: CustomFont) => void;
  onRemove: (id: string) => void;
}

const SUPPORTED = /\.(woff2|woff|otf|ttf|ttc)$/i;
const FORMAT_OF: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  otf: 'opentype',
  ttf: 'truetype',
  ttc: 'truetype',
};

function extOf(name: string): string {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function safeFamilyName(name: string, idx: number): string {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return `local__${base || 'font'}_${idx}`;
}

/**
 * Registers a <style> block that emits a single @font-face per custom font.
 * Using a style block (rather than FontFace API) keeps html-to-image export
 * aware of the font rules when rasterising the poster DOM.
 */
export function FontFaceStyle({ fonts }: { fonts: CustomFont[] }) {
  const css = fonts
    .map(
      (f) =>
        `@font-face { font-family: '${f.family}'; src: url('${f.url}') format('${f.format}'); font-display: swap; }`,
    )
    .join('\n');
  return <style data-font-face-manager>{css}</style>;
}

export function FontManager({ fonts, onAdd, onRemove }: FontManagerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList).filter((f) => SUPPORTED.test(f.name));
      if (files.length === 0) {
        alert('Unsupported font files. Pick .woff2 / .woff / .otf / .ttf / .ttc');
        return;
      }
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = extOf(file.name);
        const format = FORMAT_OF[ext] ?? 'truetype';
        const url = URL.createObjectURL(file);
        const id = Math.random().toString(36).slice(2, 10);
        const family = safeFamilyName(file.name, fonts.length + i);
        onAdd({ id, family, sourceName: file.name, url, format });
      }
      if (inputRef.current) inputRef.current.value = '';
    },
    [fonts.length, onAdd],
  );

  return (
    <div>
      <div className="field-label">
        <span>Local Fonts · {fonts.length}</span>
        <span className="field-value">.woff2 .woff .otf .ttf</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".woff2,.woff,.otf,.ttf,.ttc,font/woff2,font/woff,font/otf,font/ttf"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="mb-2 flex gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="btn h-8 flex-1"
        >
          + Upload Font Files
        </button>
      </div>
      {fonts.length > 0 && (
        <ul className="space-y-1">
          {fonts.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between rounded-macos border border-border-soft bg-bg-input px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[12px] text-fg-bright"
                  style={{ fontFamily: `'${f.family}', sans-serif` }}
                >
                  Aa  {f.sourceName}
                </div>
                <div className="truncate font-mono text-[10px] text-fg-muted">
                  {f.family}
                </div>
              </div>
              <button
                type="button"
                title="Remove font"
                onClick={() => onRemove(f.id)}
                className="ml-2 flex h-6 w-6 items-center justify-center rounded-macos text-[11px] text-fg-muted hover:bg-bg-card-hover hover:text-fg-bright"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
