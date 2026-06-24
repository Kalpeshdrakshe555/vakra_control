/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/webview/**/*.{html,ts,js}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      colors: {
        cyber: {
          bg: '#1C1C1E',
          panel: '#2C2C2E',
          border: '#3A3A3C',
          neonCyan: '#0A84FF',
          neonPink: '#FF453A',
          neonPurple: '#BF5AF2',
        }
      }
    }
  },
  plugins: [],
}