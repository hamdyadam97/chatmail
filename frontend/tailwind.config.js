/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"IBM Plex Sans Arabic"',
          '"Segoe UI"',
          'Tahoma',
          '"Noto Sans Arabic"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      // هوية المؤسسة (نفس تطبيق الموبايل، 2026-11-26): كحلي الشعار، ذهبي
      // «الختم»، ورمادي دافئ بلون الورق بدل الرمادي البارد في كل الواجهة.
      colors: {
        primary: {
          50: '#f1f0f8',
          100: '#e3e1f1',
          200: '#c8c5e3',
          300: '#a4a0cf',
          400: '#7b76b5',
          500: '#57529a',
          600: '#3e3a80',
          700: '#28255f',
          800: '#201e4d',
          900: '#18163a',
        },
        gray: {
          50: '#f7f5f0',
          100: '#efece4',
          200: '#e3ded3',
          300: '#cfc8ba',
          400: '#a39c8e',
          500: '#78715f',
          600: '#5e584d',
          700: '#48433a',
          800: '#2f2c26',
          900: '#1e1c18',
        },
        gold: {
          50: '#fbf4e4',
          100: '#f6e7c4',
          400: '#d9ae52',
          500: '#cb962b',
          700: '#8a5a12',
        },
      },
      borderRadius: {
        md: '0.5rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
      },
    },
  },
  plugins: [],
};
