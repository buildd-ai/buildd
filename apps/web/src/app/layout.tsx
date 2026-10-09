import type { Metadata } from 'next';
import { Outfit, Schibsted_Grotesk, JetBrains_Mono, IBM_Plex_Mono, IBM_Plex_Sans, Newsreader, Fraunces } from 'next/font/google';
import ThemeProvider from '@/components/ThemeProvider';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

// UI and titles (design-system.md §2.7).
const schibsted = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-schibsted',
  display: 'swap',
});

// Counts, IDs and lifecycle.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// Retiring: only chat still reads the two Plex faces (--kit-font-mono, .font-convo).
// Drop both when chat moves onto the app's type.
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  variable: '--font-plex-sans',
  display: 'swap',
});

// The chat's voice (knowledge-base: buildd/design/chat-canvas.md): what Buildd and the person say, in a serif.
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
  display: 'swap',
});

const fraunces = Fraunces({
  subsets: ['latin'],
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
    <html lang="en" className={`${outfit.variable} ${schibsted.variable} ${jetbrainsMono.variable} ${ibmPlexMono.variable} ${ibmPlexSans.variable} ${newsreader.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
