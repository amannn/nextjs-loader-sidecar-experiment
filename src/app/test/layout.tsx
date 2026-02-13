export default function TestLayout({children}: LayoutProps<'/test'>) {
  return (
    <div>
      <h1>Test Layout</h1>
      {children}
    </div>
  );
}
