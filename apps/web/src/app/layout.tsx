import type { Metadata } from 'next';
import { Outfit, IBM_Plex_Mono, IBM_Plex_Sans, Newsreader, Fraunces } from 'next/font/google';
import ThemeProvider from '@/components/ThemeProvider';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

// Conversation prose in chat (the canvas): the same family as the Mono voice, friendlier to read.
const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

// The chat's voice (docs/design/chat-canvas.md): what Buildd and the person say, in a serif.
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
  title: 'buildd - AI Dev Team Orchestration',
  description: 'Distributed task broker for Claude agents',
};

const themeScript = `(function(){try{var t=localStorage.getItem('buildd-theme')||'dark';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${outfit.variable} ${ibmPlexMono.variable} ${ibmPlexSans.variable} ${newsreader.variable} ${fraunces.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
