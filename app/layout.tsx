import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Auto-Explainer · v0.0.1 alpha',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}