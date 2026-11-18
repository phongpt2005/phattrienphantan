/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Inter"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'Consolas',
          '"Liberation Mono"',
          'Menlo',
          'monospace',
        ],
      },
      colors: {
        brand: {
          50: '#f0f7ff',
          100: '#e0effe',
          200: '#bae0fd',
          500: '#0064e0',
          600: '#0052b8',
          700: '#075985',
          800: '#0c4a6e',
          900: '#082f49',
        },
        astryx: {
          canvas: '#f8fafc',
          card: '#ffffff',
          subtle: '#f1f5f9',
          border: '#e2e8f0',
          strong: '#cbd5e1',
          primary: '#0f172a',
          secondary: '#475569',
          muted: '#64748b',
          blue: '#0064e0',
          blueHover: '#0052b8',
          blueLight: '#edf5ff',
        }
      },
      boxShadow: {
        'astryx-xs': '0 1px 2px 0 rgba(15, 23, 42, 0.04)',
        'astryx-card': '0 1px 3px 0 rgba(15, 23, 42, 0.06), 0 1px 2px 0 rgba(15, 23, 42, 0.04)',
        'astryx-drawer': '-4px 0 24px 0 rgba(15, 23, 42, 0.08)',
      }
    },
  },
  plugins: [],
}
