import { UserProfile } from "@clerk/nextjs";

export const metadata = { title: "Settings - Releviz" };

export default function Settings() {
  return (
    <div
      className="page-pad"
      style={{ minHeight: "100vh", display: "flex", justifyContent: "center", paddingTop: "32px" }}
    >
      <UserProfile />
    </div>
  );
}
