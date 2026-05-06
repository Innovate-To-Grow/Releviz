import { RedirectToSignUp } from "@clerk/nextjs";

export const metadata = { title: "Sign Up - Releviz" };

export default function Signup() {
  return <RedirectToSignUp />;
}
