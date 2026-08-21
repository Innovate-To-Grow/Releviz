import AppHeader from "@/components/ui/AppHeader";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Feedback";

export default function NotFound() {
  return (
    <>
      <AppHeader />
      <main id="main" className="rv-page rv-page--form rv-page--centered">
        <EmptyState
          icon="search"
          headingLevel={1}
          title="Page not found"
          description="The page may have moved, or the link may no longer be available."
          action={
            <ButtonLink href="/" variant="primary" icon="arrowRight">
              Go home
            </ButtonLink>
          }
        />
      </main>
    </>
  );
}
