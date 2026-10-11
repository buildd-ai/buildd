import type { Metadata } from 'next';
import localFont from 'next/font/local';
import ThemeProvider from '@/components/ThemeProvider';
import './globals.css';

// Self-hosted (OFL, see fonts/LICENSE-OFL.txt): a production build never has to
// reach Google Fonts. Latin subset, variable weight axis.
const outfit = localFont({
  src: './fonts/outfit-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-outfit',
  display: 'swap',
});

// UI and titles (design-system.md §2.7).
const schibsted = localFont({
  src: './fonts/schibsted-grotesk-latin-wght-normal.woff2',
  weight: '400 900',
  variable: '--font-schibsted',
  display: 'swap',
});

// Counts, IDs and lifecycle.
const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// The chat's voice (knowledge-base: buildd/design/chat-canvas.md): what Buildd and the person say, in a serif.
const newsreader = localFont({
  src: [
    { path: './fonts/newsreader-latin-wght-normal.woff2', weight: '200 800', style: 'normal' },
    { path: './fonts/newsreader-latin-wght-italic.woff2', weight: '200 800', style: 'italic' },
  ],
  variable: '--font-newsreader',
  display: 'swap',
});

const fraunces = localFont({
  src: './fonts/fraunces-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-fraunces',
  display: 'swap',
});

export const metadata: Metadata = {
  title: "buildd: Agents say they're done. buildd checks.",
  description: "Agents say they're done. buildd checks.",
};

const themeScript = `(function(){try{var t=localStorage.getItem('buildd-theme')||'dark';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${outfit.variable} ${schibsted.variable} ${jetbrainsMono.variable} ${newsreader.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
