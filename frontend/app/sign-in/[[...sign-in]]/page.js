import { SignIn } from "@clerk/nextjs";

export const metadata = { title: "Sign In - Releviz" };

export default function SignInPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <SignIn />
    </div>
  );
}
