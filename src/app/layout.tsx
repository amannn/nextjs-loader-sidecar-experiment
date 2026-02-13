import Link from 'next/link';

export default function RootLayout({children}: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/test">Test</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
