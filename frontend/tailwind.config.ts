import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#0f62ff',
          'primary-d': '#0043ce',
          'primary-l': '#dbeaff',
        },
        ink: {
          1: '#1a1a1a',
          2: '#525252',
          3: '#8c8c8c',
          border: '#e0e0e0',
          bg: '#f4f4f4',
        },
        env: {
          dev: '#6a1b9a',
          test: '#1565c0',
          staging: '#e65100',
          production: '#2e7d32',
        },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', '"Source Han Sans SC"', 'system-ui'],
        mono: ['"JetBrains Mono"', '"Source Han Mono"', '"Courier New"'],
      },
      boxShadow: {
        card: '0 1px 4px rgba(0, 0, 0, 0.08)',
        menu: '0 4px 12px rgba(0, 0, 0, 0.15)',
      },
    },
  },
  plugins: [],
} satisfies Config
