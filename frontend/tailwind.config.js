/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '"Segoe UI"', 'Roboto', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'SFMono-Regular', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
      fontSize: {
        // Thang chữ của hệ thống: nhãn 11px, dữ liệu trong bảng 13px
        micro: ['0.6875rem', { lineHeight: '1rem' }],
        data: ['0.8125rem', { lineHeight: '1.25rem' }],
      },
      colors: {
        // Xanh navy doanh nghiệp (AGENTS.md: #0064e0, #075985, #0f172a)
        brand: {
          50: '#eef5ff',
          100: '#d9e8ff',
          200: '#b3d1ff',
          300: '#7fb2ff',
          400: '#4c94f5',
          500: '#0064e0',
          600: '#0052b8',
          700: '#075985',
          800: '#0c4a6e',
          900: '#082f49',
        },
      },
      boxShadow: {
        drawer: '-8px 0 32px -12px rgba(15, 23, 42, 0.22)',
        menu: '0 12px 32px -8px rgba(15, 23, 42, 0.22), 0 2px 6px -2px rgba(15, 23, 42, 0.08)',
      },
    },
  },
  plugins: [],
};
