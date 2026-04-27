import { SignUp } from "@clerk/nextjs";

export const metadata = { title: "Sign Up - Releviz" };

export default function SignUpPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <SignUp />
    </div>
  );
}
