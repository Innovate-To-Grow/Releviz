import Link from "next/link";

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: "16px",
      }}
    >
      <h1 style={{ fontSize: "3rem", margin: 0 }}>404</h1>
      <p style={{ color: "gray" }}>Page not found</p>
      <Link href="/" style={{ color: "#1a73e8" }}>
        Go home
      </Link>
    </div>
  );
}
