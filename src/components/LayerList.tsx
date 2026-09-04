import React, { useRef } from 'react';
import type { TextLayer } from '../types';

interface LayerListProps {
  layers: TextLayer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onImportSvg: (file: File) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

export const LayerList: React.FC<LayerListProps> = ({
  layers,
  selectedId,
  onSelect,
  onAdd,
  onImportSvg,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  onRename,
}) => {
  const svgInputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="macos-card p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className="section-title !mb-0 flex-1">Layers · {layers.length}</h3>
        <input
          ref={svgInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            files.forEach((f) => onImportSvg(f));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => svgInputRef.current?.click()}
          className="btn h-7 px-2.5 text-[10px]"
          title="Import SVG file as a new layer"
        >
          ↑ SVG
        </button>
        <button type="button" onClick={onAdd} className="btn h-7 px-2.5 text-[10px]">
          + Layer
        </button>
      </div>

      <div className="space-y-1.5">
        {layers.map((layer, orderIndex) => {
          const isSelected = layer.id === selectedId;
          return (
            <div
              key={layer.id}
              className={[
                'group rounded-macos border transition-colors',
                isSelected
                  ? 'border-accent-blue bg-bg-card-hover'
                  : 'border-border-soft bg-bg-input hover:border-border-medium',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => onSelect(layer.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title="Select layer"
                >
                  <span className="chip !h-5 !py-0 !text-[9px]">
                    {orderIndex + 1}
                  </span>
                  {!!layer.svgContent && (
                    <span
                      className="shrink-0 rounded-macos border border-border-medium bg-bg-card px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-fg-muted"
                      title="SVG layer"
                    >
                      svg
                    </span>
                  )}
                  <input
                    value={layer.name}
                    onChange={(e) => onRename(layer.id, e.target.value)}
                    onFocus={() => onSelect(layer.id)}
                    className="w-full min-w-0 truncate border-none bg-transparent text-[12px] text-fg-dim outline-none focus:text-fg-bright"
                  />
                </button>

                <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                  <IconBtn
                    title="Move up"
                    onClick={() => onMoveUp(layer.id)}
                    disabled={orderIndex === layers.length - 1}
                  >
                    ▲
                  </IconBtn>
                  <IconBtn
                    title="Move down"
                    onClick={() => onMoveDown(layer.id)}
                    disabled={orderIndex === 0}
                  >
                    ▼
                  </IconBtn>
                  <IconBtn title="Duplicate" onClick={() => onDuplicate(layer.id)}>
                    ⎘
                  </IconBtn>
                  <IconBtn
                    title="Delete"
                    onClick={() => onDelete(layer.id)}
                    disabled={layers.length === 1}
                  >
                    ✕
                  </IconBtn>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const IconBtn: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}> = ({ onClick, disabled, title, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    disabled={disabled}
    className="flex h-6 w-6 items-center justify-center rounded-macos text-[11px] text-fg-muted transition-colors hover:bg-bg-card-hover hover:text-fg-bright disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
  >
    {children}
  </button>
);
