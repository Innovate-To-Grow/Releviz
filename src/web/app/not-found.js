import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";

export default function NotFound() {
  return (
    <>
      <AppHeader />
      <main className="status-page">
        <span className="status-page-code">404</span>
        <h1>Page not found</h1>
        <p>The page may have moved, or the link may no longer be available.</p>
        <Link className="app-btn app-btn-filled" href="/">
          Go home
        </Link>
      </main>
    </>
  );
}
