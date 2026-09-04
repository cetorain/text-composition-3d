/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // CSS variable-based — switches automatically with data-theme
        'bg-deep': 'var(--color-bg-deep)',
        'bg-panel': 'var(--color-bg-panel)',
        'bg-card': 'var(--color-bg-card)',
        'bg-card-hover': 'var(--color-bg-card-hover)',
        'bg-input': 'var(--color-bg-input)',
        'border-soft': 'var(--color-border-soft)',
        'border-medium': 'var(--color-border-medium)',
        'border-strong': 'var(--color-border-strong)',
        'fg-bright': 'var(--color-fg-bright)',
        'fg-muted': 'var(--color-fg-muted)',
        'fg-dim': 'var(--color-fg-dim)',
        'accent-blue': 'var(--color-accent-blue)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"SF Pro Display"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        'macos': '8px',
        'macos-lg': '12px',
      },
      boxShadow: {
        'macos': '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)',
        'macos-lg': '0 4px 12px rgba(0,0,0,0.35)',
      },
    },
  },
  plugins: [],
}
