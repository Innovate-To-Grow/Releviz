import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";
import { ArrowRightIcon } from "@/components/ui/icons";

export default function NotFound() {
  return (
    <>
      <AppHeader />
      <main className="status-page">
        <span className="status-page-code">404</span>
        <h1>Page not found</h1>
        <p>The page may have moved, or the link may no longer be available.</p>
        <div className="status-page__actions">
          <Link className="btn btn-primary app-btn" href="/">
            <span className="app-btn-label">Go home</span>
            <span className="app-btn-icon" aria-hidden="true">
              <ArrowRightIcon />
            </span>
          </Link>
        </div>
      </main>
    </>
  );
}
