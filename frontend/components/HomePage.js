"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { MdAdd, MdSearch } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import "@material/web/textfield/outlined-text-field.js";

function HomePage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [eventCode, setEventCode] = useState("");

  const handleOrganize = () => {
    if (user) {
      router.push("/create");
    } else {
      router.push("/sign-in");
    }
  };

  const handleJoin = () => {
    const code = eventCode.trim();
    if (code) router.push(`/event?code=${code}`);
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}>
        <p style={{ color: "var(--md-sys-color-on-surface-variant)" }}>Loading...</p>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      padding: "24px",
      boxSizing: "border-box",
      gap: "32px",
    }}>
      {/* Logo + brand */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
        <Image src="/img/i2glogo.png" alt="i2G Logo" width={64} height={64} />
        <h1 style={{
          color: "var(--md-sys-color-primary)",
          margin: 0,
          fontSize: "2.5rem",
          fontWeight: 700,
        }}>
          Releviz
        </h1>
        <p style={{
          color: "var(--md-sys-color-on-surface-variant)",
          margin: 0,
          fontSize: "1rem",
          textAlign: "center",
          maxWidth: "400px",
        }}>
          Intelligent group scheduling — find the best time for everyone.
        </p>
      </div>

      {/* CTAs */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        width: "100%",
        maxWidth: "360px",
        alignItems: "center",
      }}>
        <AppButton onClick={handleOrganize} fullWidth icon={<MdAdd />}>
          Organize an Event
        </AppButton>

        <p style={{
          color: "var(--md-sys-color-on-surface-variant)",
          margin: 0,
          fontSize: "0.9rem",
        }}>
          or
        </p>

        <div style={{ display: "flex", gap: "8px", width: "100%" }}>
          <md-outlined-text-field
            label="Enter Event Code"
            value={eventCode}
            onInput={(e) => setEventCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            style={{ flex: 1 }}
          ></md-outlined-text-field>
          <AppButton onClick={handleJoin} icon={<MdSearch />}>
            Go
          </AppButton>
        </div>

        {user && (
          <p style={{
            textAlign: "center",
            fontSize: "0.85rem",
            color: "var(--md-sys-color-on-surface-variant)",
            margin: 0,
          }}>
            <a href="/dashboard" style={{ color: "var(--md-sys-color-primary)" }}>
              View my dashboard →
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

export default HomePage;