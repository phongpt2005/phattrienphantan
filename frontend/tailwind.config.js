/** @type {import('tailwindcss').Config} */
// Màu lấy từ biến CSS (src/index.css) để có chế độ sáng và tối như mẫu Shadcn Admin.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (name, shades) => Object.fromEntries(shades.map((s) => [s, v(`${name}-${s}`)]));
const TINT = [50, 100, 200, 300, 400, 500, 600, 700, 800];

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '"Segoe UI"', 'Roboto', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'SFMono-Regular', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
      fontSize: {
        micro: ['0.75rem', { lineHeight: '1rem' }],
        data: ['0.8125rem', { lineHeight: '1.25rem' }],
      },
      colors: {
        card: v('card'),
        sidebar: v('sidebar'),
        slate: scale('slate', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        brand: scale('brand', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        emerald: scale('emerald', TINT),
        amber: scale('amber', TINT),
        red: scale('red', TINT),
        blue: scale('blue', TINT),
      },
      boxShadow: {
        drawer: '-8px 0 32px -12px rgb(0 0 0 / 0.25)',
        menu: '0 12px 32px -8px rgb(0 0 0 / 0.25), 0 2px 6px -2px rgb(0 0 0 / 0.08)',
      },
    },
  },
  plugins: [],
};
