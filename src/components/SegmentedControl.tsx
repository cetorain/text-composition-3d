interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div className="inline-flex w-full overflow-hidden rounded-macos border border-border-soft bg-bg-input p-0.5">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={[
              'flex-1 rounded-[6px] px-2 py-1.5 text-[11px] font-medium tracking-wide transition-all',
              active
                ? 'bg-bg-card text-fg-bright shadow-sm'
                : 'text-fg-muted hover:bg-bg-card hover:text-fg-dim',
            ].join(' ')}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
