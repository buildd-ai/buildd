import type { Metadata } from 'next';
import { Outfit, Schibsted_Grotesk, JetBrains_Mono, Newsreader, Fraunces } from 'next/font/google';
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
