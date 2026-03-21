import { RedirectToSignUp } from "@clerk/nextjs";

export const metadata = { title: "Sign Up - Relevis" };

export default function Signup() {
  return <RedirectToSignUp />;
}
